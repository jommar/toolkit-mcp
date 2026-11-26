# toolkit-mcp — Jira reference

Loaded from [`../SKILL.md`](../SKILL.md), which holds the write rules (Components, bare 400, @mentions)
and the read-an-issue recipe. Jira tools register only if `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_TOKEN`
are set.

## Tools

| Tool | Use for | Key params |
|------|---------|-----------|
| `jira_whoami` | Authenticated user profile (your own accountId) | _none_ |
| `jira_get_issues` | Fetch one issue **or** search; custom field ids (e.g. story points) go in `fields[]` — find them with `jira_list_fields` | `key` **or** `jql`; `limit`(20), `cursor`, `fields[]`, `fieldsOnly?`, `adf?`, `includeGithubPrs?`, `includeSlackThreads?` |
| `jira_get_changelogs` | Field-change history for 1 to 20 issues, newest first, grouped by key | `keys[]`; `limit`(20, per issue), `cursor` (single key only), `fields[]?` (filter by field name or id), `maxValueChars`(200) |
| `jira_list_fields` | Find field ids by name (e.g. `search: "story"` → `customfield_XXXXX`) | `search?` |
| `jira_list_components` | A project's components (`{id, name}`) — the only valid values for `components` | `projectKey` |
| `jira_create_issue` | New issue | `projectKey`, `issueType`, `summary`; `description?`, `fields?`, `components?` |
| `jira_update_issue` | Edit fields and/or components (`components` replaces the whole set) | `key`; `fields?`, `components?` — at least one |
| `jira_transition_issue` | Change status | `key` + (`transitionId` **or** `transitionName`); `comment?` |
| `jira_assign_issue` | Assign / unassign | `key`, `assignee` (`"me"` default, `"none"`, or accountId) |
| `jira_add_comment` | Comment; `[~accountid:<id>]` in `body` becomes a real @mention | `key`, `body`; `format?` (`text`, `markdown`, `adf`); `parentId?` |
| `jira_update_comment` | Edit a comment; mentions convert as above | `key`, `commentId`, `body`; `format?` |
| `jira_delete_comment` | Delete a comment | `key`, `commentId` |
| `jira_get_comments` | Comments on an issue, oldest first, plain-text bodies (`adf: true` adds `bodyAdf`) | `key`; `limit`(50), `cursor`, `adf?` |
| `jira_get_attachment` | Download an attachment (images come back as MCP image content) | `attachmentId`; `issueKey?` |
| `jira_list_transitions` | Available status transitions | `key` |
| `jira_list_issue_link_types` | Valid link type names | _none_ |
| `jira_search_users` | Find users by display name or email | `query` |
| `jira_link_issues` | Link two issues | `inwardKey`, `outwardKey`, `type` (e.g. `"Blocks"`); `comment?` |

## Behaviors

- **`jira_get_issues` is always slim:** status, assignee, description and comments, with ADF flattened to plain text. `fields: [...]` does not switch to raw output: standard fields stay flattened and any other field id lands raw under `custom`. Add `fieldsOnly: true` to get back only `key` and the names in `fields` (`summary`, `status`, `type`, `assignee`, `comments` and the like, or custom field ids), with nothing else fetched: the way to list many issues without their descriptions and comments. Pass `adf: true` to also get `descriptionAdf`, the raw document (with `fieldsOnly` too, which then fetches the description for it), which you need before appending to a description with `jira_update_issue`. Large results may be saved to a file by the client; extract with `jq`.
- **Links in the same call:** `includeGithubPrs: true` adds `pullRequests: [{number,title,state,repo,htmlUrl,reviewStatus}]` per issue (any PR state, same search as `github_get_prs`, first 20 issues). `includeSlackThreads: true` adds `slackThreads: [{permalink,channel,channelId,threadTs,at}]` — up to 5 channel threads that mention the key, newest first (links only, no DMs or bot posts, first 10 issues; needs Slack enabled and logged in). Read a thread with `slack_get_threads { threads: [{ thread: <permalink> }] }` (the permalink points at the thread root). `[]` means looked and found nothing; a **missing key means not looked up**, so read the envelope's `warnings: [{source,message}]` (integration inactive, API error, or the 20 / 10 issue cap). Two limits: Slack finds only threads where someone typed the key, and if only *some* GitHub searches fail, their keys also come back `[]` with no warning. Prefer these flags over a separate `github_get_prs` / `slack_search_messages` call when you only need the links.
- **Changelogs:** `jira_get_changelogs` returns each issue's entries newest first. A failing key or a capped scan (10 pages when filtering by `fields`) lands in `warnings` without failing the other keys; continue a capped single-key scan with its `nextPageToken` as `cursor`.
- **Comment shape differs by tool:** `jira_get_issues` returns comments **newest-first** and flattened (mentions and media dropped). `jira_get_comments` returns them **oldest-first** with plain-text bodies; pass `adf: true` for each comment's raw ADF as `bodyAdf` (mentions, media, hard breaks). Use it for rich content or thread order.
- **Threaded replies:** pass the thread's top-level comment id as `parentId` to `jira_add_comment`; omit it for a top-level comment. `[~accountid:…]` mentions still convert in replies.
- **Comment `format`:** `text` (default) wraps the body in one paragraph. `markdown` converts headings, bold, italic, inline code, links, nested lists, fenced code, blockquotes, rules and GFM pipe tables, keeps single newlines as line breaks, and still converts mentions (not inside bold or links). `adf` sends a complete ADF document unchanged (no mention conversion). A schema loaded before a server reconnect can show stale parameters; reload it in a fresh session.
- **Transition by name:** `transitionName: "In Progress"` resolves to the id; a wrong name errors with the issue's available transitions — read it and retry.
- **`jira_link_issues` validates the link type** the same way, listing valid names on error.
- **`jira_assign_issue`:** `"me"` is the authenticated user, `"none"` unassigns, anything else must be an accountId.
- **An empty JQL result for an issue type** means the project doesn't use that type, not that the name is wrong: search accepts any type Jira knows, while create rejects a type the project lacks with a bare 400.

## Recipes

**Issues needing code review, with their PRs**

```text
jira_get_issues { jql: "assignee = currentUser() AND status = 'Ready For Code Review'", limit: 50, fields: ["summary", "status", "assignee"], fieldsOnly: true, includeGithubPrs: true }
```

**Other handy JQL**

```text
project = PROJ AND status = 'In Progress'
assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC
```

**When did this issue change status, and who moved it**

```text
jira_get_changelogs { keys: ["PROJ-123"], fields: ["status"] }
```

**Move an issue and leave a note**

```text
jira_transition_issue { key: "PROJ-123", transitionName: "In Progress", comment: "Picked up" }
```

**Create an issue with components, then set a custom field**

```text
jira_list_components { projectKey: "PROJ" }                    // → items[].name; pick from this list
jira_create_issue { projectKey: "PROJ", issueType: "Story", summary: "...", description: "...", components: ["<name from the list>"] }
jira_list_fields { search: "story points" }                    // → the field id
jira_update_issue { key: "<new key>", fields: { "<field id>": 3 } }
```

**Comment lifecycle and attachments**

```text
jira_get_comments { key: "PROJ-123" }
jira_update_comment { key: "PROJ-123", commentId: "10001", body: "...", format: "markdown" }
jira_delete_comment { key: "PROJ-123", commentId: "10001" }
jira_get_attachment { attachmentId: "<attachment id>", issueKey: "PROJ-123" }
```
