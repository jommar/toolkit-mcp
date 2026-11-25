# toolkit-mcp

**Dev Workflow MCP Hub** — bridges AI coding agents with Jira, GitHub, and more via the [Model Context Protocol](https://modelcontextprotocol.io).

An MCP server that exposes developer toolchain operations (Jira issue management, GitHub PR search, and more) as MCP tools, resources, and prompts for AI coding agents. AI IDEs and coding assistants auto-discover and use these tools through the MCP protocol — no manual CLI commands or context-switching required.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 MCP Transport Layer (stdio)           │
│  ┌─────────────────────────────────────────────────┐ │
│  │                 MCP Server                       │ │
│  │               (central dispatch)                 │ │
│  └──────┬─────────────────────────────┬────────────┘ │
│         │                             │               │
│  ┌──────┴──────┐    ┌─────────┴──────────┐   ┌─────────┴──────────┐   ┌─────────┴──────────┐   │
│  │  Jira Module │    │  GitHub Module     │   │  Figma Module      │   │  Slack Module      │   │
│  │  8 tools     │    │  30 tools          │   │  8 tools           │   │  11 tools          │   │
│  │  3 resources │    │  1 resource        │   │                    │   │  (SLACK_ENABLED)   │   │
│  │  2 prompts   │    │                    │   │                    │   │                    │   │
│  └──────┬──────┘    └─────────┬──────────┘   └─────────┬──────────┘   └─────────┬──────────┘   │
│         │                             │               │
│  ┌──────┴─────────────────────────────┴──────────┐   │
│  │       Service Layer: src/services/               │   │
│  │  JiraClient │ GitHubClient │ SlackClient │ slim │ config  │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

The server is organized as a **module-based integration hub**. Each external tool (Jira, GitHub, etc.) is a self-contained integration module that registers its capabilities only when its required environment variables are present. The **built-in `mcp_get_health` tool** is always registered.

For the full architecture breakdown, see [`docs/plans/01-jira-cli-mcp-server.md`](docs/plans/01-jira-cli-mcp-server.md).

---

## Quick Start

Requires Node 24 or later; `.nvmrc` pins the target, 26.13.1.

```bash
cd toolkit-mcp
cp .env.example .env
npm ci
npm run mcp              # start the MCP server (stdio)
```

The server is built on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0) and serves stdio only. One process answers both protocol eras: a client that sends `initialize` for 2025-11-25 or an older revision, and a 2026-07-28 client that sends the per-request protocol envelope. Tools are conditionally registered based on your `.env` values — see [Configuration](#configuration).

After pulling a version with changed dependencies, run `npm ci` before restarting the MCP client, or the server fails at import.

---

## Configuration

All variables are optional — tools only register if their required env vars are present.

| Variable | Integration | Required for |
|---|---|---|
| `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN` | Jira | All Jira tools, resources, and prompts |
| `GH_TOKEN` | GitHub | All 30 GitHub tools and `github://prs/{issueKey}` resource |
| `GH_REPOS` | GitHub | Comma-separated repo list for GitHub searches (default: `TransActComm/TravelTracker,TransActComm/Portage-backend,TransActComm/Portage-frontend`) |
| `FIGMA_TOKEN` | Figma | All Figma tools |
| `JENKINS_URL` + `JENKINS_USER` + `JENKINS_TOKEN` | Jenkins | All Jenkins tools (API token preferred over a password) |
| `SLACK_ENABLED` | Slack | All 11 Slack tools, when set to exactly `true`. `slack_login` adopts the Slack web session dev-dashboard captured in `~/.config/slack/session.json`; without one, the Slack app's client id is read from `~/.config/slack/toolkit-mcp/app.json`, not the environment — see [`docs/slack.md`](docs/slack.md) |
| `MCP_LOG_LEVEL` | Server | Log verbosity on stderr: `silent` (nothing), `info` (default: startup and registration lines), or `debug` (adds one line per tool call with the tool name, `ok` or `error`, and the duration; never arguments or results) |

Full `.env.example` in the project root. If no integration env vars are set, the server starts with only the `mcp_get_health` tool — graceful degradation.

---

## Tools

Tools are grouped by integration; all are conditional except the built-in `mcp_get_health`, which is always registered.

### Jira Tools (registered when `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN` are set)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_whoami` | Return the authenticated Jira user profile. | *(none)* |
| `jira_get_issues` | Fetch one or more Jira issues. Pass `key` for a single issue, or `jql` to search. | `key`, `jql`, `limit`, `cursor`, `fields`, `adf`, `includeGithubPrs`, `includeSlackThreads` (see [Linked pull requests and Slack threads](#linked-pull-requests-and-slack-threads)) |
| `jira_get_changelogs` | Get changelog entries for one or more Jira issues, newest first, grouped by issue key (e.g. `["PROJ-1", "EXAMPLE-1"]`). | `keys` (1–20), `limit` (per issue, default 20), `cursor` (single-key only), `fields`, `maxValueChars` (default 200; `0` = unlimited) |
| `jira_list_components` | List a Jira project's components (id, name) — use to find valid names for the Components field. | `projectKey` |
| `jira_create_issue` | Create a new Jira issue in a project. | `projectKey`, `issueType`, `summary`, `description`, `fields`, `components` |
| `jira_update_issue` | Update fields on an existing Jira issue. | `key`, `fields` and/or `components` |
| `jira_transition_issue` | Transition a Jira issue to a new status. | `key`, `transitionId` or `transitionName`, `comment` |
| `jira_assign_issue` | Assign a Jira issue to a user or unassign it. | `key`, `assignee` (accountId, "me", or "none") |
| `jira_add_comment` | Add a comment to a Jira issue — plain text by default, or rich text through `format` (see [Jira comment formats](#jira-comment-formats)). | `key`, `body`, `format`, `parentId` |
| `jira_update_comment` | Update an existing comment on a Jira issue — plain text by default, or rich text through `format` (see [Jira comment formats](#jira-comment-formats)). | `key`, `commentId`, `body`, `format` |
| `jira_link_issues` | Link two Jira issues together. | `inwardKey`, `outwardKey`, `type`, `comment` |

#### Linked pull requests and Slack threads

`jira_get_issues` can attach, to each issue it returns, the GitHub pull requests and the Slack threads that mention it, so the links come back in the same response (both `key` and `jql` modes). Both flags default to off, and with neither set the response is unchanged.

| Flag | Adds to each issue | Looked up for |
|---|---|---|
| `includeGithubPrs` | `pullRequests`: `{number, title, state, repo, htmlUrl, reviewStatus}` for every PR (open, closed and merged) that names the issue key, found with the same search as `github_get_prs` (a TAP key also finds PRs still titled with the pre-rename TRIPS key) | the first 20 issues |
| `includeSlackThreads` | `slackThreads`: up to 5 `{permalink, channel, channelId, threadTs, at}`, newest match first. `permalink` points at the thread root; several matches in one thread collapse into one entry, and `at` is the newest matching message. Links only, never message text. Channels only: direct and group messages and bot messages are left out | the first 10 issues (one Slack search each) |

An empty array means the lookup ran and found nothing; a missing key means it did not run. When a lookup does not run, or fails, the issues are still returned and the envelope gains a `warnings` array (absent otherwise): an integration that is not active (`GH_TOKEN` unset; `SLACK_ENABLED` not `true`, or no `slack_login` session), an API error on that lookup, or a lookup limited to the first N issues. A Slack search that fails for some issues leaves `slackThreads` off just those issues, and the GitHub lookup, the Slack lookups of the other issues and the issues themselves are unaffected.

```json
{
  "items": [
    {
      "key": "TAP-1234",
      "summary": "Example summary",
      "pullRequests": [
        {"number": 87, "title": "TAP-1234 Example change", "state": "merged", "repo": "example-org/example-repo", "htmlUrl": "https://github.com/example-org/example-repo/pull/87", "reviewStatus": "APPROVED"}
      ],
      "slackThreads": [
        {"permalink": "https://example-team.slack.com/archives/C0EXAMPLE01/p1700000000000100", "channel": "example-room", "channelId": "C0EXAMPLE01", "threadTs": "1700000000.000100", "at": "2023-11-14T22:14:10.000Z"}
      ]
    }
  ],
  "hasMore": false,
  "warnings": [{"source": "slack", "message": "Slack lookup was limited to the first 10 of 12 issues."}]
}
```

#### Jira comment formats

`jira_add_comment` and `jira_update_comment` take an optional `format` that says how `body` is read:

| `format` | `body` is | Result |
|---|---|---|
| `text` (default) | Plain text | One ADF paragraph, exactly as before; only `[~accountid:<id>]` tokens become mentions. Markdown syntax is not interpreted. |
| `markdown` | Markdown (GFM) | Converted to ADF: paragraphs, headings, **bold**, *italic*, ~~strikethrough~~, `inline code`, links, bullet and ordered lists (nestable), fenced code blocks (with language), blockquotes, horizontal rules and pipe tables (header row becomes header cells). A single newline inside a paragraph is a line break, and `[~accountid:<id>]` tokens still become mentions in paragraphs, headings, list items and table cells. |
| `adf` | A JSON string of a complete ADF document | Sent unchanged, with no mention conversion; the escape hatch for colours, status lozenges and panels. Only the outer shape is checked (`type: "doc"`, `version: 1`, `content` an array) and a bad document is rejected before any API call. |

```json
{"key":"TAP-1","format":"markdown","body":"**Result:** 2 pass\n\n| AC | Result |\n|---|---|\n| AC1 | PASS |\n| AC2 | NOT VERIFIED |"}
```

Markdown limits: images become links to their source, relative links are kept as plain text, task-list items stay bullets that start with `[ ]` or `[x]`, column alignment and raw HTML are not converted (HTML is kept as literal text, except `<br>`, which is a line break), and a heading, rule or table nested in a list item or blockquote is kept as a literal paragraph. Mentions cannot carry formatting, so a mention inside bold text is plain. Use `text` when a body should stay literal.

### GitHub Tools (registered when `GH_TOKEN` is set)

| Tool | Description | Key Parameters |
|---|---|---|
| `github_get_code_review_ready` | Fetch Jira tickets in a given status (default "Ready For Code Review") and report which have every PR approved by a human (bot and author approvals ignored). | `status`, `project`, `assignee`, `prState` |
| `github_get_prs` | Find pull requests for one or more issue keys. Supports title/body search and optional branch-name matching. | `issueKey`, `keys`, `state`, `limit`, `cursor`, `searchBranches` |
| `github_get_copilot_unresolved_prs` | List PRs with full originating comment bodies from every unresolved Copilot-started review thread. | `repo` (required), `prNumbers`, `state`, `limit`, `cursor` |
| `github_create_pr` | Create a pull request on GitHub. | `repo`, `title`, `head`, `base`, `body`, `draft` |
| `github_add_pr_comment` | Add an issue-level comment to a pull request. | `repo`, `prNumber`, `body` |
| `github_get_pr_comments` | List issue-level (conversation) comments on a pull request. | `repo`, `prNumber`, `limit`, `cursor` |
| `github_update_pr_comment` | Update an existing issue-level comment on a pull request by comment ID. | `repo`, `commentId`, `body` |
| `github_list_branches` | List branches for a repository. | `repo`, `limit`, `cursor` |
| `github_get_pr_details` | Get full PR details (body, files changed, additions/deletions, mergeable state, base/head branches) by repo + PR number. | `repo`, `prNumber` |
| `github_get_pr_reviews` | Get PR review comments and review thread summaries. | `repo`, `prNumber` |
| `github_get_pr_checks` | Get PR status check / CI results (check-runs for the latest commit on the PR). | `repo`, `prNumber` |
| `github_update_pr` | Update an existing pull request (title, body, state, base branch, or maintainer settings). | `repo`, `prNumber`, `title`, `body`, `state`, `base`, `maintainerCanModify` |
| `github_search_prs` | Flexible PR search by author, repo, state, or free-text query. Provide at least one of `query`, `author`, or `repo`. | `query`, `author`, `repo`, `state`, `limit`, `cursor` |

#### PRs with unresolved Copilot review threads

`github_get_copilot_unresolved_prs` returns **`{ repo, prNumber, comments: string[] }`**, with the full originating comment body from **every unresolved review thread started by Copilot**. All review-thread pages are inspected to collect these comments. Resolved threads never contribute comments: a PR with only resolved Copilot threads is excluded. Outdated threads still qualify if unresolved; replies and human-started threads are excluded. PR metadata is limited to `repo` and `prNumber`, with no titles, counts, or links.

- `repo` is required in `owner/name` format.
- Omit `prNumbers` to discover PRs authored by the current authenticated GitHub user; pass `[]` to discover PRs from all authors.
- Pass a nonempty `prNumbers` list to inspect those PRs regardless of author or state; duplicates are ignored. Numbers must be positive integers up to `2147483647`.
- Discovery `state` defaults to `open`; `closed` includes merged PRs, and `all` includes every state. Explicit PR numbers ignore this filter.
- `limit` is an integer from 1 to 100 (default 20) and bounds **candidate PRs scanned**, not matches returned. Discovery scans a repository page before filtering by author, so even `items: []` can have `hasMore: true`.
- Pass `nextPageToken` back unchanged as `cursor` to continue, retaining the same repository, selection mode/list/order, discovery state and limit. Omitted-number discovery also requires the same authenticated user. Cursors are opaque scope-bound tokens; stop when `hasMore` is false, at which point `nextPageToken` is absent.

Example request and completed response:

```json
{"repo":"Org/Repo","prNumbers":[42,43]}
```

```json
{"items":[{"repo":"Org/Repo","prNumber":42,"comments":["Handle the empty response before reading its first item.","Add a test for the retry limit."]}],"hasMore":false}
```

If a PR's threads cannot be inspected, successful PR results with their comments remain in `items` and an optional compact `errors` array identifies failures, for example `[{"repo":"Org/Repo","prNumber":43,"error":"Unable to inspect review threads."}]`. A failed inspection is not a confirmed nonmatch. Discovery or authenticated-user lookup failures fail the tool call.

### Figma Tools (registered when `FIGMA_TOKEN` is set)

| Tool | Description | Key Parameters |
|---|---|---|
| `figma_get_me` | Return the authenticated Figma user profile. | *(none)* |
| `figma_get_file` | Get a Figma file overview (name, pages, last modified). | `fileKey` |
| `figma_get_nodes` | Inspect specific nodes/design elements by ID. | `fileKey`, `ids` |
| `figma_get_images` | Export frames as PNG/SVG/PDF image URLs. | `fileKey`, `ids`, `format`, `scale` |
| `figma_get_comments` | Read design comments on a file. | `fileKey` |
| `figma_get_styles` | List colors, text styles, and effects. | `fileKey` |
| `figma_get_variables` | List design tokens and variable collections. | `fileKey` |
| `figma_get_versions` | List version history for a file. | `fileKey` |

### Jenkins Tools (registered when `JENKINS_URL` + `JENKINS_USER` + `JENKINS_TOKEN` are set)

Read-only. All list tools return the paginated response shape (`items`, `nextPageToken`, `hasMore`); pass the returned `nextPageToken` back as `cursor` for the next page.

| Tool | Description | Key Parameters |
|---|---|---|
| `jenkins_get_jobs` | List Jenkins jobs with their current build status. | `limit`, `cursor` |
| `jenkins_get_builds` | List recent builds for a job (newest first), paginated. | `job`, `limit`, `cursor` |
| `jenkins_get_build` | Get details for a single build; omit `buildNumber` for the most recent. | `job`, `buildNumber` |
| `jenkins_get_console` | Get a build console log, paginated by line; omit `buildNumber` for the most recent. | `job`, `buildNumber`, `limit`, `cursor` |
| `jenkins_healthcheck` | Report whether the last build of each requested job succeeded; omit `jobs` to check all visible jobs. | `jobs` |

### Slack Tools (registered when `SLACK_ENABLED=true`)

Eleven tools that read Slack as you, download a file to a path you choose and, behind a preview-then-confirm gate, post, react and upload. Login takes the shortest route available: if dev-dashboard has captured your Slack web session in `~/.config/slack/session.json`, `slack_login` adopts it and no Slack app is needed; otherwise create the app from the shipped manifest `docs/slack-app-manifest.json`, write the one-time config file and log in by link. Both routes, every limit and every error code are in [`docs/slack.md`](docs/slack.md). Every read tool and `slack_prepare_write` takes an array of 1 to n items and returns one result per item; `slack_download_file` takes one file per call.

| Tool | Description | Key Parameters |
|---|---|---|
| `slack_login` | Connect: adopt the dev-dashboard web session when there is one, otherwise return a link to open in your own browser or finish a login from the pasted redirect address. | `workspace`, `redirected_url` |
| `slack_logout` | Revoke an app token at Slack and remove the stored login; an adopted web session is only removed locally. | `revoke` |
| `slack_get_status` | Report the connection state with the next step, and whether a dev-dashboard session is available. | `verify` |
| `slack_search_messages` | Search messages, newest first, with default file metadata and `hasAttachments`. | `queries[]` (`query`, `exact_phrases`, `in_channels`, `from_users`, `after`, `before`), `fields`, `limit` |
| `slack_get_messages` | Read one message, or a conversation's history, with default file metadata and `hasAttachments`. | `messages[]` (`message` or `channel`), `fields`, `limit` |
| `slack_get_threads` | Read threads by message, reply or thread link, with default file metadata and `hasAttachments`. | `threads[]`, `fields`, `limit` |
| `slack_get_channels` | Look up channels by id, link, name or membership. | `channels[]`, `limit` |
| `slack_get_users` | Look up users by id, link, name, channel members or `me`. | `users[]`, `fields`, `limit` |
| `slack_download_file` | Save one Slack file (by a read's `attachments[].file_id` or a file link) to an absolute path you choose and return its path, name, size, type and sha256, never its contents; an app login needs `files:read`. | `file`, `path`, `overwrite` |
| `slack_prepare_write` | Preview up to 10 posts, reactions or file uploads and get one confirmation token. | `items[]` (`action`, `destination`, `text`, `path`, `emoji`) |
| `slack_confirm_write` | Send exactly what was previewed under that token. | `confirmation_token` |

Every message has `hasAttachments` by default, plus `attachments: [{file_id, name?, size?, type?}]` when Slack supplies usable file IDs; `type` is Slack's MIME type. No-file or link-unfurl-only messages return false with no `attachments`; supplied file records with no usable IDs return true but no metadata. These response keys are independent of `fields` and require no extra read requests, scopes or tools; pass a returned `file_id` directly as `slack_download_file.file`. Read metadata never includes raw file objects, contents/previews or file URLs. File names are default, user-controlled metadata, not sanitized content; message text, author names and profile emails remain omitted unless asked for through `fields` (email only on `slack_get_users`). See the guide's [privacy defaults](docs/slack.md#fields-and-privacy-defaults) and [discovery-to-download example](docs/slack.md#downloading-a-file).

Slack's list-shaped results do not use the single envelope below: each input item gets its own result with its own `nextPageToken`, and a continuation is a new item holding only `{cursor}`.

### Built-in (always registered)

| Tool | Description | Key Parameters |
|---|---|---|
| `mcp_get_health` | Report which integrations are active (`jira`, `github`, `figma`, `confluence`, `jenkins`, `slack`). | *(none)* |

### Paginated Response Shape

All list-style tools return a uniform envelope:

```json
{
  "items": [],
  "nextPageToken": "opaque-cursor-or-null",
  "hasMore": true
}
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cursor` | string | — | Opaque pagination token from a previous response |
| `limit` | integer | 20 | Items per page (1 to 100) |

- `jira_get_issues` with `key` always returns a one-item `PaginatedResponse` with `hasMore: false` — consistent shape regardless of input mode.
- `jira_get_changelogs` accepts 1–20 issue `keys` (e.g. `["PROJ-1", "EXAMPLE-1"]`) and returns a grouped per-issue envelope `{ items: [{ key, total, changelogs, hasMore, nextPageToken? }], warnings?: [{ key, message }] }` (`warnings` omitted when empty). `limit` applies per issue, and `cursor` is supported on single-key requests only.
- `jira_get_issues` accepts `includeGithubPrs` and `includeSlackThreads` to attach linked pull requests and Slack threads to each issue; a lookup that is limited, unavailable or fails adds a `warnings` array (`{source, message}`) beside `items` and `hasMore` instead of failing the call. Details in [Linked pull requests and Slack threads](#linked-pull-requests-and-slack-threads).
- `jira_get_issues` flattens `description` to plain text; pass `adf: true` to also get the raw ADF document as `descriptionAdf` (omitted when the issue has no description), e.g. to append to a description via `jira_update_issue` without losing its structure.
- `jira_create_issue` / `jira_update_issue` take `components` as names (case-insensitive), resolved to ids against `jira_list_components`; an unknown name is rejected with the project's valid names. On update it replaces the issue's components, and omitting it leaves them untouched; `fields` is optional there when `components` is given, but a call with neither is rejected. `jira_list_components` returns every component in one page (`hasMore: false`).
- `github_get_copilot_unresolved_prs` limits candidate PRs rather than matches; sparse or empty pages may still have `hasMore: true`.
- The Slack read tools are the one exception to the single envelope and to a top-level `cursor`: they return `{results, truncated}` with one entry per input item, each carrying its own `items`, `hasMore` and `nextPageToken`, and a continuation is an item holding only `{cursor}`. Details in [`docs/slack.md`](docs/slack.md).
- No tool auto-fetches all pages; the agent must explicitly paginate via `cursor`.

### Tool metadata, schemas and errors

- **Titles and annotations.** Every tool in `tools/list` has a short `title` and all four hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). 49 tools are read-only, 17 write without destroying anything, and 14 are destructive (overwrite, delete, merge, revoke). `openWorldHint` is `true` for every tool except `mcp_get_health`. `slack_prepare_write` is read-only, since it only previews; `slack_confirm_write` is the write.
- **Input schemas.** Schemas are zod 4, and `tools/list` publishes their JSON Schema with the real bounds: integer or number, minimum and maximum, defaults, string lengths, enums, array bounds (including the Slack batch caps), nested object properties and unions. `slack_prepare_write` shows its items as three variants keyed by `action` (`post`, `react`, `upload`). Cross-field rules (such as "provide either `transitionId` or `transitionName`") are not expressible in JSON Schema; the field descriptions state them and validation still enforces them.
- **Validation.** Arguments are validated against the schema before the handler runs; defaults are applied and unknown keys dropped. A refused call returns an `isError` result whose text is the SDK's `Input validation error: …` naming the field.
- **Tool failures are results, not protocol errors.** A tool that fails returns `isError: true` with one text item: `API error (<status>): <detail>` for an upstream HTTP failure, or the handler's own message for a business rule (including Slack's `slack.<code>: …`).
- **Protocol errors** are for requests the server cannot route: an unknown tool, prompt or resource is `-32602`, as is a prompt called without a required argument or a resource URI with an invalid issue key. A resource or prompt that fails upstream is `-32603` with the same detail text.
- **List caching.** For 2026-07-28 clients, the tool, prompt, resource and resource-template lists carry a one-hour, private cache hint, since the set is fixed for the life of the process.

---

## Resources

4 resources total (all conditional). The static resource appears in `resources/list` and the three templates in `resources/templates/list`; none of the templates enumerates.

| URI | Name | Module | Description | Returns |
|---|---|---|---|---|
| `jira://issue/{key}` | `jira_issue` | Jira | Single Jira issue by key | `SlimIssue` as JSON |
| `jira://search/{+jql}` | `jira_search` | Jira | Jira search results by JQL query (URI-encoded) | `SlimIssue[]` as JSON (max 20) |
| `jira://myself` | `jira_myself` | Jira | Current authenticated Jira user profile | Jira user as JSON |
| `github://prs/{issueKey}` | `github_prs` | GitHub | Pull requests for an issue key | `PrInfo[]` as JSON |

JQL in `jira://search/{+jql}` is URI-encoded (e.g., `jira://search/project%20%3D%20TAP`); the template uses reserved expansion, so a query containing `/` still resolves. Restricted keywords (DELETE, UPDATE, CREATE, INSERT, DROP, ALTER, EXEC, ADMIN) are rejected for safety.

---

## Prompts

2 prompts total (both conditional on Jira env vars), listed by `prompts/list` with their arguments and which are required. Prompt arguments are strings on the wire.

| Prompt | Arguments | Description |
|---|---|---|
| `create-issue` | `projectKey`, `issueType`, `summary` (required); `description`, `priority`, `labels` (optional; `labels` is a comma-separated string, e.g. `frontend,ux`) | Produces a guided issue-creation message prompting the agent to call `jira_create_issue`. |
| `triage-issue` | `key` | Fetches the issue + available transitions + comments, returns a structured analysis: summary, status, assignee, priority, description, available transitions, comment history. |

---

## Conditional Registration Behavior

- **Jira module** — registered only if `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_TOKEN` are all set.
- **GitHub module** — registered only if `GH_TOKEN` is set.
- **Figma module** — registered only if `FIGMA_TOKEN` is set.
- **Jenkins module** — registered only if `JENKINS_URL`, `JENKINS_USER`, and `JENKINS_TOKEN` are all set.
- **Slack module** — registered only if `SLACK_ENABLED` is exactly `true`. It needs no other environment variable: `slack_login` adopts the web session dev-dashboard captured in `~/.config/slack/session.json` (or `SLACK_SESSION_FILE`), and only falls back to the Slack app login — which answers `app_not_configured` until the client id is in `~/.config/slack/toolkit-mcp/app.json` — when no captured session exists (see [`docs/slack.md`](docs/slack.md)).
- **Fallback** — if no env vars are set, the server starts with only `mcp_get_health`. No crashes.
- The server logs active integrations at startup: `[mcp] Jira integration: active`.
- `mcp_get_health` reports each integration, including `slack`, as a boolean.

---

## Testing

More than 1,700 tests across 55 test files using **vitest**, including a stdio end-to-end test that spawns the server and speaks both protocol eras:

```bash
npm run test                 # Run all tests
npx vitest path/to/file.test.ts   # Single test file
npm run typecheck:tests      # Type-check the tests and fixtures as well
```

All tool handlers are testable via **dependency injection** — mock clients are passed to handler factories, no real credentials needed.

---

## Scripts

| Script | Description |
|---|---|
| `npm run mcp` | Dev mode — `tsx` TypeScript execution, stdio transport |
| `npm run mcp:prod` | Production mode — compiled JS (`npm run build` first) |
| `npm run mcp:inspect` | Launch MCP inspector for debugging |
| `npm run build` | TypeScript compilation (`tsc`) |
| `npm run typecheck` | TypeScript type-check only (`tsc --noEmit`) |
| `npm run typecheck:tests` | Type-check tests and fixtures too (`tsc -p tsconfig.test.json`) |
| `npm run test` | Run all tests (vitest) |
| `npm run test:watch` | Vitest watch mode |

---

## MCP Client Configuration (AI IDEs)

### OpenCode / Claude Desktop

```json
{
  "mcpServers": {
    "toolkit-mcp": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/toolkit-mcp/src/mcp-server.ts"],
      "env": {
        "JIRA_BASE_URL": "https://pathwise.atlassian.net",
        "JIRA_EMAIL": "you@pathwisek12.com",
        "JIRA_TOKEN": "<atlassian-api-token>",
        "GH_TOKEN": "<github-token>"
      }
    }
  }
}
```

### VS Code (Cline, Continue, etc.)

```json
{
  "mcpServers": {
    "toolkit-mcp": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/toolkit-mcp/src/mcp-server.ts"],
      "env": {
        "JIRA_BASE_URL": "https://pathwise.atlassian.net",
        "JIRA_EMAIL": "you@pathwisek12.com",
        "JIRA_TOKEN": "<atlassian-api-token>",
        "GH_TOKEN": "<github-token>"
      }
    }
  }
}
```

**Note:** Omit env vars for integrations you don't need (e.g., skip `GH_TOKEN` if you only use Jira). Tools are only registered for integrations whose env vars are present.

---

## Project Layout

```
src/
├── mcp-server.ts              # Entry: runtime built once, McpServer factory served by serveStdio, process hooks
├── mcp-config.ts              # MCP_LOG_LEVEL and the stderr logger
├── mcp-health.ts              # mcp_get_health descriptor and handler
├── server-info.ts             # Server name and version, read once from package.json
├── services/
│   ├── index.ts               # Barrel — re-exports all service classes/types
│   ├── config.ts              # loadConfig() + dotenv (shared by Jira/GitHub)
│   ├── slim.ts                # SlimIssue, toSlimIssue, adfToText
│   ├── jira/
│   │   ├── jira-client.ts     # JiraClient class
│   │   └── markdown-to-adf.ts # Markdown → ADF converter for Jira comments
│   ├── github/
│   │   └── github-client.ts   # GitHubClient class
│   └── slack/                 # SlackClient, login by link, dev-dashboard session adoption, token store, links, cursors, batching, upload source
│       └── __fixtures__/      # Synthetic test fixtures (compiled with the source, imported only by tests)
├── integrations/
│   ├── index.ts               # Module registry + IntegrationModule interface and descriptor types
│   ├── register.ts            # The only SDK registration code: tools, resources, prompts, error mapping, annotation presets
│   ├── helpers.ts             # PaginatedResponse helper, messageOf
│   ├── jira/
│   │   ├── index.ts           # JiraModule: needsEnv, createToolHandlers, resources, prompts
│   │   └── module.ts          # Jira tool handlers, Zod schemas, descriptors
│   ├── github/
│   │   ├── index.ts           # GitHubModule: needsEnv, createToolHandlers, resources
│   │   └── module.ts          # GitHub tool handlers, Zod schemas, descriptors
│   └── slack/
│       ├── index.ts           # SlackModule: needsEnv (SLACK_ENABLED), createToolHandlers
│       ├── module.ts          # Slack Zod schemas and tool descriptors
│       ├── session-tools.ts   # slack_login, slack_logout, slack_get_status
│       ├── read-tools.ts      # search, messages, threads, channels, users
│       ├── download-tools.ts  # slack_download_file
│       ├── write-tools.ts     # slack_prepare_write, slack_confirm_write
│       ├── write-gate.ts      # Confirmation tokens over a frozen list of writes
│       └── __fixtures__/      # Synthetic test fixtures
docs/
├── slack.md                   # Slack setup, tools, limits and error codes
└── slack-app-manifest.json    # Manifest to create the Slack app from (user scopes, PKCE, redirect URL)
```

---

## Dependencies

- **@modelcontextprotocol/server** (2.4.0, exact) — MCP SDK v2 server: `McpServer`, `serveStdio`, protocol types. `@modelcontextprotocol/client` 2.4.0 is a development dependency used only by tests.
- **zod** (4.6.7, exact, the copy the SDK resolves) — Tool input schemas; the SDK validates with them and publishes their JSON Schema.
- **axios** (exact pin) — HTTP client for Jira and GitHub API calls.
- **he** — HTML entity decoding in the Confluence service.
- **marked** — Markdown lexer behind the `markdown` format of `jira_add_comment` / `jira_update_comment` (exact version pinned).
- **dotenv** — Environment variable loading from `.env`.

The Slack module adds no dependency: it uses axios for the Web API and Node's built-ins (`node:http` for the loopback login listener, `node:crypto`, `node:fs`).

> **Note:** The `jira-cli` library has been absorbed into `src/services/` as an internal service layer. No external dependency is needed — JiraClient, GitHubClient, and their utilities live directly in the toolkit-mcp codebase.

---

## Reference

- **Architecture plan:** [`docs/plans/01-jira-cli-mcp-server.md`](docs/plans/01-jira-cli-mcp-server.md) — full implementation plan covering all phases.
- **Architecture review:** [`docs/code-review/jira-cli-mcp-server-plan-review.md`](docs/code-review/jira-cli-mcp-server-plan-review.md) — 18 findings addressed.
- **Phase 1 review:** [`docs/code-review/phase1-mcp-implementation-review.md`](docs/code-review/phase1-mcp-implementation-review.md).
- **Agentic conventions:** `/ezat/AGENTS.md` — monorepo-level workflow, build/lint/test commands.
