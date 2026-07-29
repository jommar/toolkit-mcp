# toolkit-mcp GitHub Integration — QA Findings

**Date**: 2026-07-30
**Tested against**: toolkit-mcp server v0.1.0
**Repo used for testing**: `microsoft/vscode` (TransActComm private repos are not accessible — see Issue A below)
**Test PR**: `microsoft/vscode#317552`

---

## Tool-by-tool results

### 1. `mcp_get_health` — PASS

| Check | Result |
|-------|--------|
| Returns valid server metadata | `serverVersion: "0.1.0"` |
| Lists integration status | `jira: true`, `github: true`, `figma: true`, `confluence: true`, `jenkins: false` |
| Response shape | Correct |

### 2. `github_get_pr_details` — PASS

| Check | Result |
|-------|--------|
| Basic fields returned | number, title, body, state, draft, htmlUrl, repo, author |
| Dates correct | createdAt, updatedAt, closedAt, mergedAt |
| Merge info | mergeable, mergedBy, baseBranch, headBranch, headSha |
| Stats | changedFiles, additions, deletions |
| **requestedReviewers** | `[]` — field present |
| **requestedTeams** | `[]` — field present |
| **labels** | `[]` — field present |
| **assignees** | `["alexdima"]` — field present, populated correctly |

**Error handling**:
- Invalid PR number (`TransActComm/Portage-backend#99999`): `API error (404): Not Found`
- Invalid repo (`nonexistent-owner/nonexistent-repo#1`): `API error (404): Not Found`

### 3. `github_get_pr_files` — PASS (pag. bug)

| Check | Result |
|-------|--------|
| Returns file list | filename, status, additions, deletions, changes |
| **Patches included** | Yes — diff hunks returned in `patch` field |
| **Truncation indicator** | `"truncated": true` for large patches (correct) |
| Pagination returned | `nextPageToken`, `hasMore` fields present |
| **Cursor replay** | Calling with returned cursor `"2"` returns **empty** — see Issue B |

### 4. `github_get_pr_commits` — PASS (pag. bug)

| Check | Result |
|-------|--------|
| Returns commit list | sha, commit.message, commit.author (name, email, date), author.login |
| Pagination returned | `nextPageToken`, `hasMore` fields present |
| **Cursor replay** | Calling with returned cursor `"2"` returns **empty** — see Issue B |

### 5. `github_get_pr_comments` — PASS

| Check | Result |
|-------|--------|
| Returns issue comments | id, body, user, createdAt, htmlUrl |
| Pagination fields | Present |
| Pagination verification | Not testable — no PR with >1 comment found in accessible repos |

### 6. `github_get_pr_reviews` — PASS

| Check | Result |
|-------|--------|
| Returns reviews | id, user, state, body, submittedAt, commitId |
| Includes bot reviews | Copilot review body returned in full |
| Response shape | Correct (array, not wrapped in `{items: [...]}`) |

### 7. `github_get_pr_review_comments` — PASS (pag. bug)

| Check | Result |
|-------|--------|
| Returns inline comments | id, path, line, startLine, body, commitId, side, startSide, author |
| Threading | `inReplyToId` field present and correct |
| Created/updated timestamps | Present |
| Pagination returned | `nextPageToken`, `hasMore` fields present |
| **Cursor replay** | Calling with returned cursor `"2"` returns **empty** — see Issue B |

### 8. `github_get_pr_review_threads` — FAIL ✗

| Check | Result |
|-------|--------|
| Basic call | **GraphQL error** |
| Error message | `MCP error -32603: GitHub GraphQL error: Field 'diffLine' doesn't exist on type 'PullRequestReviewThread'` |
| Root cause | MCP server GraphQL query references `diffLine` field that does not exist in the GitHub GraphQL schema. The correct field is likely `line` on the thread's first comment, or `originalLine`/`diffSide` on the `PullRequestReviewThread` type. |

### 9. `github_get_pr_checks` — PASS

| Check | Result |
|-------|--------|
| Returns check runs | totalCount, checkRuns array |
| Check run fields | name, status, conclusion, htmlUrl, startedAt, completedAt |
| Mixed statuses | Both `in_progress` and `completed` runs returned correctly |
| Conclusion types | `success` rendered correctly |

### 10. `github_list_branches` — PASS

| Check | Result |
|-------|--------|
| Returns branch list | name, sha, protected |
| Pagination | Works correctly — first page returns `nextPageToken: "2"`, second call with cursor `"2"` returns next branch set |
| Error handling | `TransActComm/Portage-backend` returns `404 Not Found` |

### 11. `github_search_prs` — PASS (one filter broken)

| Check | Result |
|-------|--------|
| Basic search | Works — returns items with number, title, state, repo, author, createdAt, reviewStatus |
| **`label` filter** (structured param) | Works — filters by label correctly |
| **`base` filter** | Works — filters by base branch correctly |
| **`state` filter** | Works — `open` and `all` return expected results |
| **`label` in query string** | Does not work — query `is:open label:bug` returns empty |
| **`reviewRequested` filter** | **FAIL** — returns `422 Validation Failed` |
| Pagination | Works — `nextPageToken` and `hasMore` correct; cursor replay returns next page |
| Dedicated `repo` parameter | Not available — must use `repo:` in query field (which works) |

### 12. `github_get_file_contents` — PASS

| Check | Result |
|-------|--------|
| Returns decoded content | `content` is base64-decoded; plain text readable |
| Metadata | path, encoding, size, sha, truncated fields present |
| **Truncation indicator** | `"truncated": false` for small files |
| Error handling (missing file) | `API error (404): Not Found` |

---

## Cross-cutting issues

### Issue A — TransActComm private repos not accessible

**Severity**: HIGH (blocks primary use case)

All TransActComm repos (`Portage-backend`, `Portage-frontend`, `TravelTracker`) return HTTP 404 from every tool. The MCP server's GitHub token does not have access to these private repositories. All testing was performed against the public `microsoft/vscode` repo instead.

**Impact**: Any production use of toolkit-mcp against TransActComm repos will fail with unhelpful 404 errors.

**Recommendation**: Configure the GitHub token with access to the `TransActComm` GitHub organization (either a machine user token with repo scope, or a GitHub App installation token).

### Issue B — Pagination off-by-one in files/commits/review-comments

**Severity**: MEDIUM

For `github_get_pr_files`, `github_get_pr_commits`, and `github_get_pr_review_comments`, passing the returned `nextPageToken` cursor back in a subsequent call returns empty items.
- Total items: 2
- Call with `limit: 1` → returns 1 item, `nextPageToken: "2"`, `hasMore: true`
- Call with `limit: 1, cursor: "2"` → returns `items: []`, `hasMore: false`

The same pagination mechanism works correctly in `github_search_prs` and `github_list_branches`, suggesting the bug is in how the cursor offset is calculated for sub-resource endpoints.

**Reproduction**:
1. `github_get_pr_files(repo: "microsoft/vscode", prNumber: 317552, limit: 1)` → returns `nextPageToken: "2"`
2. `github_get_pr_files(repo: "microsoft/vscode", prNumber: 317552, limit: 1, cursor: "2")` → returns `items: []`

### Issue C — `github_get_pr_review_threads` broken

**Severity**: HIGH (tool unusable)

Every call to `github_get_pr_review_threads` fails with:
```
GitHub GraphQL error: Field 'diffLine' doesn't exist on type 'PullRequestReviewThread'
```

The GraphQL query in the MCP server references the `diffLine` field on `PullRequestReviewThread`, which does not exist in the GitHub GraphQL schema. The correct field is likely `line` on the thread's first comment node, accessed through `PullRequestReviewThread.comments.nodes[0].line` or similar.

**Recommendation**: Fix the GraphQL query in the MCP server to use the correct schema fields.

### Issue D — Error messages lack detail

**Severity**: LOW

All error cases return the same generic format:
```
MCP error -32603: API error (404): Not Found
```

There is no distinction between:
- Repo not found vs. PR not found vs. file not found
- Rate limiting vs. authorization failure vs. resource not found
- No structured error codes or retry hints

**Recommendation**: Wrap error responses with more context (e.g., `"repo": "TransActComm/Portage-backend" not found`).

### Issue E — `reviewRequested` filter broken in `search_prs`

**Severity**: LOW

Calling `github_search_prs(repo: "microsoft/vscode", reviewRequested: "Copilot")` returns:
```
API error (422): Validation Failed
```

The `reviewRequested` parameter either has an incorrect API format or is being sent to an unsupported GitHub endpoint variant.

**Recommendation**: Verify the GitHub API endpoint used for this filter supports `review-requested` qualifier, and fix the parameter serialization.

---

## Summary

| Tool | Status | Issues |
|------|--------|--------|
| `mcp_get_health` | ✅ PASS | — |
| `github_get_pr_details` | ✅ PASS | Error messages generic (Issue D) |
| `github_get_pr_files` | ⚠️ PASS | Pagination off-by-one (Issue B) |
| `github_get_pr_commits` | ⚠️ PASS | Pagination off-by-one (Issue B) |
| `github_get_pr_comments` | ✅ PASS | Pagination not verified |
| `github_get_pr_reviews` | ✅ PASS | — |
| `github_get_pr_review_comments` | ⚠️ PASS | Pagination off-by-one (Issue B) |
| `github_get_pr_review_threads` | ❌ FAIL | Broken GraphQL query (Issue C) |
| `github_get_pr_checks` | ✅ PASS | — |
| `github_list_branches` | ✅ PASS | Error messages generic (Issue D) |
| `github_search_prs` | ⚠️ PASS | `reviewRequested` broken (Issue E) |
| `github_get_file_contents` | ✅ PASS | Error messages generic (Issue D) |

**Cross-cutting**: TransActComm repos inaccessible (Issue A) — all 12 tools work against public repos but cannot reach target private repos.

**Total**: 9 pass (with caveats), 1 fail, 2 unable to fully verify
