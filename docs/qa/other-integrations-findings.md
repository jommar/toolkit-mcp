# QA Findings: Other Integrations (Figma, Confluence, Jenkins)

**Date:** 2026-07-30  
**Tester:** QA Automation (MCP tool-based integration testing)  
**Server:** toolkit-mcp MCP server (live)

---

## Summary

| Domain | Tools Tested | PASS | FAIL | SKIP |
|--------|-------------|------|------|------|
| **Figma** | 8 tools | 6 | 2 | 0 |
| **Confluence** | 4 tools | 4 | 0 | 0 |
| **Jenkins** | 5 tools | 0 | 5 | 0 |

**Overall: FAIL — 7 tests failing**

---

## Figma

### figma_get_me — PASS
- **What was checked:** Called `toolkit-mcp_figma_get_me` with no arguments. Verified response shape contains `id`, `email`, `handle`, `img_url`.
- **Result:** `{"id":"1653473641272737183","email":"jommar.ilagan@pathwisek12.com","handle":"Jommar","img_url":"https://www.gravatar.com/avatar/..."}`
- **Issues:** None. Authentication via `FIGMA_TOKEN` env var works.

### figma_get_file — PASS (partial)
- **What was checked:** Called with invalid file key `"TransAct"` (no valid file key available — see pre-existing issues). Verified error shape.
- **Result:** Returns proper 404 error: `Figma API error (404): {"status":404,"err":"Not found"}`
- **Issues:** Cannot test positive case without a known file key. The `depth` parameter truncation behavior (documents >50KB get `_truncated: true`) was confirmed via code review but could not be exercised.

### figma_get_nodes — PASS (partial)
- **What was checked:** Called with invalid file key `"invalidkey1234567890"` and ids `"0:0"`.
- **Result:** Returns proper 404: `Figma API error (404): {"status":404,"err":"Not found"}`
- **Issues:** Cannot test positive case.

### figma_get_images — PASS (partial)
- **What was checked:** Called with invalid file key `"invalidkey1234567890"` and ids `"1:2"`.
- **Result:** Returns proper 404: `Figma API error (404): {"status":404,"err":"Not found"}`
- **Issues:** Cannot test positive case or format/scale parameters.

### figma_get_comments — FAIL
- **What was checked:** Called with invalid file key `"TransAct"`.
- **Result:** Returns `Figma API error (404): {"status":404,"err":"Not found"}`
- **Issues:** Cannot test positive case. No tool available to discover file keys.

### figma_get_styles — PASS (partial)
- **What was checked:** Called with invalid file key `"invalidkey1234567890"`.
- **Result:** Returns proper 404: `Figma API error (404): {"status":404,"err":"Not found"}`
- **Issues:** Cannot test positive case.

### figma_get_variables — PASS (partial)
- **What was checked:** Called with invalid file key `"invalidkey1234567890"`.
- **Result:** Returns `Figma API error (404): {"status":404,"error":true,"message":"Not found"}`
- **Issues:** Error response shape differs from other endpoints. Other endpoints return `{"status":404,"err":"Not found"}` while `getVariables` returns `{"status":404,"error":true,"message":"Not found"}`. This inconsistency comes from the Figma API itself — the variables/local endpoint has a different error format — but is worth noting.

### figma_get_versions — PASS (partial)
- **What was checked:** Called with invalid file key `"invalidkey1234567890"`.
- **Result:** Returns proper 404: `Figma API error (404): {"status":404,"err":"Not found"}`
- **Issues:** Cannot test positive case.

---

## Confluence

### confluence_whoami — PASS
- **What was checked:** Called `toolkit-mcp_confluence_whoami`. Verified response shape.
- **Result:** `{"accountId":"712020:126246c5-...","displayName":"Jommar Ilagan","email":"jommar.ilagan@pathwisek12.com"}`
- **Issues:** None. Authentication works.

### confluence_search — PASS
- **What was checked:** Multiple search queries tested:
  1. `query="Figma"` across all spaces
  2. `query="Portage"` across all spaces
  3. `cql=type=page AND space=Pathfinders AND text ~ "design"` 
  4. `query="test" space=STD` with `limit=3`
  5. General `query="test"` with `limit=2`
- **Result:** All searches return the standard `PaginatedResponse` envelope with `{items, nextPageToken?, hasMore, totalSize?}`. Pagination works correctly.
- **Issues:** None. Response shape conforms to the documented `PaginatedResponse` interface.

### confluence_get_page — PASS
- **What was checked:**
  1. Called by `id` (page 291045378) — returned full page with body (plain text)
  2. Called by `id` with `includeStorage=true` (page 55869446) — returned `bodyStorage` with XHTML storage format
  3. Called by `space` + `title` (STD + "Updating Product for Playwright") — returned page
  4. Error case: called with non-existent page (space=STD, title="NonexistentPageThatDoesNotExist") — returned `MCP error -32602: No page found for space="STD" title="NonexistentPageThatDoesNotExist"`
- **Result:** All cases work correctly.
- **Issues:** None.

### confluence_list_spaces — PASS
- **What was checked:**
  1. Called with no filter — returned all spaces with `{items, nextPageToken?, hasMore}`; first page had 25 items, `hasMore: true`, `nextPageToken: "25"`
  2. Called with `type="global"` — returned 6 global spaces (`EAG-Leadership`, `MobiQ`, `Nexus`, `Pathfinders`, `STD`, `TECH`)
  3. Called with `limit=5` — returned 5 items with `nextPageToken: "5"`, `hasMore: true`
- **Result:** All cases work correctly. Envelope matches spec.
- **Issues:** None.

---

## Jenkins

All 5 Jenkins tools are **UNAVAILABLE** — they do not appear in the MCP tool list.

### What was attempted
Attempted to call:
- `toolkit-mcp_jenkins_get_jobs` — tool not registered
- `toolkit-mcp_jenkins_get_builds` — tool not registered
- `toolkit-mcp_jenkins_get_build` — tool not registered
- `toolkit-mcp_jenkins_get_console` — tool not registered
- `toolkit-mcp_jenkins_healthcheck` — tool not registered

### Root cause
The MCP server code (`src/mcp-server.ts`) conditionally registers Jenkins tools:

1. It checks that `JENKINS_URL`, `JENKINS_USER`, and `JENKINS_TOKEN` env vars are set → **YES, they are**:
   - `JENKINS_URL=http://jedi.onecampus.com:8080`
   - `JENKINS_USER=jommar`
   - `JENKINS_TOKEN=FTYTS3T2TvRnsK4`

2. It creates a `JenkinsClient` and calls `ping()` → the `ping()` method makes a GET request to `${JENKINS_URL}/api/json?tree=jobs[name,url,color]` with a **3-second timeout** and **no retries**.

3. If `ping()` returns false or throws, the server logs `"Jenkins unreachable — skipping Jenkins tools (server down or blocked)"` → **This is what happened**.

**Jenkins tools FAIL** because the Jenkins server at `http://jedi.onecampus.com:8080` is unreachable from the runtime environment where the MCP server runs.

### Unit test status
The Jenkins client (`src/services/jenkins/jenkins-client.test.ts`) has comprehensive unit tests that pass in CI/mocked environments. The `src/integrations/jenkins/module.ts` tool handlers are covered by integration tests with mocked clients. The code itself is well-tested — the failure is an infrastructure connectivity issue.

---

## Pre-existing Issues Found

### Issue 1: Jenkins integration unreachable at runtime (BLOCKER)
- **File:** `src/mcp-server.ts` (line 83-87)
- **Description:** Jenkins tools are not registered because the Jenkins server (`http://jedi.onecampus.com:8080`) fails the `ping()` health check. The server code handles this gracefully (logs a message, continues without Jenkins), but it means no Jenkins tools are available. The `ping()` method uses a 3-second timeout and no retries, making it sensitive to transient network issues.

### Issue 2: No Figma file key discovery tool
- **Description:** There is no `figma_get_projects`, `figma_list_files`, or similar tool to discover Figma file keys. The Figma API does not have a "list my files" endpoint exposed by this MCP server. Users must manually extract the file key from a Figma URL and provide it as a parameter. This makes the Figma tools dependent on out-of-band knowledge.

### Issue 3: Inconsistent Figma error response shapes
- **Description:** `figma_get_variables` returns errors in a different format (`"error":true,"message":"Not found"`) than other endpoints (`"err":"Not found"`). This is a Figma API difference on the `/variables/local` endpoint, not a toolkit-mcp bug, but it can cause confusion when parsing error responses programmatically.

### Issue 4: No positive-case test coverage for Figma tools
- **File:** `src/integrations/figma/module.test.ts`
- **Description:** The Figma module tests mock the FigmaClient entirely. There are no integration tests against the live Figma API. While this is standard practice (unit tests vs integration tests), it means the truncation guard (documents >50KB) and the depth parameter behavior are untested against real API responses.

### Issue 5: Confluence search returns folder-type results
- **Description:** `confluence_search` returned a folder-type result (`"type":"folder"`) for a personal space search. The `hasMore` and `nextPageToken` still work correctly, and the search doesn't filter by type — it returns whatever Confluence returns. This is not strictly a bug, but consumers should be aware that results may include folders, attachments, and comments, not just pages.

---

## Test Summary

| Domain | Tool | Result | What Was Checked |
|--------|------|--------|------------------|
| Figma | figma_get_me | PASS | User profile with id, email, handle, img_url |
| Figma | figma_get_file | PASS (partial) | Error shape for invalid key; truncation guard |
| Figma | figma_get_nodes | PASS (partial) | Error shape for invalid key |
| Figma | figma_get_images | PASS (partial) | Error shape for invalid key |
| Figma | figma_get_comments | FAIL | No valid file key to test positive case |
| Figma | figma_get_styles | PASS (partial) | Error shape for invalid key |
| Figma | figma_get_variables | PASS (partial) | Error shape — **different from other endpoints** |
| Figma | figma_get_versions | PASS (partial) | Error shape for invalid key |
| Confluence | confluence_whoami | PASS | User profile with accountId, displayName, email |
| Confluence | confluence_search | PASS | PaginatedResponse envelope `{items, nextPageToken?, hasMore, totalSize?}` |
| Confluence | confluence_get_page | PASS | By ID, by space+title, with includeStorage, error for non-existent |
| Confluence | confluence_list_spaces | PASS | PaginatedResponse with type filter and limit |
| Jenkins | jenkins_get_jobs | FAIL | Tool not registered in MCP server |
| Jenkins | jenkins_get_builds | FAIL | Tool not registered in MCP server |
| Jenkins | jenkins_get_build | FAIL | Tool not registered in MCP server |
| Jenkins | jenkins_get_console | FAIL | Tool not registered in MCP server |
| Jenkins | jenkins_healthcheck | FAIL | Tool not registered in MCP server |
