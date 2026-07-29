# Jira Integration QA Findings — toolkit-mcp

**Tested:** 2026-07-30  
**Test scope:** Read-only Jira tools (whoami, get_issues, get_comments, list_transitions, list_issue_link_types, search_users, get_attachment + error handling)

---

## Tool-by-Tool Results

### 1. `jira_whoami` — PASS

**What was checked:** Called without arguments. Returns authenticated user profile.

**Result:** Returns full profile including `accountId`, `emailAddress`, `displayName`, `active`, `timeZone`, `locale`, `groups`, `applicationRoles`.

**Issues found:** None.

---

### 2. `jira_get_issues` — PASS (with finding)

**Tests performed:**
- **`key` param:** `TRIPS-1460` returns full SlimIssue with description, type, priority, comments, attachments.
- **`jql` param:** `project = TRIPS ORDER BY created DESC` returns slimmed SlimIssue (null for description, type, priority, created, updated, comments, attachments in JQL mode).
- **`fields` param:** Supplying `fields: ["summary","status"]` or `fields: []` has **no effect** — the response shape is identical to calling without `fields`. All fields are always returned.
- **Pagination:** `cursor` + `nextPageToken` + `hasMore` work correctly. Passing a valid `nextPageToken` returns the next page. `hasMore` correctly reflects whether more results exist.

**Issues found:**
- **BUG:** `fields` parameter is silently ignored. Regardless of what fields are requested, the full SlimIssue shape is always returned. This wastes bandwidth when only a subset is needed and violates user expectation. Fix: respect the `fields` parameter at the MCP tool level by filtering the Jira API response to only the requested fields.
- **Inconsistency:** When using `key` param, the response includes full detail (description, comments, attachments, priority, etc.). When using `jql` param, many fields are `null` (type, priority, assignee of some, created, updated, description, comments, attachments). This is a Jira API behavior difference, but the MCP tool could normalize it.

---

### 3. `jira_get_comments` — PASS

**What was checked:** Called with `TRIPS-1425` (issue with 4 comments). Verified each comment includes `id`, `author`, `body`, `created`, `updated`.

**Result:** All 4 comments returned with `id` field present (e.g., `"id":"40293"`). Adobe document format (`type: doc`) for body. Author details include `accountId`, `emailAddress`, `displayName`. Single-threaded replies via `parentId` field.

**Issues found:** None. The `id` field is present on every comment.

---

### 4. `jira_list_transitions` — PASS

**What was checked:** Called with `TRIPS-1425`. Returns available transitions for the issue's current status ("In Progress").

**Result:** 15 transitions returned, including "Ready For Code Review", "Complete", "Reopened", "Testing In Progress", etc. Each transition includes `id`, `name`, `to` status (with `id`, `name`, `statusCategory`), and flags (`hasScreen`, `isGlobal`, `isInitial`, `isAvailable`, etc.).

**Issues found:** None.

---

### 5. `jira_list_issue_link_types` — PASS

**What was checked:** Called without arguments.

**Result:** 9 link types returned: Blocks, Cloners, Discovery - Connected, Duplicate, Polaris datapoint work item link, Polaris merge work item link, Polaris work item link, Problem/Incident, Relates. Each includes `id`, `name`, `inward`, `outward`, `self`.

**Issues found:** None.

---

### 6. `jira_search_users` — PASS

**What was checked:** Searched for "Jommar Ilagan" and "Cristina Picciola".

**Result:** Both searches return complete user profiles with `accountId`, `emailAddress`, `displayName`, `avatarUrls`, `active`, `timeZone`, `locale`, `accountType`. The `guest` field is present (false for both).

**Issues found:** None.

---

### 7. `jira_get_attachment` — PASS (with finding)

**What was checked:** Called with `attachmentId: "41167"` and `issueKey: "TRIPS-1425"`.

**Result:** Returns the attachment content as base64-encoded data. Metadata returned includes `filename`, `mimeType`, `size`, `created`, `author`. For large files (27MB MP4), the response body is base64-encoded binary which is extremely large.

**Issues found:**
- **WARNING:** For large attachments (27MB video file), the response can exceed 35MB of base64-encoded data. No streaming or size-limit warning. This could cause memory issues in the MCP client.

---

### 8. Error Handling — PASS

**Tests performed:**
- `get_issues("INVALID-99999")` → `Error: API error (404): Issue does not exist or you do not have permission to see it.`
- `get_comments("INVALID-99999")` → `Error: API error (404): Issue does not exist or you do not have permission to see it.`
- `get_attachment("99999999", "TRIPS-1425")` → `Error: API error (404): The attachment with id '99999999' does not exist`

**Errors:**
- Error format: `MCP error -32603: MCP error -32603: API error (404): <message>`
- The `-32603` (internal error) code is used for all Jira API errors, whether they're 404, 400, 401, etc. This means the error code doesn't distinguish between "not found", "bad request", and "unauthorized".

**Issues found:**
- **MINOR:** All Jira API errors use the generic `-32603` MCP error code. There's no mapping of HTTP status codes (404, 400, 401, 403) to distinct MCP error codes. Consumers cannot programmatically distinguish between "not found" and "unauthorized" without string-parsing the error message.

---

## Summary

| Tool | Status |
|------|--------|
| `jira_whoami` | ✅ PASS |
| `jira_get_issues` | ✅ PASS (1 bug found) |
| `jira_get_comments` | ✅ PASS |
| `jira_list_transitions` | ✅ PASS |
| `jira_list_issue_link_types` | ✅ PASS |
| `jira_search_users` | ✅ PASS |
| `jira_get_attachment` | ✅ PASS (1 warning found) |
| Error Handling | ✅ PASS (1 minor issue found) |

---

## Pre-existing Issues Found

| # | Severity | File/Component | Description |
|---|----------|----------------|-------------|
| 1 | **Bug** | `jira_get_issues` MCP tool | `fields` parameter is silently ignored — the tool always returns the full SlimIssue shape regardless of what `fields` is set to. |
| 2 | **Warning** | `jira_get_attachment` MCP tool | For large attachments (e.g., 27MB MP4), the base64-encoded response can exceed 35MB. No streaming or truncation mechanism. |
| 3 | **Minor** | Error handling (all tools) | All Jira API errors use generic MCP error code `-32603`. HTTP status codes (404 vs 401) are not mapped to distinct error codes, forcing consumers to parse error message strings. |
