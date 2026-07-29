# Hardening and Capability Expansion — Defect Fixes + Missing Tool Surface

- **Goal:** Close every confirmed defect in toolkit-mcp (31 findings) and fill the 16 capability gaps that
  currently force an agent out of MCP and into a local git checkout.
- **Motivation:** Two read-only audits (2026-07-30) found that several tools are unusable as advertised —
  one ships an empty input schema, one silently returns nothing, two require arguments no tool can produce —
  and that the single most common agent workflow, *reading a PR diff*, has no MCP path at all. That last gap
  is why `.claude/skills/pr-review/SKILL.md` builds a git worktree and shells out to `git diff` for every
  review.
- **Source audits:** capability gaps and code-health findings, `mcp-capability-gaps.md` /
  `mcp-code-health.md`. Finding IDs below (C1–C4, H1–H9, M1–M10, D1–D2, T1–T3, S1–S5, gaps 1–16) refer to
  those documents.

---

## Architecture Decisions

### 1. Defects before features, and shared helpers before the defects that need them

**Decision:** Phase 1 fixes defects only. Within Phase 1, the two deduplication refactors (D1, D2) land
*before* the correctness fixes that would otherwise have to be applied many times over.

**Rationale:** H4 (`REPO_PATTERN` accepts `..`) currently has to be fixed in **32 places** — 17 client call
sites plus 15 inlined copies in Zod schemas. M6 (retry misses 403/socket errors) has to be fixed in **4**
copies of `installRetry`. Doing D1/D2 first turns both into single-site edits, and `getPullRequestChecks`
(`github-client.ts:731`) — which forgot its repo check entirely and is safe only by accident — gets covered
for free.

### 2. The `zodToJsonSchema` fix is the highest-priority item in the entire plan

**Decision:** C2 is item 1.1, before anything else, and ships with a systemic regression test.

**Rationale:** `zodToJsonSchema` (`src/integrations/helpers.ts:36-41`) unwraps exactly one `ZodEffects`
layer, and every `.refine()` adds one. `githubCreatePrReviewCommentSchema` has three refines, so the tool is
advertised to the model as `{"type":"object","properties":{}}` — **verified live** against the running
server. The tool cannot be called correctly by any client. This also means the `inReplyTo` reply capability
added on 2026-07-30 is currently unreachable despite being correct at the client and handler layers.

Blast radius is exactly one tool today (`update_pr` and `submit_pr_review` have one refine each and
advertise fine), but any future second refine silently breaks its tool. The regression test must therefore
assert the *invariant*, not the instance: for every descriptor returned by every module's
`getToolDescriptors()`, `inputSchema.properties` is non-empty whenever the underlying schema has fields.
Existing descriptor tests only check `inputSchema` is defined, which is why this went unnoticed.

### 3. Diff reading is the load-bearing capability, and it changes `pr-review`

**Decision:** Phase 2 adds `github_get_pr_files`, `github_get_file_contents`, and `github_get_pr_commits`.
Once they land, `pr-review` can review a PR without a worktree.

**Rationale:** `github_get_pr_details` returns only *counts* (`changedFiles`, `additions`, `deletions` —
`github-client.ts:710-712`). There is no file list and no patch text anywhere in the server. This also
unblocks inline commenting: `github_create_pr_review_comment` requires a diff-valid `line` and a
`commitId`, and today the only source of a SHA is `PullRequestDetail.headSha` — which goes stale the moment
the author pushes, producing 422s.

**Deliberately not done in this plan:** rewriting `pr-review/SKILL.md` to drop the worktree. The tools land
first and get proven on a real PR; changing the review skill is a follow-up with its own verification, since
a worktree also gives the reviewer the full repo for context that `get_file_contents` only approximates.

### 4. GraphQL becomes a first-class helper, not a one-off

**Decision:** Extract the GraphQL call pattern established by `setPullRequestDraft`
(`github-client.ts:823`) into a private `graphql<T>(query, variables)` method on `GitHubClient`, then build
thread resolution on it.

**Rationale:** `setPullRequestDraft` already does the two things every GraphQL call needs — resolve the REST
`node_id`, and detect the `errors` array that GitHub returns *with a 200 status*. Thread resolution (gap 2)
needs both. Two call sites justify the helper; a third (dismissals) is likely.

### 5. Pagination gets one correct implementation, copied from Jenkins

**Decision:** Adopt the `limit + 1` probe that `JenkinsClient` already uses
(`jenkins-client.ts:198-208`) as the standard for every GitHub list tool, and prefer GitHub's `Link` header
where available (`parseNextLink` already exists at `github-client.ts:451` and is unused by these paths).

**Rationale:** Four handlers infer `hasMore` from `results.length >= limit`, which is wrong whenever the last
page is exactly full — the agent burns a round trip on a guaranteed-empty page. Jenkins is the only correct
implementation in the repo; there is no reason to invent a second approach.

### 6. Tools that require unobtainable arguments are treated as defects, not gaps

**Decision:** Fix `jira_update_comment` and `jira_assign_issue` in Phase 1, not Phase 4.

**Rationale:** Both are *registered and advertised* but uncallable. `jira_update_comment` needs a
`commentId` that `toSlimComment` strips (`slim.ts:83-89`), and `jira_assign_issue` needs an `accountId` with
no lookup path — only `'me'` and `'none'` work. A tool the agent cannot call is a bug in the same class as
C2, and the `commentId` fix is one line in `slim.ts`.

### 7. Confluence write support is scoped to create/update page only

**Decision:** Phase 4 adds `confluence_create_page` and `confluence_update_page`. No attachments, no
comments, no page deletion.

**Rationale:** This is the only genuinely *large* item in the audit — it needs storage-format XHTML
generation and version-number optimistic locking on update (Confluence rejects an update whose `version.number`
is not exactly current+1). Create/update covers the actual ask ("document this in Confluence"). Deletion is
destructive and deliberately omitted.

---

## Phase 1 — Defect fixes (23 findings)

No new tools. Every item ends with a test that fails before the fix.

### 1.1 Schema advertisement (C2) — do this first

| | |
|---|---|
| **File** | `src/integrations/helpers.ts:36-41` |
| **Fix** | `while (s instanceof z.ZodEffects) s = s.innerType();` then the `ZodObject` check |
| **Test** | New `src/integrations/helpers.test.ts` (T1): a 3-refine schema round-trips with all fields; plus a loop over every module's `getToolDescriptors()` asserting non-empty `properties` |
| **Verify** | `github_create_pr_review_comment` advertises `repo`, `prNumber`, `path`, `body`, `commitId`, `line`, `inReplyTo`, … and an inline reply succeeds end-to-end on a real PR |

Also fix, in the same file, `zodToJsonSchema`'s lossy fallback: unrecognised types degrade to
`{type:'string'}` (`helpers.ts:33`), so a nullable number is advertised as a string. Handle `ZodNullable` /
`ZodOptional` unwrapping and `ZodArray` `items` at minimum.

### 1.2 Deduplication first (D1, D2)

| Item | Change | Notes |
|---|---|---|
| D1a | `assertRepo(repo): void` in `github-client.ts`, replacing 17 inline checks (lines 469, 493, 517, 536, 558, 594, 686, 717, 772, 824, 847, 875, 910, 925, 939, 947, 958) | Add the missing call in `getPullRequestChecks:731` |
| D1b | Exported `repoField` Zod schema in `integrations/github/module.ts`, replacing 15 inlined regex copies (lines 40, 53, 63, 73, 86, 99, 114, 128, 141, 177, 192, 261, 272, 282, 300) | Mirror `jobField` in `integrations/jenkins/module.ts:9-14`, which already does this |
| D2a | `mapPullRequestDetail(data, repo)`, replacing the 20-field duplicate at `github-client.ts:692-713` and `:794-815` | Also collapses the 3 copies of the `closed + merged_at → 'merged'` derivation (`:402`, `:690`, `:792`) |
| D2b | `src/services/http-retry.ts` with a shared `installRetry(http, opts)`, replacing 4 copies (`jira-client.ts:71-90`, `github-client.ts:188-207`, `confluence-client.ts:80-99`, `jenkins-client.ts:96-115`) | Keep Jenkins's `__noRetry` as an option |
| D2c | One shared issue-key regex, replacing 3 subtly different copies (`github-client.ts:8`, `github/module.ts:14`, `github/index.ts:39` — the last is case-sensitive and unbounded) | |

D2a earns its own regression test: assert `getPullRequest` and `updatePullRequest` return
*shape-identical* objects. The current tests assert individual fields, which is how a field can be mapped in
one and forgotten in the other.

### 1.3 Correctness

| ID | Finding | File:line | Fix |
|---|---|---|---|
| C1 | `searchBranches: true` always returns nothing — `parseItems` is fed `/pulls` objects but reads `repository_url` / `pull_request.merged_at`; the `TypeError` is swallowed by `Promise.allSettled` | `github-client.ts:647`, `:398-409` | New `parsePulls(items, repo)` reading top-level `merged_at`. **Also fix the fixture at `github-client.test.ts:625`**, which injects `repository_url` into a mocked `/pulls` response — fields the real endpoint never returns, which is why this passes today |
| C3 | `github_get_prs` ignores `cursor`, always `hasMore: false` — PRs past `limit` are permanently unreachable | `github/module.ts:348, 353, 373, 378` | Honour `cursor` as an offset; emit `nextPageToken` when `allPrs.length > offset + limit` |
| C4 | `dotenv({override: true})` lets a stale repo `.env` overwrite host-supplied credentials | `services/config.ts:2` | Drop `override: true` (dotenv's default — real env wins — is correct for an MCP server) |
| H2 | `hasMore = length >= limit` invents a phantom page on an exactly-full page | `github/module.ts:417, 441, 505, 544` | `limit + 1` probe per decision 5 |
| H3 | `searchPrs` called with `maxResults: undefined`, then sliced — fans out one `GET /pulls/{n}/reviews` per matched PR and discards most | `github/module.ts:360` vs `github-client.ts:250-252` | Pass `limit` as `maxResults`. Same shape in `findPrsForIssueKeys` (`module.ts:348`) |
| H7 | `jira_get_issues` ignores Jira's `isLast` and trusts `nextPageToken` alone | `jira/module.ts:197` | `paginated(items, result.isLast ? undefined : result.nextPageToken)` |
| H9 | `MAX_BRANCH_SEARCH_CALLS` unenforceable — all callbacks read the pre-increment value under `Promise.allSettled`, exceeding the cap ~2×; and one big repo starves the rest because `break` exits the repo loop | `github-client.ts:591, 605, 608-616, 632, 645` | Counter decremented *before* each request; `continue` not `break`; per-repo budget |
| M8 | `fetchAllPages` caps at 5 pages with no signal; declared `linkHeader` never populated; `currentParams` dead | `github-client.ts:421-444` | Return whether a `next` link remained; delete `currentParams` |
| M10 | `jenkins_healthcheck` re-downloads the full job list once per page | `jenkins/module.ts:136-146` | One `getJobs({offset:0, limit:100})` and read `total` |

### 1.4 Error reporting and contracts

| ID | Finding | File:line | Fix |
|---|---|---|---|
| H1 | `describeGitHubError` / `describeError` exist, are exported and unit-tested, but **no** Jira/GitHub/Figma handler calls them — a 422's `"path is not part of the diff"` reaches the agent as `Request failed with status code 422` | `mcp-server.ts:171-174`, `github-client.ts:1038`, `jira-client.ts:328` | Adopt the `toMcp(err)` wrapper that `confluence/module.ts:73` and `jenkins/module.ts:82` already use |
| H5 | Confluence returns `{results, start, limit, size}` instead of the mandated `{items, nextPageToken?, hasMore}` | `confluence-client.ts:48-55`, `confluence/module.ts:81, 115` | Map `results`→`items`, `start+size`→`nextPageToken`; keep `totalSize` as a per-tool extra. The client's `hasMore: !!data._links?.next` (`:127`) is already correct |
| H6 | `jira_get_issues` returns a raw `JiraIssue` instead of `SlimIssue` when `fields` is set, and in the `jql` path slims a narrowed field set so `summary` is `""` and `status`/`assignee` are null — indistinguishable from genuinely empty | `jira/module.ts:161-180, 192` | Always slim, or return raw under a distinct key. Stop letting shape depend on `fields` |
| M2 | Resource errors always report the *last* handler's failure, so `jira://issue/TRIPS-99999` surfaces `Unknown resource:` instead of the real 404 | `mcp-server.ts:190-202` | Dispatch by URI scheme |
| M3 | `keys` schema says `.max(50)`, client truncates to 20 and warns to stderr (invisible to MCP clients) using deprecated `--with-prs` CLI vocabulary | `github/module.ts:19` vs `github-client.ts:286-289` | Schema max 20 (or chunk); drop the CLI wording |
| M9 | Any unparseable cursor silently becomes page 1 — `parseInt('abc')` → `NaN` → `page: NaN` in the query string | `jenkins/module.ts:23-27`; `github/module.ts:412, 436, 496, 539` | Reject non-positive-integer cursors with `McpError(InvalidParams)` |
| S4 | Tool descriptions violate the one-sentence rule (`github_search_prs`, `confluence_search`, `confluence_get_page`); CLAUDE.md's table has drifted from the code and omits `draft` | `github/module.ts:627`, `confluence/module.ts:126, 132`, `CLAUDE.md:164-166` | Fold second sentences into parameter `.describe()`; re-sync the table |

### 1.5 Uncallable tools (gaps 5, 9)

| Finding | File:line | Fix |
|---|---|---|
| `jira_update_comment` needs a `commentId` that `toSlimComment` strips | `slim.ts:26, 84` | Add `id` to `SlimComment` and map it — one line each. Fixes it everywhere at once |
| `jira_assign_issue` needs an `accountId` with no lookup — only `'me'`/`'none'` work | `jira/module.ts:76-84, 258-274` | Resolve a display name/email inside the handler via `GET /rest/api/3/user/search`; add `jira_search_users` in Phase 4 |

### 1.6 Safety and robustness

| ID | Finding | File:line | Fix |
|---|---|---|---|
| H4 | `REPO_PATTERN` matches `..`, and WHATWG URL normalization means `repo: "../.."` sends `DELETE /pulls/comments/{id}` — outside the intended `/repos/{owner}/{name}` sandbox, carrying `GH_TOKEN`. Defence-in-depth, not a proven escalation, but the guard does not do what its comment claims | `github-client.ts:6` | Per-segment validation rejecting `.`/`..`, in the single `assertRepo` from 1.2 |
| H8 | `validateJql`'s unanchored `/update/i`, `/create/i`, `/admin/i` blocklist rejects `ORDER BY updated DESC`, `created >= -7d`, `assignee = admin@…` — while providing no protection, since JQL is read-only and the tool path skips the check entirely | `jira/index.ts:30-47, 119` | Delete it, or reduce to a length cap |
| M4 | `FigmaClient` alone has no retry and **no timeout** — a stalled connection leaves `tools/call` pending forever | `figma-client.ts:125-147` | `AbortSignal.timeout(30_000)` + the shared retry from D2b |
| M6 | Retry misses what matters: GitHub's *secondary* rate limit is **403 + `retry-after`** (not retried); `ECONNRESET`/`ETIMEDOUT`/`EAI_AGAIN` carry no response (not retried); and retrying `POST` after a 5xx that GitHub already processed **double-posts** `addPrComment` / `submitPrReview` | `github-client.ts:192-193` + 3 copies | Add 403+`retry-after` and socket codes; restrict write-method retries to errors with no `response`. Acknowledged for Jira (`jira-client.ts:67-69`) but not GitHub |
| M1 | `branchRefsCache` never invalidates for the process lifetime — a branch pushed after the cache warmed is invisible, indistinguishable from "no PR exists". Unbounded in size | `github-client.ts:580, 602, 617` | Store `{at, refs}`, treat >60s as cold |
| M7 | `jira_get_attachment` inlines unbounded base64 — a 12 MB PDF becomes ~16 MB of base64 held as Buffer *and* string in one response. `size` was already fetched and ignored. Description promises a data URI no code path produces | `jira/module.ts:313-327`, `jira-client.ts:295-300` | Threshold on the known `size`; return metadata only above it; fix the description |
| M5 | `figma_get_file` returns the entire multi-MB document tree with no narrowing — one call can blow the context window | `figma-client.ts:155-157` | See Phase 4 (`depth` param); interim guard here |
| S1 | `loadMcpConfig()` copies the Jira token into a field nobody reads — `mcp-server.ts:29-37` re-reads `process.env` for all credentials. One `log(JSON.stringify(config))` from stderr exposure, and stderr *is* captured by MCP clients | `mcp-config.ts:15-22` | Return `jiraConfigured: boolean` |
| S2 | Figma error messages dump the raw response body (an HTML error page lands whole in the agent's context) | `figma-client.ts:141-144` | Truncate to ~500 chars |
| S3 | `MCP_TRANSPORT?.trim() ?? 'stdio'` — an empty env var yields `''`, falls into the "HTTP not implemented" branch and logs a misleading warning; both casts assert unvalidated values. `GH_REPOS` is evaluated at module load and works only because `services/index.ts:1` imports `jira-client` (→ dotenv) before line 2 imports `github-client` | `mcp-config.ts:11, 13`; `github-client.ts:151` | `\|\|` not `??`; validate against the allowed set; read `GH_REPOS` in the constructor |
| S5 | The Jira resource handler passes `uri.slice(...)` straight through where the GitHub one validates — a garbage URI yields a mangled 404 rather than `InvalidParams` | `jira/index.ts:107-110` | Validate the key; use the shared regex from D2c |

**Phase 1 exit criteria:** `npm run typecheck` clean; `npm run test` green with new tests for every item
above; the C2 invariant test present; `github_create_pr_review_comment` proven end-to-end on a real PR.

---

## Phase 2 — Diff reading (gaps 1, 7, 8)

The capability that removes `pr-review`'s dependency on a git worktree.

| Tool | Endpoint | Client method | Notes |
|---|---|---|---|
| `github_get_pr_files` | `GET /repos/{repo}/pulls/{n}/files` | new `getPrFiles` | Per-file `patch`, `status`, additions/deletions. **Needs a truncation strategy** — patches are large. Paginate, and let the agent request specific paths. A raw-diff variant (`Accept: application/vnd.github.v3.diff`) is worth considering as a second mode |
| `github_get_pr_commits` | `GET /repos/{repo}/pulls/{n}/commits` | new `getPrCommits` | Fixes the stale-SHA 422 problem, and enables commit-message review (conventional commits, TRIPS-key references, was-it-squashed) |
| `github_get_file_contents` | `GET /repos/{repo}/contents/{path}?ref=` | new `getFileContents` | Base64 decode + size guard. Needed to judge a hunk against its surrounding file, and to review forks / repos not checked out locally |

**Placement:** client methods after `getPullRequest` (`github-client.ts:714`); schemas `github/module.ts` ~135;
handlers ~456; descriptors ~614; wiring `github/index.ts:77`.

**Exit criteria:** an agent reviews a real PR — reads changed files, reads a full file at the head ref, and
leaves a correctly-positioned inline comment — using MCP only, with no local checkout.

---

## Phase 3 — Review lifecycle (gaps 2, 3, 4, 6, 11, 12)

| Item | Endpoint | Effort | Notes |
|---|---|---|---|
| `graphql<T>()` private helper | — | small | Extract from `setPullRequestDraft` per decision 4 |
| `github_resolve_review_thread` / unresolve | GraphQL `resolveReviewThread` / `unresolveReviewThread` + a `reviewThreads` query | needs-GraphQL | **The largest "agent repeats itself" gap.** `PrReviewComment` (`github-client.ts:77-93`) has `inReplyToId` but no `isResolved`/`threadId`, so a re-review agent re-comments on threads it already resolved. REST has no equivalent |
| `github_merge_pr` | `PUT /repos/{repo}/pulls/{n}/merge` | small | `mergeMethod` merge/squash/rebase, optional `sha` guard. **Currently an agent's only option is `update_pr {state:'closed'}`, which closes without merging** — a plausible and destructive substitute. Surface 405 (not mergeable) and 409 (sha mismatch) clearly |
| `github_request_pr_reviewers` | `POST`/`DELETE /pulls/{n}/requested_reviewers` | small | The standard loop after `REQUEST_CHANGES`. Note draft-conversion dismisses pending requests, so this pairs with the draft toggle |
| `github_update_pr_labels`, `github_update_pr_assignees` | `POST`/`DELETE /issues/{n}/labels`, `/assignees` | small | Labels gate merge queues in many repos |
| `PullRequestDetail` read-side fields | — | trivial | Add `requestedReviewers`, `requestedTeams`, `labels`, `assignees` — one edit now that D2a exists. Today an agent cannot even *read* who is pending; `reviewStatus` returns `REVIEW_REQUIRED` whether or not anyone was asked (`github-client.ts:991`) |
| `github_search_prs` filters | — | small | Add `label:`, `review-requested:`, `base:` to the query builder (`github-client.ts:850-862`) |
| `github_delete_pr_comment` | `DELETE /issues/comments/{id}` | trivial | Review comments have create/update/delete; issue comments have no delete, so a wrong summary comment can only be edited to "(removed)" |
| `github_dismiss_pr_review` | `PUT /pulls/{n}/reviews/{id}/dismissals` | small | Dismiss a stale `CHANGES_REQUESTED` blocking merge |
| `github_get_pr_reviews` pagination | — | trivial | Returns a bare array from an unpaginated first page (default 30), breaking the envelope convention (M-tier, `github-client.ts:720`, `github/module.ts:458-462`) |
| CI feedback loop | `POST /check-runs/{id}/rerequest`, `POST /actions/runs/{id}/rerun-failed-jobs`, job logs | small/medium | "CI is red, why?" currently dead-ends at an html URL the agent cannot fetch — `PullRequestChecks` gives name/conclusion/URL only. `jenkins_get_console` is the model. Log download follows a redirect to a zip; that part is medium |

---

## Phase 4 — Other integrations (gaps 10, 13, 14, 16)

| Item | Effort | Notes |
|---|---|---|
| `jira_get_comments` | trivial | **Dead capability** — `JiraClient.getComments` (`jira-client.ts:123`) returns ids but no tool exposes it |
| `jira_list_transitions`, `jira_list_issue_link_types` | trivial | **Dead capabilities** (`jira-client.ts:228`, `:263`), called only internally. The agent's only discovery route today is to guess a name and read the error's "Available: …" list (`jira/module.ts:238, 342`) — a deliberate failure used as a lookup, which invites guessing a wrong-but-valid transition |
| `jira_search_users` | small | Completes the 1.5 assignee fix |
| `jira_delete_comment` | trivial | Sibling gap next to add/update |
| `confluence_whoami` | trivial | Dead capability (`confluence-client.ts:107`); Jira and Figma both expose theirs |
| `confluence_create_page`, `confluence_update_page` | large | Per decision 7 — storage-format XHTML + version optimistic locking. No delete |
| Figma `depth` / `ids` / `geometry` / `version` params | trivial | Pass-throughs on `getFile` (`figma-client.ts:155`) and `getNodes` (`:160`). `getVersions` currently returns version ids that cannot be passed anywhere |
| Figma slim node-tree transform | small | Drop `document` unless requested; every other integration slims its payload (`slim.ts`, `storageToText`, Jenkins `tree=`) — Figma is the outlier |
| `figma_post_comment` | trivial | `POST /v1/files/{key}/comments` — the design-feedback loop is read-only today |

**Explicitly out of scope:** Jenkins build triggering. `jenkins_*` tools are read-only by documented policy
(`CLAUDE.md:76`); that is a decision, not an oversight, and reversing it needs a separate conversation.

---

## Phase 5 — Test coverage (T1, T2, T3)

Whole modules with **zero** test files:

| Module | Lines / surface | Highest-value untested logic |
|---|---|---|
| `src/services/jira/jira-client.ts` | 339 lines, 20 public methods | `getComments` pagination (`:126-134`), `getIssueSlim`'s truncated-comment refetch (`:114-118`), `searchAll`'s `isLast` handling (`:151-157`), `getAttachmentContent` (`:291-315`), `toAdf` |
| `src/services/figma/figma-client.ts` | all 8 methods | the error path at `:141-144` |
| `src/services/slim.ts` | — | `adfToText` (`:109-125`) — recursive, non-obvious inline-vs-block separators, and **every** Jira response passes through it |
| `src/integrations/helpers.ts` | — | `zodToJsonSchema` — exactly where C2 hid |
| `src/services/config.ts` | — | `loadConfluenceConfig`'s `/wiki` normalization (`:66`), and C4 |

`jira-client.test.ts` is the single highest-value addition; mirror the `mockAxiosInstance` pattern from
`github-client.test.ts`.

Also: `GitHubClient.getPrComments` (`:512`) and `.updatePrComment` (`:535`) have no describe block in the
1712-line client test; `confluenceListSpacesHandler` (`confluence/module.ts:106`) has no handler test.
And `src/services/error-helpers.test.ts` is named after a module that does not exist (T3) — either rename
it, or extract the **five** near-identical `describe*Error` copies into the `error-helpers.ts` the name
implies, which is the better fix and pairs naturally with H1.

---

## Risks and sequencing notes

1. **C2's fix widens what the model sees.** Once `github_create_pr_review_comment` advertises its real
   parameters, agents will start calling it for the first time. Expect latent bugs in a path that has never
   run under load — this is why Phase 1 ends with a real-PR verification rather than green tests alone.
2. **D1/D2 touch ~50 call sites with no behaviour change.** Land them as their own reviewable commits,
   before the correctness fixes, and rely on the existing 362 tests as the regression net.
3. **H6's fix is a breaking response-shape change** for any caller relying on `jira_get_issues` returning
   raw issues when `fields` is set. Nothing in this monorepo appears to, but confirm before shipping.
4. **M6's write-retry fix changes failure semantics** — some transient failures that currently succeed via a
   duplicate-posting retry will start surfacing as errors. That is correct (a double-posted review is worse),
   but it will look like a regression.
5. **Phase 3's thread resolution needs a token with PR-write scope**, same as the draft toggle. A read-only
   `GH_TOKEN` returns `Resource not accessible`.
6. **`.md` files stay out of commits** per the monorepo prohibition — including this plan — unless asked.

## Verification per phase

```bash
cd /ezat/toolkit-mcp
npm run typecheck     # must stay clean
npm run test          # 362 baseline, growing each phase
```

Plus, per phase, an end-to-end check against a real PR through the running MCP server — the audit's two most
serious findings (C1, C2) both passed the unit suite. **Restart the MCP server after any schema change**;
tool descriptors are cached at connection time.
