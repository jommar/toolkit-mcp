# PR Review Capabilities — Inline Comments, Formal Reviews, and Suggested Changes

- **Goal:** Add full PR review workflow support to toolkit-mcp: inline/diff review comments, formal PR review submission, and GitHub suggested changes.
- **Motivation:** The existing tools (`github_get_pr_reviews` read-only, `github_add_pr_comment` issue-level only) stop short of the complete review loop. An AI agent needs to leave line-specific feedback, submit approvals/change requests, and suggest code edits — all without switching to a browser.

---

## Architecture Decisions

### 1. Three new service-layer classes of capabilities on `GitHubClient`

**Decision:** Add five new public methods to `GitHubClient` in `src/services/github/github-client.ts`:

| Capability | Methods | GitHub REST API |
|---|---|---|
| Inline review comments | `createPrReviewComment`, `getPrReviewComments`, `updatePrReviewComment`, `deletePrReviewComment` | `POST /pulls/{number}/comments`, `GET /pulls/{number}/comments`, `PATCH /pulls/comments/{id}`, `DELETE /pulls/comments/{id}` |
| Formal review submission | `submitPrReview` | `POST /pulls/{number}/reviews` |
| Suggested changes | Handled inside `createPrReviewComment` when `suggestedReplacement` is provided | Same endpoint as inline comments — just different body format |

**Rationale:** Keeping all three capabilities in the same service class follows the existing pattern (GitHubClient is the single source of truth for GitHub REST API interactions). The suggested change feature is a special case of an inline comment, not a separate API call — it only adds formatting logic.

### 2. New types live alongside existing ones

**Decision:** Add new TypeScript interfaces (`PrReviewComment`, `PrReviewSubmitted`, `ReviewCommentPosition`, `PrReviewEvent`, `SubmitPrReviewInput`, `CreateReviewCommentInput`) directly in `github-client.ts` and re-export them from `src/services/index.ts`.

**Rationale:** All existing types (`PrInfo`, `PrComment`, `PullRequestReview`, etc.) already live in `github-client.ts`. Co-locating new types with their methods keeps the module self-contained.

### 3. Suggested changes are a parameter flag, not a separate tool

**Decision:** The `github_create_pr_review_comment` tool accepts an optional `suggestedReplacement` string. When provided, the handler wraps the `body` in a ````suggestion` markdown block before sending to the API. No separate `github_suggest_change` tool is created.

**Rationale:** The GitHub API has no first-class "suggestion" field — it's purely a body-formatting convention. Exposing it as an optional parameter on the existing comment-creation tool is the minimal surface area that correctly models the underlying API behavior. A separate tool would imply a separate API call, which doesn't exist.

### 4. One new MCP tool per method (5 tools total)

**Decision:** Register five new MCP tools — one per new `GitHubClient` method. No new integration module; extend the existing `src/integrations/github/` module.

| Tool Name | Wraps GitHubClient method |
|---|---|
| `github_create_pr_review_comment` | `createPrReviewComment` |
| `github_get_pr_review_comments` | `getPrReviewComments` |
| `github_update_pr_review_comment` | `updatePrReviewComment` |
| `github_delete_pr_review_comment` | `deletePrReviewComment` |
| `github_submit_pr_review` | `submitPrReview` |

### 5. Formal review submission accepts optional inline comments

**Decision:** The `github_submit_pr_review` tool accepts an optional `comments` array parameter. Each entry in this array is a `CreateReviewCommentInput` (same shape as `github_create_pr_review_comment`'s parameters minus `repo` and `prNumber`, which come from the parent tool). The handler passes them directly to the API — GitHub creates both the review and the inline comments atomically.

**Rationale:** This matches the GitHub API's `POST /pulls/{number}/reviews` body shape, which accepts a `comments` array. Nesting inline comments inside the review submission is the correct way to submit a review with line-specific feedback in a single API call. It also avoids the need for the agent to first create inline comments individually and then submit a review referencing them.

---

## New Service-Layer Methods (GitHubClient)

All methods go in `src/services/github/github-client.ts`. All validate `repo` format with `REPO_PATTERN`.

### Types

```typescript
export interface PrReviewComment {
  id: number;
  /** The file path in the repo (e.g., "src/main.ts") */
  path: string;
  /** The line number the comment is on (for multi-line: the end line) */
  line: number;
  /** For multi-line comments: the start line */
  startLine: number | null;
  /** The comment body text */
  body: string;
  /** The commit SHA the comment was made on */
  commitId: string;
  /** "LEFT" for the base, "RIGHT" for the head (default: "RIGHT") */
  side: 'LEFT' | 'RIGHT';
  /** For multi-line: "LEFT" or "RIGHT" for the start side */
  startSide: 'LEFT' | 'RIGHT' | null;
  author: string;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  /** For replies: the parent comment ID */
  inReplyToId: number | null;
  /** The original line in the diff (before changes) */
  originalLine: number | null;
  /** The original start line */
  originalStartLine: number | null;
}

export interface CreateReviewCommentInput {
  /** The file path relative to the repo root */
  path: string;
  /** The body of the comment. If suggestedReplacement is provided externally (MCP handler combines) */
  body: string;
  /** The SHA of the commit being commented on */
  commitId: string;
  /** Line number in the file or in the diff (depends on subjectType / side). Required for a single-line comment or the end line of a multi-line comment. */
  line: number;
  /** For multi-line comments: the start line (required for multi-line) */
  startLine?: number;
  /** "LEFT" for base, "RIGHT" for head (default: "RIGHT") */
  side?: 'LEFT' | 'RIGHT';
  /** For multi-line: "LEFT" or "RIGHT" for start side (default: "RIGHT" if side is "RIGHT") */
  startSide?: 'LEFT' | 'RIGHT';
  /** For pending reviews (not submitted yet) — used when embedded in submitPrReview */
  inReplyTo?: number;
}

export interface PrReviewSubmitted {
  id: number;
  state: string;
  body: string | null;
  commitId: string;
  htmlUrl: string;
}

export type PrReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface SubmitPrReviewInput {
  /** The review summary body */
  body?: string;
  /** The review event type */
  event: PrReviewEvent;
  /** Optional inline comments to submit as part of this review */
  comments?: CreateReviewCommentInput[];
  /** Optional SHA to base the review on */
  commitId?: string;
}
```

### Method Signatures

#### 1. `createPrReviewComment`

```typescript
async createPrReviewComment(
  repo: string,
  prNumber: number,
  input: CreateReviewCommentInput,
): Promise<PrReviewComment>
```

**API:** `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments`

**Body:**
```json
{
  "body": "string",
  "commit_id": "string",
  "path": "string",
  "line": 42,
  "start_line": 38,
  "side": "RIGHT",
  "start_side": "RIGHT"
}
```

**Notes:**
- `start_line` / `start_side` only present if `input.startLine` is provided
- `start_line` must be less than `line` for multi-line comments
- If `input.startLine` is omitted, it's a single-line comment
- `side` defaults to `'RIGHT'` if omitted
- Map response snake_case to camelCase for the returned `PrReviewComment`

#### 2. `getPrReviewComments`

```typescript
async getPrReviewComments(
  repo: string,
  prNumber: number,
  opts?: { perPage?: number; page?: number },
): Promise<PrReviewComment[]>
```

**API:** `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments?per_page={n}&page={n}`

**Notes:**
- This is the **diff/review comments** endpoint — distinct from `GET /repos/{repo}/issues/{number}/comments` (issue-level)
- Returns only top-level comments by default; replies are nested with `in_reply_to_id` in the JSON response
- Default `per_page`: 100, default `page`: 1

#### 3. `updatePrReviewComment`

```typescript
async updatePrReviewComment(
  repo: string,
  commentId: number,
  body: string,
): Promise<PrReviewComment>
```

**API:** `PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}`

**Notes:**
- The endpoint is `pulls/comments/{id}` (not `pulls/{number}/comments/{id}`) — GitHub's review comments use a global comment ID
- Only `body` can be updated

#### 4. `deletePrReviewComment`

```typescript
async deletePrReviewComment(
  repo: string,
  commentId: number,
): Promise<void>
```

**API:** `DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}`

**Notes:**
- Returns 204 No Content on success
- Returns 403 if the comment has replies (cannot delete a comment that has replies)
- Method returns `void` — handler returns a success message

#### 5. `submitPrReview`

```typescript
async submitPrReview(
  repo: string,
  prNumber: number,
  input: SubmitPrReviewInput,
): Promise<PrReviewSubmitted>
```

**API:** `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`

**Body:**
```json
{
  "body": "Summary of the review",
  "event": "APPROVE",
  "comments": [
    {
      "path": "src/file.ts",
      "body": "Inline comment",
      "line": 42,
      "commit_id": "abc123"
    }
  ]
}
```

**Notes:**
- `event` is required — must be one of `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`
- `body` is optional but strongly recommended (it becomes the review summary)
- `comments` array entries follow the same shape as `CreateReviewCommentInput` minus `repo`/`prNumber`
- If `commitId` is provided, the review is pinned to that SHA; otherwise it uses the latest
- Returns the created review object with `id`, `state`, `body`, `commitId`, `htmlUrl`

### Suggested Change Format (Handler-Level Logic)

This formatting lives in the MCP handler, not in `GitHubClient`. When the `suggestedReplacement` parameter is provided:

1. Append or construct the `body` as follows:
   ````
   {body}

   ```suggestion
   {suggestedReplacement}
   ```
   ````
2. If `body` is empty and only `suggestedReplacement` is provided, the body IS the suggestion block.
3. The ````suggestion` language tag is critical — GitHub's frontend only renders "Apply suggestion" buttons for fenced code blocks tagged `suggestion`.

Example output body for a comment with both explanatory text and a suggestion:

````markdown
The `count` variable should use `let` because it's reassigned below.

```suggestion
let count = 0;
```
````

The handler combines `body` and `suggestedReplacement` before calling `createPrReviewComment`.

---

## New Zod Schemas

All schemas go in `src/integrations/github/module.ts`.

### `githubCreatePrReviewCommentSchema`

```typescript
export const githubCreatePrReviewCommentSchema = z.object({
  repo: z.string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z.number().int().positive().describe('Pull request number.'),
  path: z.string().min(1).max(1024).describe('File path relative to repo root (e.g., "src/file.ts").'),
  body: z.string().min(1).max(65536).describe('Comment body (Markdown supported).'),
  commitId: z.string().min(1).max(64).describe('SHA of the commit being commented on.'),
  line: z.number().int().positive().describe('Line number in the diff (or end line for multi-line comments).'),
  startLine: z.number().int().positive().optional().describe('Start line for multi-line comments (must be less than `line`).'),
  side: z.enum(['LEFT', 'RIGHT']).optional().default('RIGHT').describe('Which side of the diff: "LEFT" (base) or "RIGHT" (head).'),
  startSide: z.enum(['LEFT', 'RIGHT']).optional().describe('Start side for multi-line comments (defaults to the value of `side`).'),
  suggestedReplacement: z.string().max(65536).optional().describe(
    'If provided, wraps the comment as a GitHub suggested change. ' +
    'The replacement code is formatted inside a ```suggestion code fence, ' +
    'and GitHub renders it with an "Apply suggestion" button.'
  ),
}).refine(
  (data) => {
    // If startLine is provided, it must be less than line
    if (data.startLine !== undefined && data.startLine >= data.line) {
      return false;
    }
    return true;
  },
  { message: 'startLine must be less than line for multi-line comments' },
).refine(
  (data) => {
    // startSide requires startLine
    if (data.startSide !== undefined && data.startLine === undefined) {
      return false;
    }
    return true;
  },
  { message: 'startSide requires startLine to be provided' },
);
```

### `githubGetPrReviewCommentsSchema`

```typescript
export const githubGetPrReviewCommentsSchema = z.object({
  repo: z.string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z.number().int().positive().describe('Pull request number.'),
  limit: z.number().min(1).max(100).optional().default(20).describe('Maximum items per page (default 20).'),
  cursor: z.string().max(50).optional().describe('Opaque pagination token from a previous response.'),
});
```

### `githubUpdatePrReviewCommentSchema`

```typescript
export const githubUpdatePrReviewCommentSchema = z.object({
  repo: z.string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  commentId: z.number().int().positive().describe('Review comment ID to update.'),
  body: z.string().min(1).max(65536).describe('Updated comment body (Markdown supported).'),
});
```

### `githubDeletePrReviewCommentSchema`

```typescript
export const githubDeletePrReviewCommentSchema = z.object({
  repo: z.string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  commentId: z.number().int().positive().describe('Review comment ID to delete.'),
});
```

### `githubSubmitPrReviewSchema`

```typescript
// Reuse the inline comment input shape without repo/prNumber
const reviewCommentInputSchema = z.object({
  path: z.string().min(1).max(1024).describe('File path relative to repo root.'),
  body: z.string().min(1).max(65536).describe('Inline comment body.'),
  line: z.number().int().positive().describe('Line number (or end line for multi-line).'),
  startLine: z.number().int().positive().optional().describe('Start line for multi-line.'),
  side: z.enum(['LEFT', 'RIGHT']).optional().describe('Diff side ("LEFT" for base, "RIGHT" for head).'),
  startSide: z.enum(['LEFT', 'RIGHT']).optional().describe('Start side for multi-line.'),
});

export const githubSubmitPrReviewSchema = z.object({
  repo: z.string()
    .max(100)
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, 'Must be in "owner/name" format')
    .describe('Repository "owner/name" (e.g., "TransActComm/Portage-backend").'),
  prNumber: z.number().int().positive().describe('Pull request number.'),
  event: z
    .enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT'])
    .describe('Review action: APPROVE, REQUEST_CHANGES, or COMMENT.'),
  body: z.string().max(65536).optional().describe('Review summary body (Markdown supported).'),
  commitId: z.string().max(64).optional().describe('Optional SHA to pin the review to a specific commit.'),
  comments: z
    .array(reviewCommentInputSchema)
    .max(50)
    .optional()
    .describe('Optional inline comments to include in this review. Max 50 comments.'),
});
```

---

## New MCP Tools

### 1. `github_create_pr_review_comment` — Create inline review comment

**Handler logic:**
1. Parse and validate input via `githubCreatePrReviewCommentSchema`
2. If `suggestedReplacement` is provided:
   - If `body` is empty, set `body = '```suggestion\n' + suggestedReplacement + '\n```'`
   - Otherwise, set `body = body + '\n\n```suggestion\n' + suggestedReplacement + '\n```'`
3. Call `github.createPrReviewComment(repo, prNumber, { body, path, commitId, line, startLine, side, startSide })`
4. Return the created `PrReviewComment` as JSON

**Response:** The `PrReviewComment` object directly (not paginated).

**Edge cases:**
- `startLine >= line` — caught by Zod `.refine()`, returns validation error
- `startSide` without `startLine` — caught by Zod `.refine()` 
- Comment on a non-existent file — GitHub returns 422; the error propagates naturally via axios
- `suggestedReplacement` with empty `body` — just the suggestion block, no preamble
- `suggestedReplacement` without `body` — still valid; the context of the line/diff provides context

### 2. `github_get_pr_review_comments` — List inline review comments

**Handler logic:**
1. Parse input via `githubGetPrReviewCommentsSchema`
2. Map `cursor` → page: `page = cursor ? parseInt(cursor, 10) : 1`
3. Call `github.getPrReviewComments(repo, prNumber, { perPage: limit, page })`
4. `hasMore = comments.length >= limit`
5. Return `paginated(comments, hasMore ? String(page + 1) : undefined)`

**Response:** `PaginatedResponse<PrReviewComment>` — standard envelope.

**Naming note:** This is distinct from `github_get_pr_comments` (issue-level comments). The names make the distinction: "review comments" are line/diff-specific; "comments" alone are conversation-level.

### 3. `github_update_pr_review_comment` — Update inline review comment

**Handler logic:**
1. Parse input via `githubUpdatePrReviewCommentSchema`
2. Call `github.updatePrReviewComment(repo, commentId, body)`
3. Return the updated `PrReviewComment` as JSON

**Response:** The updated `PrReviewComment` object directly.

**Edge cases:**
- Cannot update a deleted comment — GitHub returns 404
- Cannot update a resolved comment that has replies — GitHub returns 422

### 4. `github_delete_pr_review_comment` — Delete inline review comment

**Handler logic:**
1. Parse input via `githubDeletePrReviewCommentSchema`
2. Call `github.deletePrReviewComment(repo, commentId)`
3. Return `{ success: true, message: 'Review comment deleted' }`

**Response:** `{ success: true, message: string }` — custom success envelope since the API returns 204 with no body.

**Edge cases:**
- Comment has replies — GitHub returns 403; the handler should let the error propagate with a descriptive message (GitHub's error message is descriptive enough)
- Comment already deleted — GitHub returns 404

### 5. `github_submit_pr_review` — Submit formal PR review

**Handler logic:**
1. Parse input via `githubSubmitPrReviewSchema`
2. Build the `SubmitPrReviewInput` object: `{ body, event, comments, commitId }`
3. Call `github.submitPrReview(repo, prNumber, input)`
4. Return the `PrReviewSubmitted` object as JSON

**Response:** The `PrReviewSubmitted` object directly (not paginated).

**Edge cases:**
- No `commitId` provided — uses latest commit on the PR (GitHub's default)
- `event: 'APPROVE'` with no `body` — still valid; the approval action is the event
- `comments` array with 0 items — valid; just submits the review without inline comments
- Already submitted a review with the same event — GitHub returns 422 ("review already exists" for that commit). The handler lets this propagate.
- `comments` array exceeding sensible limits — Zod caps at 50 via `.max(50)`

---

## Changes to Existing Files

### `src/services/github/github-client.ts`

**Additions:**
- New type interfaces: `PrReviewComment`, `CreateReviewCommentInput`, `PrReviewSubmitted`, `SubmitPrReviewInput`
- New public methods:
  - `createPrReviewComment(repo, prNumber, input): Promise<PrReviewComment>`
  - `getPrReviewComments(repo, prNumber, opts?): Promise<PrReviewComment[]>`
  - `updatePrReviewComment(repo, commentId, body): Promise<PrReviewComment>`
  - `deletePrReviewComment(repo, commentId): Promise<void>`
  - `submitPrReview(repo, prNumber, input): Promise<PrReviewSubmitted>`

**No changes to** existing methods, types, or internal implementation.

### `src/services/index.ts`

**Additions:**
- Add `PrReviewComment`, `CreateReviewCommentInput`, `PrReviewSubmitted`, `SubmitPrReviewInput` to the type re-export line for GitHub types:
  ```typescript
  export type { /* existing types ..., */ PrReviewComment, CreateReviewCommentInput, PrReviewSubmitted, SubmitPrReviewInput } from './github/github-client.js';
  ```

### `src/integrations/github/module.ts`

**Additions:**
- 5 new Zod schemas (listed above)
- 5 new handler factory functions
- 5 new descriptors appended to `githubToolDescriptors` array

**Imports to add:**
- The new types: `PrReviewComment`, `PrReviewSubmitted` (for response typing in handlers)
- No new external imports

**Do NOT change:**
- Existing schemas, handlers, or descriptors (append only)

### `src/integrations/github/index.ts`

**Additions in `createToolHandlers`:**
- 5 new entries in the handler map, each wrapping the handler factory with Zod parse:

```typescript
github_create_pr_review_comment: async (args) => {
  const parsed = githubCreatePrReviewCommentSchema.parse(args);
  return await githubCreatePrReviewCommentHandler(clients)(parsed);
},
github_get_pr_review_comments: async (args) => {
  const parsed = githubGetPrReviewCommentsSchema.parse(args);
  return await githubGetPrReviewCommentsHandler(clients)(parsed);
},
github_update_pr_review_comment: async (args) => {
  const parsed = githubUpdatePrReviewCommentSchema.parse(args);
  return await githubUpdatePrReviewCommentHandler(clients)(parsed);
},
github_delete_pr_review_comment: async (args) => {
  const parsed = githubDeletePrReviewCommentSchema.parse(args);
  return await githubDeletePrReviewCommentHandler(clients)(parsed);
},
github_submit_pr_review: async (args) => {
  const parsed = githubSubmitPrReviewSchema.parse(args);
  return await githubSubmitPrReviewHandler(clients)(parsed);
},
```

**Imports to add:**
```typescript
import {
  // ...existing imports...
  githubCreatePrReviewCommentHandler,
  githubCreatePrReviewCommentSchema,
  githubGetPrReviewCommentsHandler,
  githubGetPrReviewCommentsSchema,
  githubUpdatePrReviewCommentHandler,
  githubUpdatePrReviewCommentSchema,
  githubDeletePrReviewCommentHandler,
  githubDeletePrReviewCommentSchema,
  githubSubmitPrReviewHandler,
  githubSubmitPrReviewSchema,
} from './module.js';
```

### `src/integrations/github/index.test.ts`

- Update handler count expectation from 12 to 17 (in `createToolHandlers` test)
- Add smoke tests for each new handler (verify it exists in the handlers map)

### No changes to:
- `src/integrations/index.ts` — module registry unchanged (GitHub module already imported)
- `src/mcp-server.ts` — no bootstrap changes needed
- `package.json` — no new dependencies
- `.env.example` — no new env vars
- `src/integrations/helpers.ts` — unchanged

---

## Suggested Change Format — Detailed Specification

GitHub renders a "suggested change" when the comment body contains a fenced code block with the language tag `suggestion`:

````markdown
Some explanation (optional).

```suggestion
replacement code here
```
````

The handler constructs this as follows:

```
function buildSuggestionBody(body: string | undefined, suggestedReplacement: string): string {
  const suggestionBlock = '```suggestion\n' + suggestedReplacement + '\n```';
  if (!body) return suggestionBlock;
  return body + '\n\n' + suggestionBlock;
}
```

**Important details:**
- The language tag is literally `suggestion` (not `diff`, not `typescript`, not an empty string)
- Only the first `suggestion` block in a comment body renders the "Apply suggestion" button
- Multiple suggestion blocks in one comment are ignored by GitHub's UI (only the first gets a button)
- The `path` and `line` fields from the parent comment determine where the suggestion applies
- The AI agent must provide the **full replacement** for the targeted line(s), not a diff fragment
- If the `suggestedReplacement` spans multiple lines, the backtick fence must use more backticks than any line in the replacement contains (e.g., ````suggestion` with fences of 4+ backticks if the replacement contains triple backticks)

---

## Edge Cases and Error Handling

| Scenario | Layer | Behaviour |
|---|---|---|
| `startLine >= line` | Zod | `.refine()` in schema rejects with validation error |
| `startSide` without `startLine` | Zod | `.refine()` rejects with validation error |
| `suggestedReplacement` with empty `body` | Handler | Body becomes just the suggestion block |
| Inline comment on non-existent file | GitHub API (422) | Axios error propagates; handler returns `McpError` with 422 detail |
| `deletePrReviewComment` on comment with replies | GitHub API (403) | Error propagates; GitHub message explains "Can't delete... it has replies" |
| `submitPrReview` with already-submitted review | GitHub API (422) | Error propagates; agent should not retry blindly |
| `submitPrReview` with empty `body` and no `comments` | Valid | Submits a review with just the event action and no summary |
| `line` below 1 or non-positive | Zod | `.positive()` rejects |
| `repo` in invalid format | Zod | Regex reject |
| `comments` array exceeds 50 items | Zod | `.max(50)` rejects |
| Network/timeout during API call | GitHubClient | Retry interceptor handles 429/5xx with backoff; throws after MAX_RETRIES |
| `updatePrReviewComment` on non-existent comment ID | GitHub API (404) | Error propagates normally |
| Comment body > 65536 chars | Zod | `.max(65536)` rejects |

---

## Test Plan

### `src/services/github/github-client.test.ts`

Add test `describe` blocks for each new method, following the existing `http.get`/`http.post`/`http.patch`/`http.delete` mock pattern:

**`createPrReviewComment`:**
- Happy path: posts correct body to `/repos/{repo}/pulls/{number}/comments`, returns mapped `PrReviewComment`
- With `startLine`: verifies `start_line` and `start_side` in the request body
- Without `startLine`: verifies single-line comment (no `start_line` in body)
- With `side: 'LEFT'`: verifies `side: 'LEFT'` in request
- Invalid repo format: throws
- API error (422): propagates

**`getPrReviewComments`:**
- Happy path: returns paginated `PrReviewComment[]` with correct field mapping
- With `perPage`/`page` params: verifies query string
- Empty result: returns `[]`
- Invalid repo format: throws
- Null user handling: maps to 'unknown'
- Null fields: maps `start_line` → `startLine` null, `original_line` → `originalLine` null, etc.

**`updatePrReviewComment`:**
- Happy path: patches `/repos/{repo}/pulls/comments/{id}`, returns mapped `PrReviewComment`
- Invalid repo format: throws
- 404 on non-existent comment: propagates

**`deletePrReviewComment`:**
- Happy path: deletes `/repos/{repo}/pulls/comments/{id}`, returns void
- Invalid repo format: throws
- 403 on comment with replies: propagates

**`submitPrReview`:**
- Happy path with `event: 'APPROVE'` and `body`: posts to `/repos/{repo}/pulls/{number}/reviews`, returns `PrReviewSubmitted`
- With `comments` array: verifies comments are included in request body
- With `commitId`: verifies commit_id in request body
- Without `body` and without `comments`: verifies minimal valid request
- Invalid repo format: throws

### `src/integrations/github/module.test.ts`

Add test `describe` blocks for each new handler, using the existing `makeMockGitHub()` factory:

**`githubCreatePrReviewCommentHandler`:**
- Happy path with `body`, `path`, `commitId`, `line`: calls `createPrReviewComment`, returns comment
- With `suggestedReplacement`: verifies the body includes the `suggestion` code block
- With `suggestedReplacement` and empty `body`: verifies only the suggestion block
- With `startLine`: verifies it's passed to the client
- Zod validation: rejects when `startLine >= line`
- Zod validation: rejects when `startSide` without `startLine`

**`githubGetPrReviewCommentsHandler`:**
- Happy path with pagination: returns `PaginatedResponse<PrReviewComment>`
- Uses `cursor` as page number
- Sets `hasMore` when result count equals limit
- No cursor defaults to page 1

**`githubUpdatePrReviewCommentHandler`:**
- Happy path: calls `updatePrReviewComment`, returns updated comment
- Schema validates `body` is present

**`githubDeletePrReviewCommentHandler`:**
- Happy path: calls `deletePrReviewComment`, returns `{ success: true }`
- Schema validates `commentId` is positive int

**`githubSubmitPrReviewHandler`:**
- Happy path with `APPROVE`: calls `submitPrReview`, returns submitted review
- With `comments`: verifies comments are passed through
- Zod validation: rejects invalid event enum values
- Zod validation: rejects empty `repo`

### `src/integrations/github/index.test.ts`

- Update handler count expectation: 12 → 17
- Add smoke tests verifying each new handler exists in `createToolHandlers` return map

---

## Open Questions / Future Work

1. **Reply resolution tracking** — The `PrReviewComment` type includes `inReplyToId`, but the current tools don't expose a dedicated "reply to comment" capability. The `createPrReviewComment` method could add an optional `inReplyTo` parameter in a follow-up.

2. **Review dismissal** — `DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}` (dismissing a review) is not covered. Could be added as `github_dismiss_pr_review` in a future pass.

3. **Review requests** — `POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers` (requesting a review from specific users). Not in scope here.

4. **Pull request file listing** — `GET /repos/{owner}/{repo}/pulls/{pull_number}/files` is not currently exposed as a tool. An AI agent writing inline comments likely needs to know which files changed. This could be added to `github_get_pr_details` or as a standalone `github_get_pr_files` tool.

5. **Diff retrieval** — The actual PR diff text (for context when choosing line numbers) is not available through the current tools. A `github_get_pr_diff` tool or resource (`github://diff/{owner}/{repo}/{number}`) is a natural companion.

6. **Multi-line suggestion ambiguity** — When the `suggestedReplacement` contains triple backticks, the handler needs to use more fence characters (e.g., ````suggestion`). This is an edge case documented above but not automatically handled in the initial implementation.
