# Changelog

All notable changes to the toolkit-mcp project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Served agent guide** — `skills/toolkit-mcp/` (`SKILL.md` plus six `references/`) is served over the MCP Skills extension (`io.modelcontextprotocol/skills`): `skills/list` returns `skill://toolkit-mcp/SKILL.md` and its files read over `resources/read`. The guide is workspace-neutral, covers every registered tool (including `jira_get_changelogs` and `slack_download_file`), and a test fails when it drifts from the registered tools.

### Changed

- **`resources` is always advertised** — The skill files are resources, so the capability is present even with no integration active, for legacy and 2026-07-28 clients alike.

## [0.4.0] — 2026-11-25

**Rollout:** the dependencies changed, so run `npm ci` in the checkout the MCP client launches before restarting any client session; without it the server fails at import. Sessions already running keep the old process until they restart. Existing client configuration keeps working with `node --import tsx src/mcp-server.ts`; `bin/toolkit-mcp` is the new recommended command. Under a Node below 24 the server refuses to start, and `npm ci` refuses to install (`engine-strict`). Rollback is the previous commit plus `npm ci`.

### Added

- **Node launcher `bin/toolkit-mcp`** — The recommended MCP client command. It runs the server from the repo root with the Node version in `.nvmrc` (`$HOME/.nvm/versions/node/v<version>/bin/node`) when that is installed, and otherwise `node` from `PATH`. It writes nothing to stdout.
- **Node version guard** — The server refuses to start on a Node below the `engines.node` minimum (24, read from `package.json`): it writes the running version and the minimum to stderr and exits 1, before anything reaches stdout.
- **Both MCP protocol eras from one process** — The server moves to the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0): an `McpServer` served by `serveStdio`. A client that sends `initialize` for 2025-11-25 or an older revision is served as before; a 2026-07-28 client that sends the per-request protocol envelope is served statelessly. Legacy clients are never rejected.
- **Tool titles and annotations** — Every tool in `tools/list` has a short `title` and all four hints. 49 tools are read-only, 17 write without destroying anything and 14 are destructive; `openWorldHint` is `true` for all but `mcp_get_health`. `slack_prepare_write` is marked read-only (it only previews) and `slack_confirm_write` is the write. The hints come from shared presets in `src/integrations/register.ts`.
- **Resource and prompt lists** — `resources/list` (`jira://myself`), `resources/templates/list` (`jira://issue/{key}`, `jira://search/{+jql}`, `github://prs/{issueKey}`) and `prompts/list` (`create-issue`, `triage-issue` with their arguments and which are required) now answer; before, only read and get did. Resources are named `jira_myself`, `jira_issue`, `jira_search` and `github_prs`, each with a title and `application/json`. The search template uses reserved expansion, so a JQL containing `/` resolves. `resources` and `prompts` capabilities are advertised only when a module that provides them is active.
- **List cache hints** — For 2026-07-28 clients the tool, prompt, resource and resource-template lists carry a one-hour, private cache hint, since the set is fixed for the life of the process.
- **Graceful shutdown** — SIGINT, SIGTERM or the end of stdin close the connection and exit 0, even when an integration holds a socket open. An uncaught exception is logged and exits 1; an unhandled rejection is logged and the server keeps serving.
- **`MCP_LOG_LEVEL=debug` is real** — It adds one stderr line per tool call with the tool name, `ok` or `error`, and the duration; arguments and results are never logged. All logging goes to stderr; stdout carries only protocol messages.
- **`npm run typecheck:tests`** — Type-checks the tests and fixtures (`tsconfig.test.json`) alongside `npm run typecheck`.

- **Slack module (eleven tools, off by default)** — Gives agents Slack access that runs as you, with no workspace named anywhere in the module. Set `SLACK_ENABLED=true` to register it; `mcp_get_health` then reports `slack`. Setup and reference are in [`docs/slack.md`](docs/slack.md).
  - **Login by link** — `slack_login` returns a link to open in your own browser, `slack_get_status` reports the session, and `slack_logout` revokes the token and removes it. The login uses PKCE (so no client secret exists), completes through a loopback listener on `127.0.0.1:53682`, and falls back to pasting the redirected address. The module keeps its own user token in `~/.config/slack/toolkit-mcp/token.json` (mode 600); the Slack app's client id goes in `app.json` beside it, never in `.env`. A manifest to create the app from ships as `docs/slack-app-manifest.json`: 15 user scopes, PKCE on, token rotation off, no bot user.
  - **Login from dev-dashboard's session (no app)** — When nothing is stored and `~/.config/slack/session.json` holds the Slack web session dev-dashboard captured (an `xoxc` token plus the `d` cookie, `SLACK_SESSION_FILE` to override), `slack_login` adopts that pair, verifies it with `auth.test`, and keeps its own copy, so no Slack app, client id or browser step is needed. Calls then go to `https://app.slack.com/api` with both the bearer token and the cookie. The captured file is only read, never rewritten or removed; a rejected pair is removed rather than left looking connected; `slack_logout` deletes only the copy, since Slack has no revoke endpoint for a web session. An adopted session has no scope list, so status carries no `scopes_missing`.
  - **Read tools** — `slack_search_messages`, `slack_get_messages`, `slack_get_threads`, `slack_get_channels` and `slack_get_users` take 1 to n items per call, accept Slack ids or pasted Slack links as targets, return one result per item with its own `nextPageToken`, and omit message text, author names and emails unless `fields` asks for them.
  - **Writes behind a gate** — `slack_prepare_write` previews up to 10 posts, reactions and file uploads (resolved destination, text or file path, thread, mentions) and returns a single-use confirmation token; `slack_confirm_write` sends exactly what was previewed, once, and sends nothing without a token.
  - **Uploads are uncapped by design** — no size limit, file-type list or path restriction; the preview shows the resolved absolute path, size, type and SHA-256, and the file is streamed and re-checked against that hash at confirm.
  - **File download** — `slack_download_file` saves one Slack file, given its id or a Slack file link, to an absolute path the caller names, and returns `{path, name, size, type, sha256}` only. An existing target is refused unless `overwrite` is true; only a regular file can be replaced, with its type checked before the download and again immediately before rename. Another local process can still change the target between that final check and rename; this is not a strict guarantee against concurrent adversarial local writers. The bytes stream to a mode-600 staging file while they are hashed, the byte count is checked against Slack's `files.info` size, and the staging file is removed on failure. Download credentials go only to `files.slack.com` and `files-origin.slack.com`, redirects are followed by hand and checked against those two exact https hosts before any credential is attached, and an HTML sign-in page in place of a non-HTML file is reported as `download_not_authorized` instead of being saved. The tool uses the same stored Slack login: an app login sends the bearer token only; a login adopted from dev-dashboard's browser session also sends its `d` cookie beside the token, only to those two hosts. Real browser-session file downloads remain unverified pending the human live check. It adds the `files:read` user scope, so an existing app login needs the scope added to its app and must be logged out and in once; until then `slack_get_status` lists it in `scopes_missing` and the tool answers `scope_missing`.

- **GitHub: `github_get_copilot_unresolved_prs`** — Lists PRs together with the full originating comment body of every unresolved Copilot-started review thread, so an agent can pick up outstanding Copilot feedback without re-reading resolved threads. Omit `prNumbers` for the authenticated user's PRs, pass `[]` to scan all authors, or pass explicit numbers to inspect any PR regardless of author or state. `limit` bounds candidate PRs scanned (not matches), so sparse pages can still report `hasMore: true`; per-PR thread-inspection failures are reported in a compact `errors` array instead of failing the call.
- **Jira: Components support** — Jira's Components field replaces "Product | Feature Group | Feature" and is required on TAP tickets. New `jira_list_components` tool (`projectKey` → `{items: [{id, name}], hasMore: false}`) discovers valid names, and `jira_create_issue` / `jira_update_issue` gain an optional, non-empty `components: string[]`. Names are matched case-insensitively against the project (the issue key's prefix on update) and sent as `components: [{id}]`; an unknown name is rejected with the project's valid names, the param wins over `fields.components`, and omitting it leaves components untouched. On update it replaces the issue's components. Backed by a new `JiraClient.listProjectComponents(projectKey)`.
- **Jira: `format` parameter on `jira_add_comment` / `jira_update_comment`** — Comments were plain text only (one ADF paragraph, mention tokens aside), so a caller could not post a table, headings, bold, lists or code. Both tools gain an optional `format`: `"text"` (default, unchanged output), `"markdown"` (GFM converted to ADF: paragraphs, headings, bold, italic, strikethrough, inline code, links, nested bullet and ordered lists, fenced code blocks, blockquotes, rules and tables, with newlines kept as line breaks and `[~accountid:<id>]` mentions still converted) or `"adf"` (a JSON string of a complete ADF document, sent unchanged after an outer-shape check that fails before any API call). The converter lives in `src/services/jira/markdown-to-adf.ts` and uses the `marked` lexer, a new dependency pinned to `18.1.1`. The two tools' descriptions now state the formats; `jira_transition_issue`'s comment and `jira_create_issue`'s description still take plain text only.
- **Jira: `adf` parameter on `jira_get_issues`** — Opt-in boolean that adds the raw ADF description to each returned issue as `descriptionAdf` (both `key` and `jql` modes), so a description can be appended to via `jira_update_issue` without flattening its structure. `description` stays plain text, the key is omitted when the issue has no description, and default output is unchanged.
- **Jira: `includeGithubPrs` and `includeSlackThreads` on `jira_get_issues`** — Opt-in booleans (both `key` and `jql` modes) that attach each returned issue's GitHub pull requests as `pullRequests` (`{number, title, state, repo, htmlUrl, reviewStatus}`, any state, the same search as `github_get_prs`, first 20 issues) and the Slack channel threads that mention it as `slackThreads` (`{permalink, channel, channelId, threadTs, at}`; up to 5 per issue, newest first, several matches in one thread collapsed into one link to the thread root (Slack's search matches name the thread only in their permalink), links only, direct messages excluded in the search itself (`-is:dm`) and again, with group messages and bots, after it; first 10 issues, one `search.messages` call each), so an agent gets the links without separate calls. An empty array means the lookup ran and found nothing; a missing key means it did not run. Never a failure: an integration that is not active, an API error or a capped lookup returns the issues unchanged and adds a `warnings: [{source, message}]` array beside `items` and `hasMore` (absent when empty), and a Slack search that fails for some issues only omits `slackThreads` on those. With neither flag set the response is byte-for-byte what it was. The Jira module now also receives the GitHub and Slack clients when those integrations are active; the Slack side is a new `findThreadsForIssueKey` in `src/services/slack/issue-threads.ts` and a `SlackClient.teamUrl()` that reads the stored workspace address without calling Slack.

- **GitHub: TAP keys also find PRs titled with the pre-rename TRIPS key** — Jira renamed project TRIPS to TAP (numbers carried over), but PR titles and branches created before the rename still say `TRIPS-n`. Given a `TAP-n` key, `github_get_prs` (`issueKey`, `keys`, `searchBranches`), `github_get_code_review_ready` and the `github://prs/{key}` resource now also match `TRIPS-n` in the same search, so results and pagination keep their shape. A `TRIPS-n` key searches only itself. `keys` runs two search terms per TAP key, so a full batch of 20 TAP keys issues up to 10 queries instead of 5.

### Changed

- **`mcp_get_health` reports `node`** — The health result gains `node`, the running `process.version` (for example `v26.13.1`), beside `serverVersion`.
- **`engine-strict` in `.npmrc`** — `npm ci` and `npm install` refuse a Node below the `engines.node` minimum.
- **Tool failures are `isError` results** — A tool that fails now returns a result with `isError: true` and one text item instead of a JSON-RPC error, so the model can read why. The text is unchanged: `API error (<status>): <detail>` for an upstream HTTP failure, or the handler's own message for a business rule (including Slack's `slack.<code>: …`). Resource and prompt failures stay protocol errors: `-32603` with the same detail text when the upstream call fails, `-32602` for an invalid issue key in a resource URI.
- **Unknown tool is `-32602`** — `tools/call` for an unregistered name is the SDK's `-32602` (was `-32601`). An unknown prompt or resource, and a prompt called without a required argument, are also `-32602`; a failing prompt is no longer reported as "Unknown prompt".
- **Schema validation by the SDK, with its wording** — Arguments are validated against each tool's zod schema before the handler runs (defaults applied, unknown keys dropped). A refused call is an `isError` result with the SDK's `Input validation error: …` text naming the field, replacing the server's own `Validation error:` wording. Cross-field rules (such as "Provide either transitionId or transitionName") keep their messages.
- **`tools/list` publishes the real input schemas** — Schemas are zod 4, and `tools/list` shows zod's JSON Schema (without a `$schema` key): integer versus number, minimum and maximum, defaults, string lengths, enums, array bounds, nested object properties and unions. `slack_prepare_write` `items` now shows three variants keyed by `action` (`post`, `react`, `upload`); the Slack batch tools show each item's properties. The hand-written converter and the Slack schema patch-ups are gone.
- **Bounds now published and enforced** — `jira_get_issues` and `jira_get_comments` `limit` is an integer from 1 to 100 (0, negative and fractional values, and anything over 100, are refused). The Slack batch caps are the arrays' `maxItems` (5 searches; 20 messages, threads or channels; 100 user ids; 10 write items), so an over-cap list is refused by input validation; `slack_get_users` with more than 20 items that are not all user ids still fails with `slack.batch_too_large`. Jira string bounds count code points (zod 4) rather than UTF-16 units. Item lengths on the Jira components and changelog-key arrays are published as `maxLength`.
- **`mcp_get_health` takes a strict empty object** — A call with any argument is an `isError` result. The server version in health and in the server info both come from `package.json`.
- **Node and dependencies** — `engines.node` is `>=24` and `.nvmrc` pins 26.13.1, the target. `@modelcontextprotocol/server` 2.4.0 and `zod` 4.6.7 (the copy the SDK resolves, so one zod is installed) are pinned exactly; `@modelcontextprotocol/client` 2.4.0 is a development dependency for tests. `axios` is pinned exactly to 1.21.1, and vitest's `vite` is set through `overrides`, clearing the `npm audit` advisories. `he` stays (the Confluence service uses it).
- **Jira: slimmer responses from `jira_get_comments`, `jira_get_attachment`, `jira_get_issues` and four lookup tools** — `jira_get_comments` returned Jira's raw comments (ADF body, `author` / `updateAuthor` with accountId, email and avatar URLs, `self` links, `jsdPublic`). It now returns `{items: [{id, author, created, updated, body, parentId?}], nextPageToken, hasMore}`: `author` is the display name, `body` is plain text, and `parentId` appears only on thread replies. A new optional `adf: true` adds each comment's raw ADF as `bodyAdf` for mentions and media. `jira_get_attachment` no longer returns files over 5 MiB (`MAX_INLINE_ATTACHMENT_BYTES`): it skips the download and returns `{id, filename, mimeType, size, issueKey, message}`; smaller files come back as before. `jira_get_issues` attachments drop the `content` and `thumbnail` URLs, and raw `custom` values lose their `self` and `avatarUrls` keys; `fields` still adds to the default set. `jira_whoami` returns `{accountId, displayName}`; `jira_search_users` returns `[{accountId, displayName, active?, emailAddress?}]`; `jira_list_transitions` returns `[{id, name, to}]`; `jira_list_issue_link_types` returns `[{id, name, inward, outward}]`. The `jira://myself` resource is slimmed with `jira_whoami`.
- **Jira: `jira_add_comment` / `jira_update_comment` descriptions steer callers to `format: "markdown"`** — they now say `text` makes the whole body one paragraph and that markdown is for headings, lists, bold and tables. The default stays `text`.
- **GitHub: smaller default responses** — `github_get_pr_files` returns only `{filename, status, additions, deletions, changes, previous_filename?}` per file; the diff is opt-in via `includePatch: true` (still capped at 2000 characters per file, with `truncated`). `github_update_pr` returns `{number, state, draft, title, htmlUrl, updatedAt, headBranch, baseBranch}` instead of the full pull request. The comment and review writes no longer echo what was just sent: `github_add_pr_comment` and `github_update_pr_comment` return `{id, htmlUrl}`, `github_create_pr_review_comment` and `github_update_pr_review_comment` return `{id, path, line, htmlUrl}`, and `github_submit_pr_review` returns `{id, state, htmlUrl}`. `github_get_file_contents` gains optional `startLine` / `endLine` (1-based, inclusive) that return just those lines plus `totalLines`.
- **Figma: bounded trees and slimmer lists** — `figma_get_file` and `figma_get_nodes` apply a default depth of 2 (new optional `depth` on `figma_get_nodes`); pass a larger `depth` for deeper trees. `figma_get_file` no longer replaces `document` with a truncation marker when `depth` is omitted, which also fixes `ids` without `depth` returning no nodes. `figma_get_comments`, `figma_post_comment`, `figma_get_styles` and `figma_get_versions` drop avatar, thumbnail, `file_key` and position metadata; comments keep `node_id` and users reduce to `{id, handle}`.
- **Jenkins: `jenkins_get_console` accepts `tail: true`** — returns the last `limit` lines of the log; it cannot be combined with `cursor`.
- **Jira: `jira_add_comment` / `jira_update_comment` return a small acknowledgement** — They used to return Jira's whole comment object: the ADF body just sent, `author` / `updateAuthor` with accountId, email address and four avatar URLs, and `self` URLs. They now return `{id, key, created, updated, author, url}`: `author` is the display name, `url` is `<JIRA_BASE_URL>/browse/<KEY>?focusedCommentId=<id>`, and the body, email, accountId, avatars and `self` links are no longer echoed. `JiraClient.addComment` / `updateComment` return this shape (new `toCommentAck` in `src/services/slim.ts`); `jira_get_comments` output is unchanged.
- **Slack: default attachment discovery on message reads** — `slack_get_messages` (history or exact message), `slack_get_threads` and `slack_search_messages` now return `hasAttachments` on every message, plus ordered `attachments: [{file_id, name?, size?, type?}]` when Slack supplies usable file IDs; `type` is Slack's MIME type and zero-byte sizes are retained. No-file and link-unfurl-only messages gain only false; supplied file records with no usable IDs give true with no metadata. A returned `file_id` feeds the existing `slack_download_file` directly, without extra read requests, scopes, tools or a new `fields` option. Text, author names and profile emails stay opt-in; filenames are default user-controlled metadata, not sanitized content. Raw file objects, contents/previews, file URLs, credentials and headers are excluded from the projection. Download eligibility, login and local-basename rules are unchanged; live attachment availability and browser-session downloads remain human-unverified.
- **`slack_get_status` reports `dashboard_session_available`** — `not_connected` now says whether a dev-dashboard web session is there to adopt, and its step names `slack_login` instead of the app config file when one is. A connected adopted session omits `scopes_missing`, because a web session has no granted-scope list.
- **`slack_logout` on an adopted session only removes the copy** — Slack has no revoke endpoint for a web session, so `revoked` is `false` and `~/.config/slack/session.json` is left untouched; an app token is revoked as before.
- **`mcp_get_health` reports `slack`** — The `integrations` object gains a `slack` boolean beside `jira`, `github`, `figma`, `confluence` and `jenkins`. `createHealthHandler` takes it as an optional sixth parameter defaulting to `false`.
- **Jira: `fields` descriptions on `jira_create_issue` / `jira_update_issue`** — no longer describe Product | Feature Group | Feature as optional or tell agents to omit it; they point to the `components` param instead. The SECURITY note and "leave existing values untouched on unrelated updates" stay.
- **Jira: `fields` is optional on `jira_update_issue`** — Changing only components no longer needs `fields: {}`: pass `components` alone. A call with neither `fields` nor `components` is rejected with "Provide fields and/or components" before any API call; an explicit `fields: {}` is still accepted as before. The `fields` description drops the "pass {} when only changing components" hint.
- **GitHub: `findPrsForIssueKeys` throws when every search fails** — It used to answer an outage or a rejected token with an empty result, which `github_get_prs`, `github_get_code_review_ready` and the new `includeGithubPrs` flag all read as "no PRs". A search chunk that fails while others succeed is still tolerated, leaving only its keys without PRs.
- **GitHub: `github_get_code_review_ready` default `project`** — now `TAP` (was `TRIPS`). Jira JQL still resolves the old key, so passing `TRIPS` keeps working.

### Removed

- **`MCP_TRANSPORT` and `MCP_PORT`** — They selected nothing (both branches used stdio) and are ignored if set. The server is stdio only; `MCP_LOG_LEVEL` is the only server setting.
- **`@modelcontextprotocol/sdk`** (v1) — replaced by `@modelcontextprotocol/server`.

### Fixed

- **Tool replies survive a client that closes stdin before reading** — On shutdown the server waits, up to 3 seconds, for queued stdout to reach the reader before it exits, so a reply is no longer truncated when the client closes stdin first.
- **GitHub: list tools no longer drop or repeat items when paging** — `github_get_pr_comments`, `github_list_branches`, `github_get_pr_files`, `github_get_pr_commits`, `github_get_pr_review_comments` and `github_search_prs` asked GitHub for `limit + 1` rows to detect a next page. At `limit` 100 that is `per_page=101`, which GitHub caps at 100, so `hasMore` never turned true and everything past row 100 was lost; at any other limit the next page started one row late. They now request exactly `limit` and take `hasMore` from GitHub's `Link rel="next"` header. Cursors are still the next page number. `github_get_prs` with `issueKey` also never reported `hasMore`; it now does.
- **GitHub: `github_get_pr_reviews` is paginated** — it returned only GitHub's first 30 reviews. It now takes `limit` (default 20, max 100) and `cursor` and returns `{items, nextPageToken?, hasMore}` instead of a bare array. The approval checks behind `github_get_code_review_ready` and the review status in `github_get_prs` now read every review page (up to 1,000).
- **GitHub: `github_search_prs` no longer returns a placeholder `reviewStatus`** — every item carried `REVIEW_REQUIRED` whatever its real state. The field is removed from this tool's items; `github_get_prs` and `jira_get_issues` with `includeGithubPrs` still return real values.

## [0.3.0] — 2026-07-30

### Added

- **GitHub: diff reading tools** (`github_get_pr_files`, `github_get_pr_commits`, `github_get_file_contents`) — Review PRs via MCP with no local worktree. Per-file patches with truncation, decoded file contents with size guard, commit list with SHAs and messages.
- **GitHub: review lifecycle** — Full PR management surface:
  - `github_get_pr_review_threads`, `github_resolve_review_thread`, `github_unresolve_review_thread` — GraphQL-powered review thread tracking (query + resolve/unresolve mutations). Eliminates agent repeating comments on resolved threads.
  - `github_merge_pr` — Merges a PR with merge method and optional SHA guard. Surfaces 405/409 clearly.
  - `github_request_pr_reviewers` — Add/remove individual and team reviewers.
  - `github_update_pr_labels`, `github_update_pr_assignees` — Replace labels and assignees on a PR.
  - `github_dismiss_pr_review` — Dismiss a stale review blocking merge.
  - `github_delete_pr_issue_comment` — Delete an issue-level PR comment.
- **GitHub: search filter expansion** — `github_search_prs` now supports `label`, `reviewRequested`, and `base` filters.
- **GitHub: PullRequestDetail expansion** — `requestedReviewers`, `requestedTeams`, `labels`, `assignees` now included in PR details.
- **Jira: exposed capabilities** — `jira_get_comments`, `jira_list_transitions`, `jira_list_issue_link_types`, `jira_search_users`, `jira_delete_comment` (previously unreachable client methods).
- **Confluence: `confluence_whoami`** — verify credentials.
- **Figma: expansion** — `depth`, `ids`, `geometry`, `version` params on `figma_get_file`; `figma_post_comment` for design feedback loop.
- **`SlimComment.id`** — comment ID now available (fixes `jira_update_comment`).
- **Shared retry helper** (`src/services/http-retry.ts`) — deduplicated from 4 near-identical copies. Fixed: 403 with `retry-after` honoured, socket errors retried, write methods only retried on errors with no response.
- **Test coverage** — New test files: `jira-client.test.ts`, `figma-client.test.ts`, `slim.test.ts`, `config.test.ts`, `helpers.test.ts`. Test count: 362 → 581.

### Fixed

- **C2: `zodToJsonSchema` unwraps all `ZodEffects` layers** — multi-refine schemas (e.g. `githubCreatePrReviewCommentSchema`) now advertise their full parameter sets. Added invariant test across all module descriptors.
- **C1: `searchBranches: true`** — fixed `/pulls` response parsing (was reading absent fields).
- **C3: `github_get_prs` cursor** — cursors now honoured; results past `limit` are reachable.
- **C4: `dotenv` config** — `override: true` dropped; host-supplied credentials always win.
- **H2: pagination `hasMore`** — all list handlers use `limit + 1` probe instead of `length >= limit` (phantom page on exactly-full last page).
- **H3: `searchPrs` limit** — passes `limit` as `maxResults` instead of fanning out review-status requests for all matched PRs.
- **H4: repo validation** — per-segment `.`/`..` rejection added to `assertRepo` (defence-in-depth).
- **H5: Confluence envelope** — responses mapped to `{items, nextPageToken?, hasMore}`.
- **H6: `jira_get_issues` shape** — always returns `SlimIssue` regardless of `fields` param.
- **H7: Jira pagination** — `isLast` honoured alongside `nextPageToken`.
- **H8: JQL blocklist** — false-positive-blocking validateJql removed.
- **H9: branch search cap** — counter decremented before each request; `continue` not `break`; per-repo budget.
- **M1-M10: misc robustness** — branch refs cache TTL, attachment size guard, fetchAllPages truncation signal, Jenkins healthcheck single-fetch, cursor NaN rejection, Figma timeout/retry/truncation, error-reporting adoption, resource handler URI-scheme dispatch, env-var validation.
- **S1-S5: config/safety** — Jira token removed from McpConfig, `MCP_TRANSPORT` validation, `GH_REPOS` constructor read, Figma error truncation, Jira resource URI validation.
- **D1/D2 deduplication** — `assertRepo()`, `repoField` Zod schema, `mapPullRequestDetail()`, shared `installRetry()`, shared issue-key pattern.

### Changed

- `github_create_pr_review_comment` now correctly advertises all parameters (including `inReplyTo`) via MCP descriptors.
- Confluence `baseUrl` normalization in `loadConfluenceConfig` is now tested.
- Resource handlers dispatched by URI scheme instead of try-all loop.
- `PullRequestDetail` returned by `getPullRequest` and `updatePullRequest` are shape-identical.

## [0.2.0] — 2026-06-29

### Added

- **Figma integration**: 8 new MCP tools for design file access
  - `figma_get_me` — authenticated user profile
  - `figma_get_file` — file overview (pages, metadata)
  - `figma_get_nodes` — inspect specific design nodes
  - `figma_get_images` — export frames as image URLs
  - `figma_get_comments` — read design comments
  - `figma_get_styles` — list colors, text styles, effects
  - `figma_get_variables` — list design token collections
  - `figma_get_versions` — version history
  - Configuration: `FIGMA_TOKEN` env var (personal access token)
  - Auth: `X-Figma-Token` header
  - New files: `src/services/figma/figma-client.ts`, `src/integrations/figma/`

## [0.2.0] — 2026-06-23

### Added

- **GitHub: create PR tool** (`github_create_pr`) — Create pull requests on any repository via `POST /repos/{repo}/pulls`. Parameters: `repo`, `title`, `head`, `base`, `body`, `draft`.
- **GitHub: list branches tool** (`github_list_branches`) — List git branches for a repository via `GET /repos/{repo}/branches`. Returns `{ name, sha, protected }[]`. Cursor-based pagination using page number.
- **GitHub: branch-name PR search** — `github_get_prs` now supports `searchBranches: boolean` parameter that enumerates git refs, filters by issue key, and finds open PRs from matching branches. Results are merged with title/body search (deduplicated).
- **GitHub: functional `state` parameter** — `github_get_prs` now passes `state` (`open`/`closed`/`all`) to all search methods. Default remains `open`.
- **Configurable `GH_REPOS`** — `GH_REPOS` env var (comma-separated) controls which repos are searched, with fallback to `TransActComm/TravelTracker`, `TransActComm/Portage-backend`, `TransActComm/Portage-frontend`.

### jira-cli library

- **`createPullRequest()`** — POST /repos/{repo}/pulls, returns `PrCreated` (`{ number, htmlUrl, state }`).
- **`listBranches()`** — GET /repos/{repo}/branches, returns `BranchInfo[]` (`{ name, sha, protected }`).
- **`searchPrsByBranchName()`** — Enumerates git refs, filters by issue key, finds open PRs from matching branches. Features branch refs caching and API call budget (max 20 calls) to prevent rate-limit amplification.
- **`state` parameter** — Added to `searchPrs()`, `findPrsForIssueKeys()`, and `searchPrsByBranchName()`.
- **GitHub pagination** — `fetchAllPages()` follows GitHub Link headers (`rel="next"`) with a max 5 page cap, used by `searchPrs()` and `findPrsForIssueKeys()`.
- **New exported types** — `PrCreated` (`number`, `htmlUrl`, `state`) and `BranchInfo` (`name`, `sha`, `protected`).
- **Input validation** — Repo format validation (`owner/name`), issue key format validation (`PROJECT-123`), and query sanitization for `findPrsForIssueKeys()`.

### Changed

- GitHub module: 1 tool → 3 tools (conditional on `GH_TOKEN`).
- `github_get_prs` now returns PRs from title/body search AND optionally from branch-name matching.
- `github_get_prs` now respects the `state` parameter (previously hardcoded to `open`).

### Code Reviews

- [Phase 2 Implementation Review](docs/code-review/phase2-github-review.md)

## [0.1.0] — 2026-06-23

### Added

- **MCP Server foundation** (`src/mcp-server.ts`) — central MCP server with stdio transport, module registry, and central dispatch for tools/resources/prompts. Starts with graceful degradation when no env vars are set.
- **Jira integration module** (`src/integrations/jira/`) — 8 tools, 3 resources, 2 prompts, registered when `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN` are all set:
  - Tools: `jira_whoami`, `jira_get_issues`, `jira_create_issue`, `jira_update_issue`, `jira_transition_issue`, `jira_assign_issue`, `jira_add_comment`, `jira_link_issues`
  - Resources: `jira://issue/{key}`, `jira://search/{jql}`, `jira://myself`
  - Prompts: `create-issue`, `triage-issue`
- **GitHub integration module** (`src/integrations/github/`) — 1 tool, 1 resource, registered when `GH_TOKEN` is set:
  - Tool: `github_get_prs` (polymorphic: single `issueKey` or batched `keys`)
  - Resource: `github://prs/{issueKey}`
- **Built-in health tool** (`src/mcp-health.ts`) — `mcp_get_health` always registered, reports `jira`/`github` boolean status.
- **Module registry** (`src/integrations/index.ts`) — `IntegrationModule` interface with DI pattern: `createToolHandlers`, `getToolDescriptors`, optional `getResourceHandler`/`getPromptHandler`.
- **Safe bootstrap** (`src/mcp-config.ts`) — wraps `loadConfig()` in try/catch so missing Jira env vars don't crash GitHub-only operation.
- **Pagination helpers** (`src/integrations/helpers.ts`) — `PaginatedResponse<T>` shape, `paginated()` factory, `zodToJsonSchema()` for MCP schema generation.
- **Test suite** — 93 tests across 8 test files (vitest). All tool handlers testable via DI with mock clients.
- **Configuration** — `.env.example` with docs for `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `GH_TOKEN`, `MCP_TRANSPORT`, `MCP_PORT`, `MCP_LOG_LEVEL`.
- **Scripts** — `npm run mcp`, `npm run mcp:prod`, `npm run mcp:inspect`, `npm run build`, `npm run typecheck`, `npm run test`, `npm run test:watch`.

### Architecture

- **Module-based integration hub** — each external tool is a self-contained `IntegrationModule`. Adding a new module requires creating `src/integrations/<name>/` and registering it in the module registry.
- **Dependency injection** — tool handlers receive client instances (`JiraClient`, `GitHubClient`) rather than constructing them. Enables unit testing without real credentials.
- **Conditional registration** — tools are only registered when their required env vars are present. No env var = no tool for that domain.
- **Central dispatch** — single `CallToolRequestSchema` handler dispatches to registered handlers by tool name. Single `ReadResourceRequestSchema` handler tries all resource handlers.
- **Polymorphic tools** — `jira_get_issues` accepts `key` (single issue) or `jql` (search); both return `PaginatedResponse<SlimIssue>` for a consistent shape.
- **Slim-by-default** — all tools return slim data shapes. `fields?: string[]` parameter allows agents to request specific fields beyond defaults.
- **JSON serialization** — single-line (no pretty-printing), `undefined` values stripped.

### Code Reviews

- [Plan Review](docs/code-review/jira-cli-mcp-server-plan-review.md)
- [Phase 1 Implementation Review](docs/code-review/phase1-mcp-implementation-review.md)
