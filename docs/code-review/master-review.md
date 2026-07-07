# Consolidated Code Review — `github_update_pr` Feature

**Branch:** `master` (uncommitted working-tree changes)
**Feature:** `updatePullRequest()` method + `github_update_pr` MCP tool
**Date:** 2026-07-07
**Ticket:** N/A

---

## Overview

Adds `updatePullRequest()` to `GitHubClient` (PATCH /repos/{owner}/{repo}/pulls/{number}) and wires it as the `github_update_pr` MCP tool. All 263 tests pass, typecheck passes.

## Specialist Reviews

| Specialist | File | Status |
|-----------|------|--------|
| Backend | `docs/code-review/master-review-backend.md` | ✅ Ready — 0 blocking, 3 informational |
| Integration | `docs/code-review/master-review-integration.md` | ⚠️ 2 high + 1 medium + 3 low |
| Security | `docs/code-review/master-review-security.md` | ✅ 0 blocking, 2 low, 1 info |

## Issues — Action Required

### HIGH (merge-blocking)

| # | File | Lines | Source | Description |
|---|------|-------|--------|-------------|
| H1 | `module.test.ts` | 611–702 | Integration | **Missing Zod `.refine` validation test.** The schema `.refine()` rejects requests with no update fields — this should be independently tested at the module handler layer. Precedent: `githubGetPrDetailsSchema.parse` test at line 407. Add: `expect(() => githubUpdatePrSchema.parse({ repo: 'Org/Repo', prNumber: 42 })).toThrow('At least one of title, body, state, base, or maintainerCanModify');` |
| H2 | `module.test.ts` | 611–702 | Integration | **Missing Zod repo-format validation test.** Invalid repo formats should be rejected by Zod before reaching the client. Precedent: line 407–409 (`githubGetPrDetailsSchema.parse({ repo: 'invalid', prNumber: 42 })` → `toThrow()`). Add an equivalent test for `githubUpdatePrSchema`. |

### MEDIUM

| # | File | Lines | Source | Description |
|---|------|-------|--------|-------------|
| M1 | `module.test.ts` | 611–702 | Integration | **Missing `maintainerCanModify` / `body` / `base` passthrough coverage.** Only `title` and `state` are tested at the handler layer. Add at least one multi-field test verifying `maintainerCanModify: true` (and optionally `body`/`base`) flows through correctly. |

### LOW

| # | File | Lines | Source | Description |
|---|------|-------|--------|-------------|
| L1 | `module.ts` | 149 | Security | **`body` field has no `.min(1)`.** The Zod `body` field uses truthiness in `.refine()`, so `{ body: "", title: "x" }` passes refinement but sends an empty string to the API. Either add `.min(1)` to the Zod field or change `.refine()` to use `!== undefined` checks. |
| L2 | `module.ts` | 151 | Security | **`base` lacks branch-name character validation.** GitHub disallows spaces, `..`, `~`, `^`, etc. in branch names. Consider adding a regex like `/^[a-zA-Z0-9._/\-]+$/` for early rejection. Not a security risk (GitHub validates server-side). |
| L3 | `module.test.ts` | 650–656 | Integration | **Handler tests assert `undefined` values for unset fields.** Fragile — if the handler changes to use spread/conditional building, these break. Consider `expect.objectContaining`. |
| L4 | `index.test.ts` | 9–13 | Integration | **`makeMockGitHub()` lacks `updatePullRequest`.** Not currently needed but creates a trap for future test authors. Add `updatePullRequest: vi.fn()`. |
| L5 | `index.test.ts` | 97–113 | Integration | **New descriptor not in explicit name check.** The test loops over all 11 descriptors structurally but only checks 3 by name. Add `expect(names).toContain('github_update_pr')`. |

### INFO

| # | File | Source | Description |
|---|------|--------|-------------|
| I1 | `github-client.ts` | Backend | No JSDoc on `updatePullRequest`. Consistent with most methods in the class. |
| I2 | `module.ts` | Backend | Handler passes `undefined` for unset optional fields (filtered correctly by client). Style observation only. |
| I3 | `module.ts` | Backend | Tool descriptor description slightly vague on `maintainerCanModify`. |
| I4 | `github-client.ts` / `mcp-server.ts` | Security | Error messages from the GitHub API pass through to MCP callers — pre-existing pattern, consistent across all tools. |

---

## Verdict

| Severity | Count | Merge-blocking? |
|----------|-------|-----------------|
| High | 2 | **Yes** — fix H1 & H2 before merge |
| Medium | 1 | No — address if time permits |
| Low | 5 | No — cosmetic / future-proofing |
| Info | 4 | No — informational only |

**Action:** Fix H1 and H2 (the two missing Zod schema validation tests in `module.test.ts`). Optionally address M1 and L1–L5 at the same time.
