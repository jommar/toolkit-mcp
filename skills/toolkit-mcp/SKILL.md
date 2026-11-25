---
name: toolkit-mcp
description: How to use the toolkit-mcp tools (Jira, Confluence, GitHub, Jenkins, Figma, Slack) — which tool to call, how to chain them, the response shapes to expect and the write rules that bite. Use before calling any jira_*, github_*, confluence_*, jenkins_*, figma_*, slack_* or mcp_get_health tool, e.g. reading or searching issues, reviewing or opening PRs, searching the wiki, checking builds, or logging in to, reading or posting to Slack.
---

# toolkit-mcp

`toolkit-mcp` bridges Jira, Confluence, GitHub, Jenkins, Figma and Slack as MCP tools. Each integration
registers only when its credentials are configured (Slack only with `SLACK_ENABLED=true`), and
`mcp_get_health` is always there to say which are live. This skill says which tool to reach for and how
to chain them; parameter schemas come from the tool definitions themselves.

Prefer these tools over raw `gh`, `curl` or a CLI against the same APIs: they return slim, paginated
output and enforce the write rules below.

## Where the detail lives

Reading an issue needs no reference — use the recipe below. For anything else, **read the reference for
the integration before your first call to it**: it holds that integration's tool table, behaviors and
recipes.

| You are about to… | Read |
|-------------------|------|
| Search Jira, read changelogs, or create / update / transition / assign / comment on / link issues | [`references/jira.md`](references/jira.md) |
| Find, review, comment on, merge or open GitHub PRs; Copilot feedback; the code-review backlog | [`references/github.md`](references/github.md) |
| Search, read or write the Confluence wiki | [`references/confluence.md`](references/confluence.md) |
| Check Jenkins builds, or read / comment on Figma files | [`references/jenkins-figma.md`](references/jenkins-figma.md) |
| Log in to, read, search, download from, post / react / upload to Slack | [`references/slack.md`](references/slack.md) |
| A tool is missing, or you want the MCP resources / prompts / `mcp_get_health` | [`references/server.md`](references/server.md) |

## Response shapes you must expect

- **Every list-style tool returns a `PaginatedResponse`:** `{ items: [...], nextPageToken?: string, hasMore: boolean }`. There is no `total` and no `offset`. For the next page, pass `nextPageToken` back as `cursor`. **No tool auto-fetches all pages** — paginate explicitly while `hasMore` is true.
- **`jira_get_issues` always returns a `PaginatedResponse`**, even for a single `key`: a one-item `items` array with `hasMore: false`, never a bare issue. `key` wins over `jql` if you pass both.
- **`jira_get_issues` can carry links:** opt-in `includeGithubPrs` / `includeSlackThreads` add `pullRequests` / `slackThreads` per issue and an optional top-level `warnings` — see [`references/jira.md`](references/jira.md).
- **`jira_get_changelogs` groups by key:** `{ items: [{ key, total, changelogs, hasMore, nextPageToken? }], warnings? }`, one entry per issue key.
- Single-item write tools (`create`, `update`, `transition`, `assign`, `comment`, `link`, `create_pr`) return a plain JSON result, not a paginated envelope.
- **Slack read tools use their own shape:** an array of items in, `{ results, truncated }` out, one entry per item with its own `status`, `items`, `hasMore` and `nextPageToken`. To page, send a new item holding only `{ cursor }`. See [`references/slack.md`](references/slack.md).
- **Confluence list tools are offset-based:** `confluence_search` and `confluence_list_spaces` return `{ results, start, limit, size, totalSize?, hasMore }`. To page, pass `start` (e.g. `start: 25`), not `cursor`.

## Write rules (so you don't trip)

These bite on writes, so they load every time. Per-integration behaviors are in `references/`.

- **Components:** set them with the `components` param (a non-empty `string[]`) on `jira_create_issue` / `jira_update_issue`, not through raw `fields`. Get valid names from `jira_list_components { projectKey }` — never guess one. Names match case-insensitively and an unknown name is rejected with the project's valid names. The param wins over `fields.components`. Omitting it leaves components untouched, but on update a given list **replaces the whole set** — list every component to keep. `jira_update_issue` needs `fields` and/or `components`. To read them, ask `jira_get_issues` for `fields: ["components"]`: they come back as `custom.components: [{id, name}]`.
- **A bare `400 Request failed with status code 400` on a write hides Jira's reason** — the status is surfaced, not which field was rejected. Don't retry blind: first confirm nothing was created (`jira_get_issues { jql: "project = PROJ AND reporter = currentUser() AND created >= -30m", fields: ["key","summary"] }`), then change one thing at a time, issue type first.
- **@mentions in Jira comments:** write `[~accountid:<accountId>]` in the `body` of `jira_add_comment` / `jira_update_comment` and it posts as a real mention; `@Display Name` stays literal text. Get the accountId from `jira_search_users`. Only these two tools convert tokens — `jira_transition_issue`'s `comment` and `jira_create_issue`'s `description` do not.
- **Confluence writes need a human OK first.** `confluence_create_page` / `confluence_update_page` publish to a space other people read, so ask before calling either. `confluence_update_page` replaces the body wholesale, so `confluence_get_page { includeStorage: true }` first and edit that, or you silently drop the rest of the page.
- **Slack writes need a live login and two calls.** Check `slack_get_status` (`connected`, else `slack_login`; an `authorize_url` goes to the user). Then `slack_prepare_write` returns a preview and a single-use `confirmation_token`: **show the person the preview and wait for their yes** before `slack_confirm_write`. Nothing posted, reacted or uploaded can be taken back. `text` is Slack mrkdwn (`*bold*`, `<url|label>`, `•` bullets — not `**bold**`, `#` headings or `[x](url)`). Full flow and formatting table: [`references/slack.md`](references/slack.md).
- **`fields` is passed straight to Jira.** `jira_create_issue` and `jira_update_issue` forward the `fields` map unchanged; don't forward unvalidated user-supplied content into it, and set only the keys you intend.

## Recipes you'll reach for most

**Read an issue**

```text
jira_get_issues { key: "PROJ-123", fields: ["components"] }   // slim: status, assignee, description, comments, plus custom.components
```

The slim default omits Components; ask for it with `fields` when you need it.

**My active issues**

```text
jira_get_issues { jql: "assignee = currentUser() AND statusCategory = \"In Progress\" ORDER BY updated DESC", limit: 50 }
```

`currentUser()` resolves to the authenticated account; add `project = PROJ AND` to narrow it.

**An issue and its PRs and Slack threads in one call**

```text
jira_get_issues { key: "PROJ-123", includeGithubPrs: true, includeSlackThreads: true }
```
