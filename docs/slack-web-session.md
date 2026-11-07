# Slack via the web-session token (no app registration)

Findings from wiring Slack into `dev-dashboard` (Oct 2026), written up for the
future `toolkit-mcp` Slack integration. Everything below was verified against a
live TeamPathwise workspace, not copied from docs.

## Why not OAuth

Slack's public API only accepts tokens minted for a **registered Slack app**
(`xoxb-` bot tokens, `xoxp-` user tokens from an OAuth install). There is no
"sign in as yourself" public flow. If registering an app is off the table, the
only way in is the credential the Slack **web client** already holds:

| Credential | Where it lives | Shape |
| --- | --- | --- |
| user token | `localStorage.localConfig_v2` → `teams.<id>.token` | `xoxc-…` (~110 chars) |
| session cookie `d` | cookie on `.slack.com`, `HttpOnly`, ~1 year | `xoxd-…` (~220 chars) |

Send both: `Authorization: Bearer xoxc-…` **and** `Cookie: d=xoxd-…`. Neither
works alone. The pair carries the full privileges of that browser session —
reading private channels, DMs, and search, which is exactly why it must be
treated as a password.

Trade-off, stated plainly: this is an unsupported surface. Slack can rotate the
token, expire the cookie, or change the localStorage key without notice. Build
everything around "it can vanish at any time" (see *Failure modes*).

## Capturing the credentials

The token cannot be read from a page you do not control (cross-origin
`localStorage`), and the cookie is `HttpOnly` (invisible to `document.cookie`).
So the capture has to happen **inside** a browser that is on the Slack origin,
using automation:

```js
// playwright, persistent profile so sign-in survives reconnects
const context = await chromium.launchPersistentContext(profileDir, { headless: false });
const page = context.pages()[0] ?? await context.newPage();
await page.goto('https://app.slack.com/client');

// localStorage is readable from page context
const team = await page.evaluate(() => {
  const config = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
  return Object.values(config.teams || {}).find((t) => t?.token?.startsWith('xoxc-')) ?? null;
});

// the `d` cookie is HttpOnly — only the browser context can see it
const cookie = (await context.cookies(['https://app.slack.com/']))
  .find((entry) => entry.name === 'd')?.value;
```

Notes from doing this:

- A **persistent profile** is what makes reconnect cheap: after the first sign-in
  the profile remembers the session, so later captures need no human.
- Slack's sign-in flow may stop at an **emailed 6-digit code** (no password).
  Budget for a human in the loop on the first run only.
- If you copy a logged-in Chrome profile directory while the browser is running,
  you can get a corrupt profile. Close it first, or accept a fresh sign-in.
- `chromium.executablePath()` from `@playwright/test` may point at a revision that
  is not downloaded. Fall back to scanning `~/.cache/ms-playwright/chromium-*/`.
- Headless works for capture, but a visible window is the honest UX: the user can
  see what is being authorized.

## Calling the API

Base: `https://app.slack.com/api/<method>` (the web client's own host). `POST`
with query params, or `GET` — both work; the token may go in the header.

```js
const url = new URL(`https://app.slack.com/api/${method}`);
for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, Cookie: `d=${cookie}` },
});
// always { ok: true|false, error?: 'invalid_auth' | ... }
```

Slack returns HTTP 200 with `ok: false` for most API-level failures. Check
`payload.ok`, never `res.ok`.

## Endpoints that mattered, and their quirks

### `auth.test`

Identity without extra scope: `{ ok, user, user_id, team, team_id }`. Cheapest
liveness check; use it to verify a stored session and to learn the user id
(needed to spot mentions and "started by me").

### `conversations.list`

`types=public_channel,private_channel`, cursor-paginated (`response_metadata.next_cursor`).

**Gotcha:** a channel the user is a member of can be absent. A private channel
(`ezat_claudio`) with `is_member: true` never appeared in this list at all, even
paginated. Do not treat "not in list" as "no access" — resolve by search instead:

```js
// fallback: search names the channel and returns its id
const match = (await call('search.messages', { query: `in:${name}`, count: 1 }))
  .messages.matches[0];
channelId = match.channel.id;
```

`conversations.info` does report `is_member`, `is_private` correctly once you have
the id.

### `conversations.history`

`{ channel, limit, cursor }`, `limit` max 200.

**Thread marker:** in this workspace, a message that is a thread **root** comes
back with `thread_ts === ts`; a message with no replies has no `thread_ts` at
all. Do not filter roots with `!m.thread_ts` — that drops every thread (our first
implementation did exactly this and found 0 threads in a channel with 58).

Root messages also carry `reply_count`, `reply_users_count`, `reply_users[]`,
`latest_reply` (epoch string of the newest reply), `subscribed`, `is_locked`.
Plain messages carry none of them.

**Timestamps are epoch strings** (`"1793222863.750299"`): split on `.`, parse the
first part as seconds. Sort numerically, not lexically.

**No permalink** in history — build links yourself:

```
https://app.slack.com/client/<team_id>/<channel_id>/thread/<channel_id>-<ts>
```

That URL works for any workspace the signed-in user belongs to, with no
per-message lookup.

### `conversations.replies`

`{ channel, ts: <thread root ts>, limit: 100 }` returns the root **first** and the
newest message last. This is the only cheap way to learn who spoke last — the
history payload gives you `latest_reply` (a timestamp) but not its author.

Budget one call per thread you display, and cache it keyed by
`<thread ts>:<activity ts>` so a refresh only re-reads threads with new activity.

### `search.messages`

The workhorse. Query syntax that works: `<@U123>` for mentions, `in:<channel>`
to scope, and they combine:

```
in:ezat_claudio <@U0661R66QRF>
```

- `count` max 100, `page` for paging (`page`, **not** cursor).
- `sort=timestamp&sort_dir=desc` is available.
- Returns `messages.total`, `messages.matches[]` with `ts`, `user`, `text`,
  `permalink`, `channel.{id,name}` — and `thread_ts` **only for replies**.
  A top-level match has no `thread_ts`; group on `thread_ts || ts`.
- Matches are deduped per thread by taking the newest `ts` per key; the thread
  root itself may not be in the match set, so resolve it from history or one
  `conversations.replies(ts=key, limit=1)`.
- Search will happily return channels the user is not a member of (it can read
  more than `conversations.history` will). Verified: 599 hits in a private
  channel, while `conversations.list` omitted it.

### `users.list`

Cursor-paginated, `limit` max 200. Display name is
`profile.display_name || real_name || name` — `name` is the handle, which is what
people recognize when the display name is blank. Cache for ~10 minutes; a
channel with a few hundred members costs 1–2 calls.

## Rendering the text

Slack returns its own mrkdwn. For a plain-text UI:

```js
text
  .replace(/<@([^>|]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || names[id] || id}`)
  .replace(/<#([^>|]+)(?:\|([^>]+))?>/g, (_, id, label) => `#${label || id}`)
  .replace(/<!(channel|here|everyone)(?:\|([^>]+))?>/g, (_, name) => `@${name}`)
  .replace(/<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g, (_, url, label) => label || url)
  .replace(/\*([^*\n]+)\*/g, '$1')   // *bold*
  .replace(/`([^`\n]+)`/g, '$1')     // `code`
  // then decode &amp; &lt; &gt; &quot; &#39;
```

Resolve the signed-in user id to their name in that map too, otherwise your own
mentions render as raw `@U0661R66QRF`.

## Failure modes to design for

| Symptom | Cause | Response |
| --- | --- | --- |
| `ok: false, error: invalid_auth` / `not_authed` | token rotated or session revoked | treat as "not connected"; re-capture |
| HTTP 200 but everything empty | wrong/missing `d` cookie | same |
| `thread_not_found` | thread deleted or ts from a different channel | skip that row, don't fail the list |
| network error / timeout | Slack unreachable | keep the stored credential, mark "unverified", never block callers |

Principle used in `dev-dashboard`: **no Slack failure is an error.** Status
degrades to `connected: false`, list endpoints return `{ available: false }`, and
the UI renders a connect button. Nothing else in the app waits on Slack.

## Suggested shape for toolkit-mcp

Service layer (`src/services/slack/slack-client.ts`):

```ts
interface SlackSession { token: string; cookie: string; teamId: string; user: string }

class SlackClient {
  constructor(private session: SlackSession) {}
  private call(method: string, params: Record<string, string>): Promise<any>; // Bearer + Cookie
  authTest(): Promise<{ user: string; userId: string; team: string }>;
  listChannels(): Promise<Channel[]>;            // + search fallback
  history(channel: string): Promise<Message[]>;  // roots = thread_ts === ts
  replies(channel: string, ts: string): Promise<Message[]>;
  search(query: string): Promise<Match[]>;       // page-based paging
  users(): Promise<Record<string, string>>;      // id -> display name, cached
}
```

Config: read the credential from a file, not from env vars, so it is never
exported into a process listing or a `.env` someone commits —
`~/.config/slack/session.json` (mode `600`) with
`{ token, cookie, teamId, teamDomain, savedAt }`. Add `SLACK_SESSION_FILE` to
override.

Candidate tools (deliberately read-only at first):

| Tool | Purpose |
| --- | --- |
| `slack_whoami` | verify the session, report user/team |
| `slack_channels` | channel list (+ whether the user is a member) |
| `slack_threads` | threads started by the user and/or mentioning them in one channel, newest activity first, with a `needsReply` flag |
| `slack_thread` | full replies of one thread (message text, author, ts) |
| `slack_search` | `search.messages` wrapper scoped to a channel |

Posting (`chat.postMessage` with the same credentials) does work, but it acts as
the human, cannot be audited as a bot, and is the one call that is hard to undo.
Gate it behind an explicit opt-in env flag and say so in the tool description.

Never log the token or cookie, never echo them in an error message, and never
send them anywhere except `app.slack.com` and, to download a file,
`files.slack.com` and `files-origin.slack.com`. toolkit-mcp checks each exact
https file host, including every redirect target, before attaching credentials;
only a browser-session login sends its cookie, and an app login sends only its
bearer token. This file-host exception describes the implemented routing rule,
not a verified live download: whether Slack serves file bytes to the session
pair remains unverified pending the human live check.

## What we measured (for sizing expectations)

In `ezat_claudio` (private, ~91 messages at the time):

- 58 thread roots, 33 plain messages; 13 threads started by the user.
- 84 mention matches → 25 distinct threads after grouping.
- `users.list` needed 2 pages for 200+ members.
- A full refresh (history 1 page + users 1 page + search 1 page + 25–50
  `conversations.replies`) completed in ~2–4 s and is cached for 60 s.
