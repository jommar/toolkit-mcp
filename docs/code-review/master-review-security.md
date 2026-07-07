# Security Audit Report — `github_update_pr` Feature

**Project:** toolkit-mcp  
**Branch:** `master` (uncommitted working-tree changes)  
**Feature:** `updatePullRequest()` + `github_update_pr` MCP tool  
**Date:** 2026-07-07

## Stack

Node.js, TypeScript, MCP SDK, Zod, Axios (GitHub REST API)

## Scope

Changes across 3 files (plus tests):

| File | Change |
|------|--------|
| `src/services/github/github-client.ts` | New `updatePullRequest()` method (~55 lines) |
| `src/integrations/github/module.ts` | New `githubUpdatePrSchema` (Zod) + `githubUpdatePrHandler` (~40 lines) |
| `src/integrations/github/index.ts` | Wiring the new tool into the handler map (~4 lines) |

---

## Summary

- **Total findings:** 3
- **Critical:** 0 | **High:** 0 | **Medium:** 0 | **Low:** 2 | **Info:** 1

The implementation follows established patterns from the codebase (`getPullRequest`, `githubCreatePr`, etc.) and applies consistent validation. Input sanitization is thorough — no injection vectors, no hardcoded secrets, and the Zod schema + client-side `REPO_PATTERN` provide defense-in-depth. No merge-blocking issues.

---

## Findings

### [INFO] A05: Error Messages Pass Through to MCP Responses (Pre-Existing Pattern)

**File:** `src/mcp-server.ts:150-153`, `src/services/github/github-client.ts:724-725`  
**CWE:** CWE-209 (Generation of Error Message Containing Sensitive Information)

**Description:** The central error handler passes raw error messages to MCP callers. When `updatePullRequest()` throws (e.g., 404 "Not Found", 403 "Resource not accessible by integration"), the message is returned verbatim. This reveals:

- Whether a repository exists (404 vs. 403)
- The token's permission scope (403 with a "write access required" message)
- Rate-limit details (secondary error codes)

This pattern is consistent with all other tools in the module — every `github_get_prs`, `github_create_pr`, etc., follows the same path. It is not new with this change.

**Why INFO and not higher:** The MCP server is a local dev tool using the developer's own GitHub token. The error messages already exist for read tools; there's no escalation from adding a write tool.

**Remediation (optional, for consistency):** Wrap handler errors in a generic message before returning:

```typescript
// In mcp-server.ts, catch block:
throw new McpError(
  ErrorCode.InternalError,
  'An error occurred while processing the request. Check server logs for details.',
);
```

...and log the real error to stderr at debug level.

---

### [LOW] A03: `body` Field Has No Min Length — Refinement Gap

**File:** `src/integrations/github/module.ts:149, 157`  
**CWE:** CWE-20 (Improper Input Validation)

**Description:** `body` is defined as `z.string().max(65536).optional()` — no `.min(1)`. The `.refine()` at line 157 uses truthiness (`data.body`), so an empty string as the sole field is rejected. But when combined with another field (e.g., `{ body: "", title: "x" }`), the empty body passes refinement and is sent to the GitHub API.

This is inconsistent: either enforce `.min(1)` on the Zod field, or use `data.body !== undefined` in the `.refine()`.

**Note:** The client-side check at `src/services/github/github-client.ts:731` uses `updates.body !== undefined`, so an empty body string DOES get sent. GitHub accepts it (clears the PR body), so this is low severity — but the Zod layer disagrees with the client layer.

**Remediation:** Add `.min(1)` to the body field:

```typescript
body: z.string().min(1).max(65536).optional().describe('New pull request body (Markdown supported).'),
```

Or change the `.refine()` to use strict-undefined checks to match the client behavior.

---

### [LOW] A03: `base` Branch Name Lacks Character Validation

**File:** `src/integrations/github/module.ts:151`  
**CWE:** CWE-20 (Improper Input Validation)

**Description:** `base` is `z.string().max(255)`. GitHub branch names disallow spaces, `..`, `~`, `^`, `:`, `\`, `?`, `*`, `[`, and cannot end with `.git` or `.lock`. The Zod schema would pass strings like `"feature/../main"` through to the GitHub API, where it gets rejected — but the error comes from GitHub rather than from early validation.

Not a security vulnerability (GitHub has its own server-side validation), but a defensive improvement opportunity.

**Remediation:** Add a branch-name regex to catch invalid inputs early:

```typescript
base: z
  .string()
  .max(255)
  .regex(/^[a-zA-Z0-9._/\-]+$/, 'Must be a valid branch name')
  .optional()
  .describe('New base branch for the PR.'),
```

---

## Verified Safe

| Concern | Status | Notes |
|---------|--------|-------|
| **Injection (A03)** | ✅ Safe | `repo` validated by Zod regex + `REPO_PATTERN`. All string fields bounded. `state` is `z.enum()`. No user input reaches `exec()`, `eval()`, or raw SQL. |
| **Hardcoded secrets** | ✅ Safe | No tokens, passwords, or API keys in the diff. `GH_TOKEN` read from `process.env` only. `.env` is gitignored. |
| **Authorization / Privilege escalation** | ✅ Safe | Uses the same `GH_TOKEN` bearer auth as all other tools. No way to escalate privileges beyond the token's scope. PATCH endpoint respects GitHub's permission model. |
| **REPO_PATTERN restrictive enough** | ✅ Safe | `^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$` — no path traversal (`..`), no command injection characters, no protocol prefixes, no URL encoding tricks. Consistent with 10+ other methods. |
| **`state` accepts only valid values** | ✅ Safe | `z.enum(['open', 'closed'])` at tool layer + TypeScript type `'open' | 'closed'` at client layer. |
| **`maintainerCanModify` safe** | ✅ Safe | `z.boolean()` — no injection vector possible. |
| **Oversized payloads** | ✅ Safe | `title` max 255, `body` max 65536, `base` max 255. All within GitHub API limits. |
| **npm audit** | ✅ Clean | 0 high/critical vulnerabilities. |
| **CSRF / SSRF** | N/A | This is an MCP server (stdio transport) — no web routes, no cookies, no server-side HTTP requests with user-controllable URLs outside the GitHub API. |
| **Rate limiting** | ✅ Safe | Axios retry interceptor (max 3 retries) handles GitHub's 429 responses with exponential backoff + `Retry-After` header. |
| **Multi-tenant leakage** | N/A | Not a multi-tenant system. |

---

## `npm audit` Result

```
found 0 vulnerabilities
```

No dependency vulnerabilities at any severity level.

---

## Prioritized Remediation Plan

1. **[Low] Fix body field validation** — Add `.min(1)` to `body` in `githubUpdatePrSchema` or change `.refine()` to use `!== undefined` checks. (File: `src/integrations/github/module.ts:149, 157`)
2. **[Low] Add branch-name pattern validation** — Add a regex to `base` field to catch invalid branch names early. (File: `src/integrations/github/module.ts:151`)
3. **[Info] Consider global error sanitization** — Wrap error messages in a generic string before returning to MCP callers. (File: `src/mcp-server.ts:150-153`)

---

## Verdict

✅ **APPROVED** — No merge-blocking security issues. The implementation follows established patterns, applies defense-in-depth validation at both the Zod and API-client layers, and includes thorough test coverage for edge cases (deleted users, merged states, API errors, ghost/null users). The pre-existing patterns for error handling apply equally to this tool as they do to existing write tools (`github_create_pr`, `github_add_pr_comment`, `github_update_pr_comment`).
