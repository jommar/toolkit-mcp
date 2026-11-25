# toolkit-mcp — GitHub reference

Loaded from [`../SKILL.md`](../SKILL.md). GitHub tools register only if `GH_TOKEN` is set.

## Tools

| Tool | Use for | Key params |
|------|---------|-----------|
| `github_get_prs` | PRs for issue key(s), searched in titles, bodies and (optionally) branch names | `issueKey` **or** `keys[]`; `state`(open), `limit`(20), `cursor`, `searchBranches`(false) |
| `github_get_copilot_unresolved_prs` | PRs with the full body of every **unresolved** Copilot review thread | `repo`; `prNumbers[]?` (omit = your PRs, `[]` = all authors, list = those PRs), `state`(open), `limit`(20), `cursor` |
| `github_get_code_review_ready` | Jira issues in a status (default "Ready For Code Review") with per-PR human-approval status and an `allApproved` flag | `status`, `project`, `assignee`(currentUser()), `prState`(open) |
| `github_search_prs` | Flexible PR search | at least one of `query`/`author`/`repo`/`label`/`reviewRequested`/`base`; `state`(open), `limit`, `cursor` |
| `github_get_pr_details` | Body, files, additions/deletions, mergeable, branches | `repo`, `prNumber` |
| `github_get_pr_commits` | Commits with author and SHA | `repo`, `prNumber`; `limit`(20), `cursor` |
| `github_get_pr_files` | Changed files (patch text truncated at 2000 chars) | `repo`, `prNumber`; `limit`(20), `cursor` |
| `github_get_pr_comments` | Issue-level (conversation) comments | `repo`, `prNumber`; `limit`(20), `cursor` |
| `github_get_pr_reviews` | Reviews and thread summaries | `repo`, `prNumber` |
| `github_get_pr_review_comments` | Inline review comments on the diff | `repo`, `prNumber`; `limit`(20), `cursor` |
| `github_get_pr_review_threads` | All review threads, with resolution and staleness | `repo`, `prNumber` |
| `github_get_pr_checks` | CI / status checks for the latest commit | `repo`, `prNumber` |
| `github_list_branches` | Branches in a repo | `repo`, `limit`(20), `cursor` |
| `github_get_file_contents` | File contents from a repo (base64, up to 100KB) | `repo`, `path`; `ref?` |
| `github_create_pr` | Open a PR | `repo`, `title`, `head`, `base`; `body?`, `draft`(false) |
| `github_update_pr` | Edit title, body, state, base or draft | `repo`, `prNumber`; at least one of `title`/`body`/`state`/`base`/`maintainerCanModify`/`draft` |
| `github_add_pr_comment` | Comment on a PR | `repo`, `prNumber`, `body` |
| `github_update_pr_comment` | Edit an issue-level comment | `repo`, `commentId`, `body` |
| `github_delete_pr_issue_comment` | Delete an issue-level comment | `repo`, `commentId` |
| `github_create_pr_review_comment` | Inline review comment or thread reply; optional `suggestedReplacement` | `repo`, `prNumber`, `body` + (`path`/`commitId`/`line`) **or** `inReplyTo` |
| `github_update_pr_review_comment` | Edit an inline review comment | `repo`, `commentId`, `body` |
| `github_delete_pr_review_comment` | Delete an inline review comment | `repo`, `commentId` |
| `github_submit_pr_review` | Formal review: APPROVE / REQUEST_CHANGES / COMMENT, optionally with inline comments | `repo`, `prNumber`, `event`; `body?`, `commitId?`, `comments[]?` |
| `github_resolve_review_thread` | Resolve a review thread | `repo`, `threadId` (GraphQL node id) |
| `github_unresolve_review_thread` | Unresolve a review thread | `repo`, `threadId` |
| `github_request_pr_reviewers` | Request reviewers by username or team slug | `repo`, `prNumber`, `reviewers[]`; `teamReviewers[]?` |
| `github_update_pr_labels` | Replace all labels on a PR | `repo`, `prNumber`, `labels[]` |
| `github_update_pr_assignees` | Add assignees to a PR | `repo`, `prNumber`, `assignees[]` |
| `github_dismiss_pr_review` | Dismiss a review with a reason | `repo`, `prNumber`, `reviewId`, `message` |
| `github_merge_pr` | Merge with method and a SHA guard | `repo`, `prNumber`; `mergeMethod`(merge), `sha?` |

`repo` is always `"owner/name"`. PR search covers the repos configured by `GH_REPOS` (or the default org) unless you pass `repo`.

## Behaviors

- **GitHub cursors are page numbers** under the hood — still treat `nextPageToken` / `cursor` as opaque.
- **`github_get_prs` `searchBranches: true`** also matches PRs whose branch name contains the key, merged in de-duplicated by URL — useful when a PR's title and body omit the key.
- **`github_get_copilot_unresolved_prs` `limit` bounds PRs *scanned*, not matches** — discovery filters by author after paging, so `items: []` with `hasMore: true` is normal; keep paging until `hasMore` is false. Resolved threads never appear, replies and human-started threads are excluded, and outdated-but-unresolved threads still count. A PR whose threads couldn't be read lands in `errors` — that is "unknown", not "no findings". Cursors are scope-bound: change `repo`, selection, `state` or `limit` and the cursor is rejected.
- **`github_get_code_review_ready` counts human approvals only:** bot and PR-author approvals don't count, and an approval-check failure is annotated on the PR, not fatal.
- **`mergeable` from `github_get_pr_details` may be `null`** while GitHub is still computing it — don't read null as "not mergeable".
- **Merging is outward-facing and irreversible:** pass the `sha` you reviewed so a newer push makes the merge fail instead of shipping unreviewed commits.

## Recipes

**Find an issue's open PRs, then inspect one**

```text
github_get_prs { issueKey: "PROJ-123" }                 // → items[].repo, prNumber, htmlUrl
github_get_pr_details { repo: "acme/api", prNumber: 412 }
github_get_pr_checks  { repo: "acme/api", prNumber: 412 }
```

**Code review backlog — which issues are ready to ship** (`allApproved: true` = every PR approved by a human)

```text
github_get_code_review_ready {}
github_get_code_review_ready { status: "In Review", assignee: "alice", prState: "all" }
```

**Outstanding Copilot feedback**

```text
github_get_copilot_unresolved_prs { repo: "acme/api" }                          // my open PRs
github_get_copilot_unresolved_prs { repo: "acme/api", prNumbers: [393, 400] }   // specific PRs, any author or state
github_get_copilot_unresolved_prs { repo: "acme/api", prNumbers: [], state: "all" }
```

**Review a PR end-to-end**

```text
github_get_pr_reviews { repo: "acme/api", prNumber: 412 }
github_get_pr_review_threads { repo: "acme/api", prNumber: 412 }
github_get_pr_files { repo: "acme/api", prNumber: 412 }
github_get_pr_commits { repo: "acme/api", prNumber: 412 }
```

**Act on review threads, then ship**

```text
github_create_pr_review_comment { repo: "acme/api", prNumber: 412, body: "see suggestion", path: "src/x.ts", commitId: "<sha>", line: 42, suggestedReplacement: "..." }
github_resolve_review_thread { repo: "acme/api", threadId: "<node id from github_get_pr_review_threads>" }
github_merge_pr { repo: "acme/api", prNumber: 412, mergeMethod: "squash", sha: "<head commit sha>" }
```

**Open a PR**

```text
github_create_pr { repo: "acme/api", title: "PROJ-123: ...", head: "feature/PROJ-123-...", base: "main", body: "...", draft: false }
```
