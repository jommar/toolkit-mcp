# Slack module

The Slack module gives AI agents ten tools to read Slack and, behind a preview-then-confirm gate, to post messages, add reactions and upload files. It runs as you, and there are two ways to give it your Slack identity:

- **Reuse dev-dashboard's login (no Slack app).** `dev-dashboard` signs in to the Slack web client once and writes `~/.config/slack/session.json` — the web client's own `xoxc` token plus its `d` session cookie. `slack_login` adopts that pair, verifies it with `auth.test` and keeps its own copy. Nothing to register, and no browser step in this module.
- **Log in with your own Slack app.** Create a small app from a manifest shipped in this repo and approve it once in your browser; the module keeps the resulting user token. Use this when there is no dev-dashboard session, or when you want a token Slack can revoke and whose scopes are fixed.

Either way it can read only what you can read, and what it posts appears as sent by you. Nothing in the module names a workspace, so it works in any workspace.

This guide is for the person setting it up and for agents using it. Choose a route in section 4; the app route also needs sections 2 and 3.

## 1. Turning it on

The module is off by default. Set `SLACK_ENABLED=true` in the server's environment (the `.env` file, or the `env` block of your MCP client config) and restart the MCP client. Only the exact value `true` turns it on; unset, `false` or anything else registers no `slack_*` tool. When it is on, `mcp_get_health` reports `slack` as active.

`SLACK_ENABLED` is the only required Slack setting in the environment. The app's client id lives in its own file (section 3), never in `.env`. `SLACK_SESSION_FILE` is optional: it moves the captured session the module reads from its default `~/.config/slack/session.json`.

## 2. Create and install the Slack app

Skip this section and section 3 if you are using the dev-dashboard session (section 4).

Slack only lets a login link return to `http://localhost` for an app that has PKCE turned on, so the manifest turns it on. Nothing in the manifest names a workspace.

1. Go to https://api.slack.com/apps and choose Create New App, then From a manifest.
2. Pick the workspace the app belongs to, switch to the JSON tab and paste the contents of `docs/slack-app-manifest.json`. Review the summary and create the app.
3. Install the app to the workspace from its settings page. If your workspace requires admin approval for new apps, the install becomes a request that an administrator approves. Slack does not say whether an internal app that asks only for user scopes is exempt, so expect that it may need approval.
4. Open the app's Basic Information page and copy the **Client ID**. You will not need the client secret; do not copy it anywhere.

What the manifest sets:

| Setting | Value |
| --- | --- |
| Redirect URL | `http://localhost:53682/slack/oauth/callback` |
| User scopes | the 14 listed in section 8, and nothing else |
| PKCE | on |
| Token rotation | off |
| Bot user and bot scopes | none |

- **PKCE is one-way.** Once PKCE is on for an app, Slack does not let you turn it off. If you ever need an app without it, create a second one.
- **No client secret is stored.** PKCE replaces the secret in the token exchange, so the module never asks for one and never writes one to disk. A `client_secret` you leave in the config file is ignored and never sent.
- **The port is fixed.** The redirect URL is registered in the app, so the module always listens on 53682.

## 3. The app config file

Write the client id to `~/.config/slack/toolkit-mcp/app.json`:

```bash
mkdir -p ~/.config/slack/toolkit-mcp
chmod 700 ~/.config/slack/toolkit-mcp
printf '{"client_id": "PASTE-THE-CLIENT-ID-HERE"}\n' > ~/.config/slack/toolkit-mcp/app.json
chmod 600 ~/.config/slack/toolkit-mcp/app.json
```

- The file holds the client id only, and nothing else is read from it.
- It must be a regular file, not a symlink, with no group or world access (mode 600 in a directory of mode 700). Anything else makes the module answer `app_not_configured` and name the path.
- It is never an environment variable, never in `.env`, and never committed.
- The same directory holds `token.json`, the login the module writes after `slack_login` (mode 600, written atomically). Its parent also holds the session dev-dashboard captures, `~/.config/slack/session.json`, which the module reads when adopting that login and never writes, moves or removes.

## 4. Log in, check status, log out

`slack_login` chooses the route by what it finds: nothing stored and a Slack web session in `~/.config/slack/session.json` means it adopts that; anything else starts the app login below.

### Login from dev-dashboard's session

1. In `dev-dashboard`, connect Slack once (its Settings, Slack, Connect). You sign in to the Slack web client in a browser and it writes `~/.config/slack/session.json` (mode 600) with the web client's `xoxc` token and its `d` cookie.
2. Call `slack_login`, optionally with `workspace`. The module reads that file, copies the pair into `~/.config/slack/toolkit-mcp/token.json` (mode 600), and verifies it with `auth.test`. It returns `{state: "connected", user_id, team_id, team_domain, saved_at, next_step}`.
3. The captured file is only ever read: never rewritten, moved or removed, so dev-dashboard keeps working.

- Slack issued this pair to its web client, so calls go to `https://app.slack.com/api` with both `Authorization: Bearer <xoxc-token>` and `Cookie: d=<xoxd-cookie>`. Neither header works alone.
- The session carries exactly your account's access, so there is no granted-scope list: a connected adopted session has no `scopes_missing`, and `slack_get_users` answers `email_unavailable: "not_set"` when Slack returns no address.
- If Slack rejects the pair, the copy is removed immediately and the call reports `expired` with `invalid_auth`-style `reason`. Reconnect in dev-dashboard, then `slack_login` again.
- `SLACK_SESSION_FILE` points the module at a different captured file; give it an absolute path, because a leading `~` is not expanded.

### Login by link

1. Call `slack_login`, optionally with `workspace` (a team id, a domain such as `example-team`, a host, or a workspace URL). It returns `{state: "pending", authorize_url, expires_at, completion, next_step}`. It never opens a browser or starts any other process.
2. Open `authorize_url` in your own browser and approve. The link lives 10 minutes.
3. Slack redirects the browser to `http://localhost:53682/slack/oauth/callback`. A small loopback listener started by `slack_login` receives it, finishes the login, shows "Slack login finished. You can close this tab", and closes. The listener binds `127.0.0.1` only, answers only that one path, and serves one login.
4. Call `slack_get_status`; it reports `connected`.

`completion` says how the login will finish: `callback` when the listener is up, `paste` when it could not start (the port is busy).

**Paste fallback.** If `completion` is `paste`, or the browser cannot load the localhost page, copy the full address from the browser's address bar (it still holds `code` and `state`) and call `slack_login` with `redirected_url` set to it. A bare code also works while exactly one login is pending. The same 10-minute limit applies.

Other behavior:

- A second `slack_login` while one is pending returns the same link and starts no second listener. Until the login finishes, read tools fail with `slack.login_pending` and write previews fail with `slack.not_connected`.
- If a team id was given in `workspace`, it is sent as a hint to Slack. Whatever you pass, the module checks which workspace Slack actually approved. If it differs from what you asked for, the new token is revoked, nothing is stored, and the call fails `slack.wrong_workspace`.
- A pending login lives in memory. Restarting the MCP server forgets it; run `slack_login` again for a new link.
- Called while already connected, `slack_login` returns the connected state. With a `workspace` that differs from the connected one it fails `slack.signed_in_elsewhere`.
- One workspace at a time. To switch, `slack_logout`, then `slack_login`.

### Status

`slack_get_status` never throws and never changes anything. `verify` defaults to true, which asks Slack (`auth.test`, cached for 60 seconds); `verify: false` makes no network call.

| `state` | Meaning | What comes with it |
| --- | --- | --- |
| `not_connected` | nothing stored, no pending login | `app_configured`, `dashboard_session_available`, plus the step: run `slack_login` (or write the app config file, when no session is available) |
| `pending` | an app login is waiting | `authorize_url`, `expires_at`, `completion` |
| `connected` | a login is stored (and, with `verify`, accepted) | `user_id`, `team_id`, `team_domain`, `saved_at`, and `scopes_missing` only when the login was by app |
| `expired` | Slack rejected the token, or the token file could not be read | `reason` (Slack's code, or a local one such as `symlink_refused`); the step is logout, then login |
| `unverified` | a token is stored but Slack could not be reached | the step is to try again |

Every state carries a `next_step`.

### Logout

`slack_logout` deletes `token.json` and cancels any pending login. For an app token it revokes it at Slack first. It returns `{state: "not_connected", revoked, removed, next_step}` and is safe to repeat.

- A session adopted from dev-dashboard is only removed locally: Slack has no revoke endpoint for a web session, so `revoked` is `false` and the captured file is untouched. Reconnect in dev-dashboard to invalidate it there.
- `revoke: false` keeps an app token valid at Slack: no Slack call is made and only the local file is removed. Use it only if you want the token to keep working elsewhere.
- If the revoke call fails, the local file is still removed and the result has `revoked: false`. The `next_step` then tells you to remove the app in Slack's settings if the token should stop working.
- `app.json` is never touched.

## 5. The ten tools

| Tool | What it does | Array and item shapes | Max items |
| --- | --- | --- | --- |
| `slack_login` | start or finish a login | `workspace?`, `redirected_url?` (not an array) | - |
| `slack_logout` | revoke and forget the token | `revoke?` (not an array) | - |
| `slack_get_status` | report the session state | `verify?` (not an array) | - |
| `slack_search_messages` | search messages | `queries[]`: `{query?, exact_phrases?[], in_channels?[], from_users?[], after?, before?, top_level_only?, include_bots?}`; at least one of `query`, `exact_phrases`, `in_channels`; `query` up to 500 characters | 5 |
| `slack_get_messages` | read one message, or a conversation's history | `messages[]`: `{message}` (a link or `{channel, ts}`) for one message, or `{channel, after?, before?, top_level_only?}` for history | 20 |
| `slack_get_threads` | read threads | `threads[]`: `{thread}` (a message, reply or web-client thread link, or `{channel, ts}`); a reply is normalised to its root | 20 |
| `slack_get_channels` | look up channels | `channels[]`: `{channel}`, or `{name}` (exact, or a prefix ending in `*`), or `{member_only: true, types?, include_archived?}` | 20 |
| `slack_get_users` | look up users | `users[]`: `{user}`, `{query}`, `{members_of}` or `{me: true}` | 100 ids, or 20 of the other forms |
| `slack_prepare_write` | preview writes and get a confirmation token | `items[]` of `post`, `react` or `upload` (section 6) | 10, uploads included |
| `slack_confirm_write` | send what was previewed | `confirmation_token` | - |

Reads run on your user token, so they see only what you can see. Every read tool and `slack_prepare_write` takes an array of 1 to n items, even for a single lookup. Rules shared by all of them:

- **`ref`.** Any item may carry a `ref` of up to 64 characters. It is echoed back so the caller can match results to inputs.
- **Targets are ids or links.** Wherever a channel, DM, thread, message or user is expected, a Slack id or a pasted Slack link works (next subsection).
- **Times.** Input is ISO 8601 with an offset or `Z`, or a Slack ts. `after` is inclusive and `before` is exclusive. Output carries `ts` and `at` (ISO UTC).
- **Channel type.** `slack_get_channels` reports `type` (`public_channel`, `private_channel`, `im` or `mpim`) from Slack, because a link does not say. DMs list `participants` instead of a name.
- **Single messages.** `slack_get_messages` fetches one message through Slack's thread-replies call (`conversations.replies`, the same four `*:history` scopes), which finds a top-level message and a thread reply alike. A message that does not exist or is not visible to you fails that item `message_not_found`.
- **Bots.** A channel history read leaves bot messages out, and so does search unless `include_bots` is true. A thread read and a single-message read keep them, with `is_bot` set.

### Links as targets

Links are parsed locally, with no Slack call, and must be `https`. The examples use made-up ids; yours come from Slack's "Copy link".

| Shape | Example | Resolves to |
| --- | --- | --- |
| Channel, DM or group DM | `https://example-team.slack.com/archives/C0EXAMPLE01` (also `D0EXAMPLE01`, `G0EXAMPLE01`) | the conversation |
| Message | `https://example-team.slack.com/archives/C0EXAMPLE01/p1700000000000100` | that message; as a thread target, the thread it roots |
| Thread reply | `https://example-team.slack.com/archives/C0EXAMPLE01/p1700000000000200?thread_ts=1700000000.000100` | the reply; as a thread target, the root |
| Web client channel | `https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE01` | the conversation |
| Web client thread | `https://app.slack.com/client/T0EXAMPLE1/C0EXAMPLE01/thread/C0EXAMPLE01-1700000000.000100` | the thread root |
| User profile | `https://example-team.slack.com/team/U0EXAMPLE01` | the user |
| File | `https://example-team.slack.com/files/U0EXAMPLE01/F0EXAMPLE01/notes.txt` | recognised, but no tool reads files, so it fails `wrong_link_kind` |

Enterprise Grid workspace links resolve the same way. A message link works in a channel field (its channel) and in a thread field (its root); a reply link and the link of its root, sent together to `slack_get_threads`, cost one fetch. A user link works only in user fields.

A link that is not one of these shapes (including `slack://` links and other hosts) fails that item with `unrecognized_link`, and a link from a workspace other than the connected one fails with `wrong_workspace`, naming the connected one. Both fail before any call to Slack and never throw.

### Batches and results

A read returns `{results, truncated}`. `results` has one entry per input item, in input order:

| Key | Meaning |
| --- | --- |
| `ref`, `index` | the caller's reference (or the item's own key), and its position |
| `status` | `ok`, `error` or `not_attempted` |
| `items` | when `ok`, always an array, possibly empty |
| `hasMore`, `nextPageToken` | paging, below |
| `error` | `{code, message, retry_after_s?}` when `error` |

One failed item never fails the batch. Identical items are fetched once. An item list over the tool's cap fails the whole call with `slack.batch_too_large` before anything is fetched.

Limits per call: 4 requests to Slack in flight, about 50 Slack calls in total (checked before each item starts, so a few in-flight items can carry the total past it, and a user-directory fetch counts once), and 100,000 characters of response. Items that were not reached because the call budget ran out, or because Slack rate-limited the call, come back `not_attempted` with a cursor to resume from. A rate limit that survives retries fails that item `rate_limited` with `retry_after_s`, and no further items are started. If the response is too large, whole messages are dropped from the end of the results, `truncated` is `true`, and the affected entries carry a cursor that starts at the first omitted message.

### Pagination

One contract for every list-shaped result, per target:

- `limit` is the page size per target: default 20, maximum 100.
- `nextPageToken` comes back when `hasMore` is true. To continue, send a new call with an item holding only `{cursor}` (plus a `ref` if you like) for the targets you want. No tool fetches every page by itself.
- A cursor is opaque and tied to the tool and target that issued it (for a search, its query). Using it elsewhere, editing it, or using one issued before the MCP server restarted fails that item with `invalid_cursor`; start again from the first page.
- Order is stable: history newest first; threads oldest first with the root once; search newest first, with its upper time bound frozen at page one, so new posts do not shift the pages; lists in Slack's order. Pages that were shortened by bot filtering or the size limit resume without duplicates or gaps.

### Fields and privacy defaults

By default a message carries only `channel_id`, `ts`, `thread_ts`, `is_top_level`, `reply_count`, `author_id`, `is_bot`, `at` and `permalink`. There is no message text, no author name and no email unless asked for.

- Message tools accept `fields`: `text`, `mrkdwn`, `author_name`, `reactions`, `channel_name`. `max_text_chars` (default 300) caps each text. `slack_get_channels` takes no `fields`.
- `slack_get_users` accepts `fields`: `real_name`, `title`, `tz`, `email`. Phone numbers are never available. Any other field name is rejected as invalid input.
- **Email** appears only on the user entries of a `slack_get_users` call that lists `email` in `fields`. Each such entry has `email`, or `email: null` with `email_unavailable` set to `scope_missing` (the token was not granted `users:read.email`; log out and in again after adding the scope) or `not_set` (Slack has no address for that user, as for bots). A `{query}` user lookup matches names only, never addresses.
- No other tool, write preview, log or error contains an email address. No result, log or error contains a token, an authorization code, file contents or a request header.

### Threads on Jira issues

The Jira module's `jira_get_issues` can look up Slack threads for each issue it returns (`includeSlackThreads: true`), over the same session as the tools above, so it needs `SLACK_ENABLED=true` and a `slack_login` session. It runs one `search.messages` call per issue for the quoted issue key (`-is:dm`, so direct messages do not use up the matches), for the first 10 issues only, newest matches first, and returns up to 5 threads per issue as links to the thread root (`permalink`, `channel`, `channelId`, `threadTs`, `at`), never message text. Several matches in one thread collapse into one entry. Direct messages, group direct messages and bot messages are left out. When Slack is not connected, rejects the session or cannot be reached, the Jira issues are still returned, with the reason in the response's `warnings`.

## 6. Writing: prepare, then confirm

There is no way to post, react or upload in one step. `slack_prepare_write` checks and previews up to 10 items and returns a `confirmation_token`; `slack_confirm_write` sends them.

| Action | Fields |
| --- | --- |
| `post` | `destination`, `expected_destination?`, `text`, `thread?` (a ts or message link), `reply_broadcast?` |
| `react` | `message` (a link, or `{channel, ts}`), `expected_destination?`, `emoji` (with or without colons) |
| `upload` | `destination`, `expected_destination?`, `thread?`, `path`, `filename?`, `title?`, `comment?` |

Each item may add `ref`. `destination` is a conversation id (`C`, `G` or `D` prefix) or a link.

**Where it goes.** A conversation link means a top-level post. A message or thread link means a reply in that thread's root. A user link fails `wrong_link_kind`: paste the DM link instead, because opening a DM is itself a write.

**Destination guard.** With a conversation id, `expected_destination` is required, or the call is refused as invalid input before anything is looked up. It is the channel name for a channel, the other person's user id or handle for a DM (yourself, for a DM with yourself), and the handles of the *other* members for a group DM, in any order — your own handle is not part of the set. A group DM reached by an id also reports its `type` as `mpim` in the preview, whatever its name. With a link it is optional because the link is your own pointer, but when given it is still checked. A mismatch fails the item `target_mismatch`.

**Per-item checks.** The conversation must exist and not be archived (`channel_archived`), and a thread root must resolve (`thread_not_found`). Sends use `link_names` off, so only explicit `<@U0EXAMPLE01>`, `<!subteam^S0EXAMPLE01>`, `<!here>`, `<!channel>` and `<!everyone>` notify anyone.

**The preview.** The result is `{confirmation_token, expires_at, items}`. Every item has `index`, `ref`, `action`, the resolved `destination`, `mentions`, and `warnings`. The destination is human-readable: `type`, `name`, `participants` for DMs, `is_private`, `is_ext_shared`, `is_member`, `member_count`, `topic`, `purpose`, and `thread_root` (author and first line) when replying. Warnings include `slack_connect`, `not_a_member` and `broadcast_mention`. Then, by action:

- `post`: `text_preview` and `char_count`.
- `react`: `emoji` and the target message with its permalink.
- `upload`: `file` (section 7) and `comment_preview`. File contents never appear.

If any item fails its checks, its preview carries an `error` and **no token is issued**; nothing can be confirmed until the list is fixed and previewed again.

**The token.** It is single use, valid for 10 minutes, and bound to the exact list that was previewed. `slack_confirm_write` takes only the token and sends the items one at a time, in order. A failure on one item is reported on that item and the rest still run. Each result is `{index, ref, action, channel_id, status, ts?, file_id?, permalink?, error?}`, inside `{already_sent, results}`. Sending the same token again within its 10 minutes returns the stored results with `already_sent: true` and sends nothing. After that, a token that was already confirmed reads `confirmation_expired` or `confirmation_unknown` even though its items were sent, so check the confirm result you already have, or Slack, before previewing the same items again. Restarting the MCP server forgets every token. No other tool can post, react or upload.

Each frozen item remembers the workspace it was previewed in. If you log out and log in to another workspace before confirming, the items fail `workspace_changed` and nothing is sent; a confirm made while logged out fails `not_connected` and leaves the token unused. Only the workspace is compared, not the user: logging in again as someone else in the same workspace lets the items go out as that person.

**The rule for agents.** Show the person every item's destination, text or file (with its resolved path), thread and mentions. Check the topic and purpose when they did not name the destination themselves. Call `slack_confirm_write` only after they say yes to that exact preview. The token makes the order mandatory; it cannot prove that a human looked.

## 7. Uploads

Uploads go through the same gate as posts, as the `upload` action. By design there is no file-size limit, no limit on the number of uploads beyond the 10 items per token, no blocked file types, and no restriction on where a file may live. The safeguard is visibility: the preview shows exactly which file would leave your machine, and nothing is sent without a confirmed token.

**At prepare**, the module inspects the file:

- `path` must be absolute (`path_not_absolute`) and must exist (`path_not_found`).
- A symlink is followed, not refused. The preview shows `resolved_path` and `via_symlink`, so check the real location.
- The resolved target must be a regular file. Directories, pipes, sockets and devices fail `not_a_file`.
- The preview's `file` is `{resolved_path, via_symlink, name, size, type, sha256}`. `type` is sniffed from the first bytes (PNG, JPEG, GIF, PDF, ZIP, else plain text for valid UTF-8 or a `.txt` name, else `application/octet-stream`). `name` is `filename` if given, else the file's own name.

**At confirm**, each upload item:

1. checks the file again; if it is missing, not a regular file, or a different size, the item fails `file_changed` and nothing goes to Slack;
2. asks Slack for an upload URL for that name and size;
3. streams the file to that URL while hashing it, with no credentials attached to the upload request;
4. compares the hash with the previewed `sha256`; if it differs, the item fails `file_changed` and the upload is never completed, so the uploaded bytes are never shared;
5. completes the upload into the destination, thread and comment, and returns the file's permalink.

Memory stays at one chunk whatever the file size.

**When Slack refuses.** Slack's own limits apply (a workspace can restrict upload size or run out of storage), and they come back as Slack's error. Only that item fails, with `status: "error"` and `error.code` `upload_rejected`, plus `step` (`get_upload_url`, `send_bytes` or `complete_upload`) and Slack's code as `slack_code` (or `http_status` for the byte upload). The other items still run. The `get_upload_url` step is a read and is retried like any read (429, 403 and 5xx answers, and network errors). The `send_bytes` and `complete_upload` steps, and every other write (post, react, revoke), are attempted once, even after a timeout, because Slack may already have applied them. A file that was never completed is never shared.

The upload address Slack names in `get_upload_url` is checked before any byte is sent: it must be `https` on a `slack.com` host, and a redirect is reported rather than followed. Otherwise the item fails `upload_rejected` at step `send_bytes`, with neither a Slack code nor an HTTP status.

## 8. Scopes per tool

These are user-token scopes, and they apply to the app login only: an adopted web session carries your account's own access and has no scope list. For an app token, the manifest requests exactly their union, and a test keeps the two equal.

| Tool | User scopes |
| --- | --- |
| `slack_login`, `slack_logout`, `slack_get_status` | none |
| `slack_search_messages`, and `jira_get_issues` with `includeSlackThreads` | `search:read` |
| `slack_get_messages`, `slack_get_threads` | `channels:history`, `groups:history`, `im:history`, `mpim:history` |
| `slack_get_channels` | `channels:read`, `groups:read`, `im:read`, `mpim:read`, `search:read` |
| `slack_get_users` | `users:read`, plus `users:read.email` for the optional `email` field |
| `slack_prepare_write` | the four `*:history` scopes, the four `*:read` scopes, `users:read` |
| `slack_confirm_write` | `chat:write` (posts), `reactions:write` (reactions), `files:write` (uploads) |

`users:read.email` is used only for the optional `email` field. If you remove it from the manifest, everything else works and `email` answers `scope_missing`; `slack_get_status` will keep listing the scope in `scopes_missing`, which is harmless in that case. If you change the app's scopes later, run `slack_logout` and `slack_login` so the new token carries them.

## 9. Errors

Call-level errors are thrown, with the message `slack.<code>: <what happened> <next step>`. Bad input (an unknown field name, a search with no criteria) is rejected as invalid input.

| Code | When | Next step |
| --- | --- | --- |
| `app_not_configured` | `app.json` missing, symlinked, not private, not valid JSON, or without a `client_id` | write it as in section 3 (the message names the path) |
| `not_connected` | a tool needs a token and none is stored (a write preview also answers this while a login is still pending) | run `slack_login` |
| `login_pending` | a read tool ran while a login waits for approval | open the link, or paste the redirected address into `slack_login` |
| `login_expired` | the redirect or paste arrived after 10 minutes | run `slack_login` again |
| `state_mismatch` | the redirect does not belong to the pending login, or none is pending | run `slack_login` again and use the new link |
| `exchange_failed` | Slack ended the login without approval, or the token exchange or the identity check failed | check the app (section 12), then run `slack_login` again; after a failed identity check the new token is revoked, and when the result says `revoked: false` its `next_step` says to remove the app from that workspace in Slack first |
| `wrong_workspace` (login) | Slack approved a different workspace than `workspace` | the token was revoked and not stored; run `slack_login` again and pick the right workspace (if the message says the revoke failed, remove the app from that workspace in Slack first) |
| `signed_in_elsewhere` | `slack_login` for a different workspace while connected | `slack_logout`, then `slack_login` |
| `invalid_workspace` | the `workspace` value is not a team id, domain, host or URL | name the workspace in one of those forms |
| `no_authorization_code` | the redirect carried no code | run `slack_login` again |
| `session_rejected` | Slack no longer accepts the token (revoked, expired, account inactive); a read fails the call, a write reports it on the item | `slack_logout`, then `slack_login` |
| `batch_too_large` | more items than the tool's cap | split the list |
| `confirmation_unknown` | the token is unknown, the server restarted, or the token expired and a later `slack_prepare_write` has since cleared it | preview again with `slack_prepare_write`, unless the token was already confirmed (section 6) |
| `confirmation_expired` | the token is older than 10 minutes; if it was never confirmed, nothing was sent | preview again, unless the token was already confirmed (section 6) |

Per-item errors appear in a result's `error` field, and the rest of the batch is unaffected:

| Code | Meaning |
| --- | --- |
| `unrecognized_link` | not a supported Slack link; the message lists the supported shapes |
| `wrong_workspace` | the link is from a workspace other than the connected one |
| `wrong_link_kind` | the link's kind does not fit the field (a user link as a channel, any file link) |
| `channel_not_found`, `channel_archived`, `thread_not_found`, `message_not_found`, `user_not_found` | the target does not exist, or is not visible to you |
| `target_mismatch` | the destination is not what `expected_destination` said, or a thread and a destination link name different threads |
| `workspace_changed` | the connected workspace changed after the preview; nothing was sent; preview again |
| `invalid_cursor` | a cursor from another tool or target, an edited one, or one issued before a server restart |
| `rate_limited` | Slack rate-limited the call; carries `retry_after_s` |
| `unreachable` | Slack could not be reached |
| `path_not_absolute`, `path_not_found`, `not_a_file` | upload file checks |
| `file_changed` | the file changed after the preview |
| `upload_rejected` | Slack refused an upload step, or named an upload address that is not `https` on a `slack.com` host; carries `step` and, when there is one, Slack's code or the HTTP status |
| `slack_error` | any other Slack error; the message names Slack's code (write items also carry it as `slack_code`) |

`not_attempted` is a status, not an error: the item was never started, and its `nextPageToken` resumes it.

## 10. Manual smoke test

Only you run this; agents never log in to a live Slack. It exercises every part once, against a place where a test post does no harm. Use a direct message only you will see, such as the conversation with yourself, and copy its link: copy the link of any message in it and remove everything from `/p` onward to get the conversation link (`https://example-team.slack.com/archives/D0EXAMPLE01` has that shape). The steps below call it "your own DM link".

1. Connect either route: with dev-dashboard, connect Slack there once so `~/.config/slack/session.json` exists; otherwise create the app (section 2) and write `app.json` (section 3). Then set `SLACK_ENABLED=true` and restart the MCP client.
2. `slack_get_status` reports `not_connected`, with `dashboard_session_available: true` on the dev-dashboard route or `app_configured: true` on the app route.
3. `slack_login`. On the dev-dashboard route it returns `connected` at once and a stored `token.json` holds `access_token` (xoxc) and `cookie` (xoxd). On the app route, open the link in your own browser and approve; the tab says the login finished. Either way `slack_get_status` then reports `connected`, and the app route also shows an empty `scopes_missing`. The app route confirms Slack accepted the localhost redirect.
4. Read: send `slack_get_threads` the link of a thread's root message and the link of one of its replies, from your own DM (or any thread you can read), in one call; both entries come back and the thread was fetched once. Then use a small `limit` (say 2) and continue with the returned `nextPageToken`. Pages arriving at normal speed also show Slack is not applying its reduced history limits to the app. Also read one reply by its own link with `slack_get_messages`: it must come back as that reply, not as the thread's root.
5. Post: `slack_prepare_write` with one `post` item to your own DM link; check the preview; `slack_confirm_write`. The result has a permalink.
6. React: prepare and confirm a `react` item on that post, using the permalink.
7. Upload: prepare and confirm an `upload` item for a tiny harmless text file at an absolute path. Check that the preview shows the resolved path.
8. `slack_logout`. `slack_get_status` reports `not_connected`. The app route reports `revoked: true`; the dev-dashboard route reports `revoked: false` and leaves `~/.config/slack/session.json` unchanged.

## 11. Limits and what is not included

Not included: reading file contents, canvases, lists, drafts, scheduled messages, editing or deleting messages, removing reactions, joining or inviting, unreads and mentions, concurrent workspaces. For an app login, token rotation is off, so an expired or revoked token means logging in again; an adopted web session can be rotated or signed out by Slack at any time, and then means reconnecting in dev-dashboard and running `slack_login` again. Every Slack behavior described here comes from Slack's documentation and from offline tests except the dev-dashboard capture, which was verified against a live workspace; the smoke test is the first live run in this module.

## 12. Troubleshooting

**Status is `expired` right after adopting the dev-dashboard session.** Slack rejected the captured token and cookie — usually because the web session was signed out or rotated. The module removed its copy. Reconnect Slack in dev-dashboard, then run `slack_login`. `reason` carries Slack's own code.

**`slack_login` starts an app login even though dev-dashboard is connected.** The captured file was not usable: it is missing, not valid JSON, or its `token` does not start with `xoxc-` / its `cookie` does not start with `xoxd-`. Only a real Slack web session is adopted, and the file is read from `~/.config/slack/session.json` unless `SLACK_SESSION_FILE` says otherwise. Reconnect in dev-dashboard and check that path.

**The port is in use.** `slack_login` returns `completion: "paste"`. Either finish by paste (section 4), or stop whatever holds port 53682, call `slack_logout` (which cancels the pending login) and run `slack_login` again. The port is fixed because it is part of the app's redirect URL.

**`localhost` resolves to IPv6.** The listener is on `127.0.0.1` only. If your browser tries `::1` first, the callback page fails to load, but the address bar still holds `code` and `state`. Copy the whole address into `slack_login` as `redirected_url` within 10 minutes.

**The browser says "Slack login did not finish".** The redirect was refused (a wrong state, or Slack reported an error). Call `slack_get_status`: if it is still `pending`, use the link again or paste the address; if it is `not_connected`, run `slack_login` again, because each attempt needs a fresh link.

**`signed_in_elsewhere`.** You are connected to a different workspace than the one you asked for. Run `slack_logout`, then `slack_login` with the workspace you want.

**`wrong_workspace`.** At login: Slack approved another workspace than the one you named; the token was revoked and nothing was stored. Run `slack_login` again and choose the right workspace on Slack's page. On the callback route the agent is not told whether the revoke worked (see `exchange_failed`). On a link: the link belongs to a workspace other than the connected one; paste a link from the connected workspace, or switch with logout and login.

**`app_not_configured`.** The message names the path. Check that `~/.config/slack/toolkit-mcp/` is mode 700, `app.json` is a regular file of mode 600 (not a symlink), and its contents are valid JSON with a `client_id`. Section 3 has the commands.

**`exchange_failed`.** Check that the client id is the one on this app's Basic Information page, that the app was created from the shipped manifest (PKCE on, the redirect URL exactly as in section 2, all 14 scopes), and that you approved rather than cancelled. Then run `slack_login` again; a used or expired link cannot be reused. The `revoked` flag and the remove-the-app step come back only on the paste route. On the callback route the browser shows the failed page and `slack_get_status` reports `not_connected`, without saying whether the new token was revoked. If a callback login failed after you approved and the token must not stay valid, remove the app from the workspace in Slack's settings.

**An administrator has to approve the app.** If your workspace requires approval for new apps, the login cannot finish until an admin approves this one. Ask an admin to approve it, then run `slack_login` again.

**`scopes_missing` is not empty, or `email_unavailable` is `scope_missing`.** The token was granted fewer scopes than the module asks for. Add the scopes to the app, then `slack_logout` and `slack_login` and approve everything.

**Status is `expired` with `symlink_refused`.** The module refuses to read or write a token through a symbolic link, and it checks every parent directory of `token.json`, not only the config directory. A dotfile manager that links `~/.config` triggers this. Keep the whole path real, or remove the link in the path. A login that cannot save its token fails the same way after you approve it: the paste route answers `slack.symlink_refused`, and on the callback route the browser page says the login did not finish.

**Status is `expired` with `token_unreadable`.** `token.json` is not valid JSON. Delete the file by hand and run `slack_login`.

**`invalid_cursor` on a continuation.** The server restarted, or the cursor came from another tool or target. Request the first page again.
