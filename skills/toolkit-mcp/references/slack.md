# toolkit-mcp — Slack reference

Loaded from [`../SKILL.md`](../SKILL.md) before your first Slack call. Slack registers only when the
server runs with `SLACK_ENABLED=true`; `mcp_get_health` then reports `slack` active. It runs as you.
Setup, limits and every error code are in the server's `docs/slack.md`.

## Tools

| Tool | Use for | Shape |
|------|---------|-------|
| `slack_login` | Start or finish a login | `workspace?`, `redirected_url?` |
| `slack_logout` | Forget the login (revokes an app token) | `revoke?` |
| `slack_get_status` | Report the login state | `verify?` (default true: asks Slack, cached 60s; `false` makes no call) |
| `slack_search_messages` | Search | `queries[]` (max 5); `fields?`, `limit?`, `max_text_chars?` |
| `slack_get_messages` | One message, or a channel's history | `messages[]` (max 20); `fields?`, `limit?`, `max_text_chars?` |
| `slack_get_threads` | Whole threads | `threads[]` (max 20); `fields?`, `limit?`, `max_text_chars?` |
| `slack_get_channels` | Look up channels | `channels[]` (max 20); `limit?` |
| `slack_get_users` | Look up users | `users[]` (max 100 ids, 20 otherwise); `fields?`, `limit?` |
| `slack_download_file` | Save one Slack-hosted file to disk; returns metadata only | `file` (file id or file link), `path` (absolute), `overwrite?` |
| `slack_prepare_write` | Preview a post / react / upload, get a `confirmation_token` | `items[]` (max 10) |
| `slack_confirm_write` | Send what was previewed | `confirmation_token` |

Every read tool and `slack_prepare_write` takes an **array** of 1 to n items, even for one lookup.
`slack_download_file` takes one file per call. A channel, DM, thread, message or user target can be a
Slack id or a pasted `https` Slack link.

## Login first — two different tokens

- **The login** is what `slack_login` stores. Check it before anything else: `slack_get_status` → `connected` means go.
- **The confirmation token** is what `slack_prepare_write` returns. It gates one previewed batch, not the login.

| `slack_get_status` state | Do |
|---|---|
| `connected` | go on |
| `not_connected` | `slack_login`. With an adopted browser session it returns `connected`; otherwise `pending` and an `authorize_url`: **give the link to the user** (the tool never opens a browser), then `slack_get_status` |
| `pending` | an app login is waiting on the user; repeating `slack_login` returns the same link |
| `expired` | `slack_logout`, then `slack_login` |
| `unverified` | Slack was unreachable; try again |

A call without a login throws `slack.not_connected`, `slack.login_pending` or `slack.session_rejected`.
That is the login, not "nothing found". A write preview made while not connected fails `slack.not_connected` and sends nothing. One workspace at a time: switch with `slack_logout`, then
`slack_login`. A login adopted from a browser session is only removed locally by `slack_logout`.

## Writing: prepare, show, confirm

There is no one-step post, react or upload, and no tool that edits or deletes one afterwards.

1. Login is `connected`.
2. `slack_prepare_write { items: [...] }` with `post`, `react` or `upload` items. With a conversation **id** as `destination`, `expected_destination` is required (channel name; the other person's id or handle for a DM; the *other* members' handles for a group DM) and a mismatch fails `target_mismatch`. A link needs no `expected_destination`; a user link fails `wrong_link_kind` (paste the DM link).
3. **Show the person the preview** — every item's destination (name, privacy, member count, topic), exact text or file path, thread, mentions and warnings (`slack_connect`, `not_a_member`, `broadcast_mention`). Check the topic and purpose when they did not name the destination. Stop.
4. `slack_confirm_write { confirmation_token }` only after they say yes to **that** preview. Changing the text means preparing again.

The token is single use, valid 10 minutes and bound to the exact list previewed. If any item fails, no
token is issued for the batch. Confirming twice inside 10 minutes returns `already_sent: true` and sends
nothing; after that a token reads `confirmation_expired` / `confirmation_unknown` **even though the items
went out**, so check the confirm result you hold, or Slack, before previewing the same items again.
Restarting the server forgets every token. Only `<@U…>`, `<!subteam^…>`, `<!here>`, `<!channel>` and
`<!everyone>` notify anyone; `@name` stays text.

## Formatting posts

`post` `text` (and an upload's `comment`) is **mrkdwn**, Slack's own markup. Prefer structure over a flat
paragraph: bold the one thing to act on, put commands and identifiers in code, break lists into bullets.

| Want | Write | Not (shows literally) |
|---|---|---|
| Bold | `*bold*` | `**bold**` |
| Italic | `_italic_` | `*italic*` (that is bold) |
| Strike | `~strike~` | `~~strike~~` |
| Inline code | `` `code` `` | |
| Code block | ```` ``` ```` fence on its own lines | a language tag (printed as text) |
| Quote | `> quoted` at line start | |
| Link | `<https://url\|label>` | `[label](https://url)` |
| Bullets | `•` at line start | markdown list nesting |
| Numbered | `1.` at line start | |
| Mention | `<@U…>` (ids from `slack_get_users`) | `@name` (plain text, notifies no one) |

- **No headings or tables.** `#` and pipe tables print raw. Use a bold line as a heading and bullets or a code block for tabular data.
- **Keep it short.** Put long output in a code block or an `upload`.
- **Escape stray `&`, `<`, `>`** as `&amp;`, `&lt;`, `&gt;` outside markup (e.g. `Array<string>` outside a code span).
- **The preview shows the raw string.** Check balanced `*`, `_`, `` ` `` and closed `<url|label>` in `text_preview` before showing it — a typo means a repost.
- **No Block Kit** — `blocks` cannot be attached.

## Downloading files

Reads list attachable files at `results[].items[].attachments[].file_id`; pass that id unchanged as
`slack_download_file.file`. `path` must be absolute and its directory must exist; an existing target
fails `target_exists` unless `overwrite: true`. Only files Slack hosts itself can be downloaded
(`file_not_downloadable` otherwise), and an app login needs the `files:read` scope (`scope_missing`). No
preview step: nothing leaves your machine. The saved file has mode 600.

## Gotchas

- **Slack reads do not return `PaginatedResponse`.** They return `{results, truncated}`, one entry per input item in order, each with its own `status`, `items`, `hasMore` and `nextPageToken`. A failed item does not fail the batch. To page, send a new item holding only `{cursor}`; a cursor belongs to the tool and target that issued it (`invalid_cursor` otherwise, and after a restart). `limit` is per target, max 100.
- **Messages carry no text by default** — only ids, timestamps, flags and `permalink`. Ask for `fields: ["text"]` (`max_text_chars`, default 300), `author_name`, `reactions`, `channel_name`. Email only through `slack_get_users` with `fields: ["email"]`.
- **Search spans everything you can see, DMs included.** A private channel you cannot see returns nothing or `channel_not_found` — a failure, not an empty result.
- **Search the whole issue key** (`"PROJ-123"`); a bare number matches PR numbers and hashes.
- **Threads can hold personal data.** Cite permalinks instead of copying thread text into notes, memory or files.
