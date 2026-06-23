# GitHub MCP Tool Expansion — Testing Workflow

## Goal and Motivation

The existing GitHub integration in toolkit-mcp provides 3 tools: `github_get_prs`, `github_create_pr`, and `github_list_branches`. These cover PR discovery and creation but stop short of the complete PR review workflow. When an AI agent finishes coding on a branch, it needs to:

1. Create a PR (`github_create_pr` — exists)
2. Check PR details (files changed, mergeable state, diff stats)
3. Check review status and comments (`github_get_prs` returns only a summary `reviewStatus` enum)
4. Check CI/status check results
5. Search PRs by author, repo, or state (not just by Jira issue key)

These capabilities close the loop from "code written" through "PR merged" without requiring the agent to switch to a browser.

**Ticket:** [TRIPS-NNNN](https://pathwise.atlassian.net/browse/TRIPS-NNNN) (insert actual ticket when available)

---

## Architecture Decisions

### 1. New `GitHubClient` methods live in `jira-cli` library

The existing pattern (established in Phase 2 of the original plan) is that new MCP capabilities get their library-layer methods added to `GitHubClient` first, then the MCP module wraps them. This keeps the library reusable (CLI + programmatic consumers unaffected) and the MCP layer thin.

**Decision:** Add 4 new public methods to `GitHubClient` in `/ezat/jira-cli/src/github-client.ts`. The MCP layer's `module.ts` calls these methods.

### 2. No new integation module — extend existing GitHub module

All four tools belong under the existing `src/integrations/github/` module. No new module directory, no changes to `src/integrations/index.ts` (the module registry already imports `GitHubModule`).

### 3. Response shapes are slim by default

Following the existing convention, tool responses are compact JSON with `undefined` fields omitted. Paginated tools use the standard `PaginatedResponse<T>` envelope with `items`, `hasMore`, and `nextPageToken`.

### 4. All tools return plain objects directly

Per existing conventions: scalar/action tools (`github_create_pr`) return the object directly. Detail tools (`github_get_pr_details`, `github_get_pr_reviews`, `github_get_pr_checks`) also return the raw object — no `{ data: ... }` wrapper. This matches the existing `github_create_pr` pattern of `JSON.stringify(object)` directly.

---

## New `GitHubClient` Methods (jira-cli library)

The following methods must be added to `/ezat/jira-cli/src/github-client.ts`. They are also exported from `src/index.ts`.

### 1. `getPullRequest`

```typescript
interface PullRequestDetail {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed' | 'merged';
  htmlUrl: string;
  repo: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeable: boolean | null;   // null = still computing
  mergedBy: string | null;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  changedFiles: number;
  additions: number;
  deletions: number;
}

async getPullRequest(repo: string, prNumber: number): Promise<PullRequestDetail>
```

**API:** `GET /repos/{owner}/{repo}/pulls/{number}`

**Note:** `mergeable` can be `null` — the handler must document this in the tool description so the agent knows to retry later if needed.

**State mapping:** GitHub API only returns `'open'` or `'closed'` for `state`. The library method must check `merged_at` alongside `state`: if `state === 'closed'` and `merged_at` is non-null, map to `'merged'`.

**Null-safe `author`:** GitHub API `user` field can be `null` (deleted accounts). Use `user?.login ?? 'unknown'` when mapping the response.

### 2. `getPullRequestReviews`

```typescript
interface PullRequestReview {
  id: number;
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED';
  body: string | null;
  submittedAt: string;
  commitId: string;
}

async getPullRequestReviews(
  repo: string,
  prNumber: number,
): Promise<PullRequestReview[]>
```

**API:** `GET /repos/{owner}/{repo}/pulls/{number}/reviews`

This is a refinement of the existing private `getReviewStatus` method. The existing method fetches reviews and reduces to a single enum; the new method returns the full review data. To avoid duplication, refactor `getReviewStatus` to call `getPullRequestReviews` internally.

### 3. `getPullRequestChecks`

```typescript
interface CheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;  // 'success' | 'failure' | 'neutral' | 'cancelled' | 'timed_out' | 'action_required' | null
  htmlUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

interface PullRequestChecks {
  totalCount: number;
  checkRuns: CheckRun[];
}

async getPullRequestChecks(
  repo: string,
  prNumber: number,
): Promise<PullRequestChecks>
```

**API:** `GET /repos/{owner}/{repo}/commits/{headSha}/check-runs` (requires the head SHA from the PR detail)

**Pagination:** The Check Runs API is paginated (default 30 per page). `getPullRequestChecks` must use `fetchAllPages` to collect ALL check runs from the check-runs endpoint before returning. The method already fetches the PR detail internally to get `headSha` — no two-step separation needed at the MCP handler level.

### 4. `searchPullRequestsByQuery`

```typescript
interface PrSearchOptions {
  query?: string;           // additional free-text search terms
  author?: string;          // GitHub login
  repo?: string;            // "owner/name" — narrows to one repo
  state?: 'open' | 'closed' | 'all';
  perPage?: number;
  page?: number;
}

async searchPullRequestsByQuery(
  opts: PrSearchOptions,
): Promise<PrSearchResult[]>
```

**API:** `GET /search/issues?q=type:pr+...`

Does NOT use `fetchAllPages`. Instead, passes `per_page` and `page` directly to the search API (same pattern as `listBranches`). The MCP layer maps `cursor` → `page` and wraps in `paginated()` — so `cursor` "1" maps to `page: 1`, "2" to `page: 2`, etc.

### Type Exports

Add these new types to `/ezat/jira-cli/src/index.ts`:

```typescript
export type { PullRequestDetail, PullRequestReview, CheckRun, PullRequestChecks } from './github-client.js';
```

---

## API Contracts — MCP Tools

### 1. `github_get_pr_details`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | `string` | yes | Repository "owner/name" |
| `prNumber` | `number` | yes | Pull request number |

**Response:** `PullRequestDetail` as JSON (single object, not in an envelope).

**Description:** "Get full PR details (body, files changed, additions/deletions, mergeable state, base/head branches) by repo + PR number."

### 2. `github_get_pr_reviews`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | `string` | yes | Repository "owner/name" |
| `prNumber` | `number` | yes | Pull request number |

**Response:** `PullRequestReview[]` as JSON (array — no pagination needed; typical PRs have < 50 reviews).

**Description:** "Get PR review comments and review thread summaries."

### 3. `github_get_pr_checks`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `repo` | `string` | yes | Repository "owner/name" |
| `prNumber` | `number` | yes | Pull request number |

**Response:** `PullRequestChecks` as JSON (single object with `totalCount` and `checkRuns` array).

**Description:** "Get PR status check / CI results (check-runs for the latest commit on the PR)."

### 4. `github_search_prs`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | `string` | no | Additional free-text search terms |
| `author` | `string` | no | GitHub username to filter by author |
| `repo` | `string` | no | Repository "owner/name" to filter by |
| `state` | `enum` | no | Default `"open"`. One of `"open"`, `"closed"`, `"all"`. |
| `limit` | `number` | no | Default `20`. Max `100`. |
| `cursor` | `string` | no | Opaque pagination token. |

At least one of `query`, `author`, or `repo` must be provided.

**Response:** `PaginatedResponse<PrSearchResult>` — standard envelope with `items`, `hasMore`, `nextPageToken`.

**Description:** "Flexible PR search by author, repo, state, or free-text query. Provide at least one of `query`, `author`, or `repo`."

---

## File Changes

### jira-cli (library layer)

| File | Action | What to add |
|------|--------|-------------|
| `src/github-client.ts` | Modify | Add `getPullRequest`, `getPullRequestReviews`, `getPullRequestChecks`, `searchPullRequestsByQuery` methods + new type interfaces |
| `src/github-client.ts` | Refactor | `getReviewStatus` (private) should call `getPullRequestReviews` internally instead of duplicating the API call |
| `src/github-client.test.ts` | Modify | Add tests for all 4 new methods |
| `src/index.ts` | Modify | Re-export the 4 new type interfaces |

### toolkit-mcp (MCP layer)

| File | Action | What to add |
|------|--------|-------------|
| `src/integrations/github/module.ts` | Modify | Add 4 Zod schemas, 4 handler factory functions, append 4 descriptors to `githubToolDescriptors` |
| `src/integrations/github/index.ts` | Modify | Wire 4 new handlers in `createToolHandlers()` |
| `src/integrations/github/module.test.ts` | Modify | Add tests for the 4 new handlers |
| `src/integrations/github/index.test.ts` | Modify | Update handler count expectations (3→7), add tests for new handler wiring |

No changes to:
- `src/integrations/index.ts` — module registry unchanged
- `src/mcp-server.ts` — no bootstrap changes needed
- `package.json` — no new dependencies
- `.env.example` — no new env vars

---

## Implementation Steps

### Step 1: Add types and methods to `GitHubClient` (jira-cli)

**Location:** `/ezat/jira-cli/src/github-client.ts`

1. Add new type interfaces:
   - `PullRequestDetail`, `PullRequestReview`, `CheckRun`, `PullRequestChecks`
2. Add public method `getPullRequest(repo, prNumber)`:
   - Validate `repo` format with `REPO_PATTERN`
   - Call `GET /repos/{repo}/pulls/{number}`
   - Extract all fields from response; note `mergeable` can be `null`
 3. Add public method `getPullRequestReviews(repo, prNumber)`:
    - Call `GET /repos/{repo}/pulls/{number}/reviews`
    - Map each review to `PullRequestReview`
    - Refactor `getReviewStatus` to call `getPullRequestReviews` and reduce:
      - Keep the same `for`-loop logic (APPROVED early-return, then CHANGES_REQUESTED, COMMENTED) but operate on `getPullRequestReviews` output instead of raw API response
      - This is a pure internal refactoring — the return type and semantics of `getReviewStatus` must not change
      - Tests must verify all four return values (APPROVED, CHANGES_REQUESTED, COMMENTED, REVIEW_REQUIRED) through the refactored path to guard against regression
4. Add public method `getPullRequestChecks(repo, prNumber)`:
   - First fetch PR detail to get `headSha`
   - Call `GET /repos/{repo}/commits/{headSha}/check-runs`
   - Return mapped `PullRequestChecks`
 5. Add public method `searchPullRequestsByQuery(opts)`:
    - Build the `q` parameter from `opts.query`, `opts.author`, `opts.repo`, `opts.state`
    - Call `/search/issues` with `per_page` and `page` from `opts` (defaults: `per_page=20`, `page=1`)
    - Uses `per_page`/`page` directly — does NOT use `fetchAllPages` (same pattern as `listBranches`)
    - Return parsed `PrSearchResult[]`
**Verify:** `npm run typecheck` passes; existing tests still pass.

### Step 2: Export new types from jira-cli index

**Location:** `/ezat/jira-cli/src/index.ts`

Add type exports for all 4 new interfaces. No new value exports needed (the class already has public methods).

### Step 3: Add MCP Zod schemas and handlers

**Location:** `/ezat/toolkit-mcp/src/integrations/github/module.ts`

1. Add 4 Zod schemas following existing patterns:
   - `githubGetPrDetailsSchema` — `repo` (regex `owner/name`), `prNumber` (z.number())
   - `githubGetPrReviewsSchema` — `repo`, `prNumber`
   - `githubGetPrChecksSchema` — `repo`, `prNumber`
    - `githubSearchPrsSchema` — `query?`, `author?`, `repo?`, `state?` (enum), `limit?`, `cursor?`. Must include a `.refine()` that requires at least one of `query`, `author`, or `repo`:
      ```typescript
      .refine(
        (data) => data.query || data.author || data.repo,
        { message: 'At least one of query, author, or repo must be provided' }
      )
      ```
2. Add 4 handler factories:
   - `githubGetPrDetailsHandler` — calls `clients.github.getPullRequest(repo, prNumber)`, returns the object directly
   - `githubGetPrReviewsHandler` — calls `clients.github.getPullRequestReviews(...)`, returns array
   - `githubGetPrChecksHandler` — calls `clients.github.getPullRequestChecks(...)`, returns object
   - `githubSearchPrsHandler` — builds options, calls `clients.github.searchPullRequestsByQuery(...)`, wraps in `paginated()` envelope

3. Append 4 new descriptors to `githubToolDescriptors` array.

### Step 4: Wire handlers in `GitHubModule`

**Location:** `/ezat/toolkit-mcp/src/integrations/github/index.ts`

Add 4 entries to the `createToolHandlers` return map, each wrapping the handler factory with Zod `.parse()` validation (matching existing pattern):

```typescript
github_get_pr_details: async (args) => {
  const parsed = githubGetPrDetailsSchema.parse(args);
  return await githubGetPrDetailsHandler(clients)(parsed);
},
// ... same for all 4
```

### Step 5: Add tests

**Location:** `/ezat/toolkit-mcp/src/integrations/github/module.test.ts`

Add test blocks for each new handler following existing `makeMockGitHub()` pattern:

- `githubGetPrDetailsHandler` — happy path, validates repo format rejection, handles null mergeable
- `githubGetPrReviewsHandler` — returns array, empty reviews
- `githubGetPrChecksHandler` — returns checks object, empty checks
- `githubSearchPrsHandler` — searches by author, by repo, by free-text query, paginated response, validates at least one filter

**Location:** `/ezat/toolkit-mcp/src/integrations/github/index.test.ts`

- Update handler count assertion from 3 to 7
- Add a smoke test for each new handler (verify it exists in the handlers map)

**Location:** `/ezat/jira-cli/src/github-client.test.ts`

Add tests for the 4 new methods (mocked axios, following existing test patterns):

- `getPullRequest` — happy path, null mergeable, missing fields
- `getPullRequestReviews` — multiple reviews, empty, refactored `getReviewStatus` still works
- `getPullRequestChecks` — happy path, empty checks
- `searchPullRequestsByQuery` — builds correct query string, pagination

---

## Testing Strategy

| Layer | Strategy | Mocks needed |
|-------|----------|-------------|
| `GitHubClient` methods (jira-cli) | Mock `this.http.get/post` with controlled responses | Axios mock (same pattern as existing `github-client.test.ts`) |
| MCP handler factories (module.ts) | Use `makeMockGitHub()` which provides `vi.fn()` stubs for all client methods | `GitHubClient` partial mock |
| MCP module wiring (index.ts) | Instantiate `GitHubModule`, call `createToolHandlers` with mock client, verify handlers exist and validate args via Zod | `GitHubClient` partial mock |

**Coverage targets:**
- Each new `GitHubClient` method: happy path + error path (API error, invalid params)
- Each MCP handler: happy path, invalid params (Zod rejection), and edge case (empty arrays, null fields)
- Module wiring: correct handler count, Zod validation passes args through

No integration tests that hit real GitHub API — all tests are unit tests with mocked HTTP/client layers.

---

## Out of Scope

- **New resources or prompts** — no new `github://*` resources or cross-module prompts in this pass. Could add `github://pr/{repo}/{number}` in a follow-up.
- **GraphQL API** — all new methods use REST (existing pattern). GraphQL would be faster for composite queries (PR + reviews + checks in one call) but adds dependency complexity. Revisit if latency becomes an issue.
- **Configuration changes** — no new env vars. `GH_REPOS` (existing) is used for `searchPullRequestsByQuery` when no explicit `repo` is provided.
- **Auto-approve/dismiss reviews** — the new tools are read-only for reviews (`getPullRequestReviews`); write operations (request changes, approve, dismiss) are out of scope and could be a future addition.
- **PR update (title/body/base)** — not requested; could be a future `github_update_pr` tool.
