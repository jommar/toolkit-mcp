# Code Review: Figma MCP Integration

**Branch:** master (uncommitted working tree changes)
**Files changed:** 8 modified + 6 new, across 14 files
**Status:** Uncommitted — review of unstaged/untracked work

---

## Overview

This feature adds a full Figma MCP integration to `toolkit-mcp`:

- **`FigmaClient`** — service-layer API client with 8 methods for the Figma REST API
- **`FigmaModule`** — integration module with 8 MCP tools, Zod schemas, handler factories
- **Bootstrap wiring** — `mcp-server.ts` handles `figmaActive`, `mcp-health.ts` reports `figma` status
- **Module registry** — `FigmaModule` added to the `modules` array
- **Tests** — 25 new tests (15 handler + 10 module) all passing; all 207 existing tests still pass

---

## Things Done Well ✅

### 1. Auth header is `X-Figma-Token` (correct) ✅
Line 137 of `figma-client.ts` uses `'X-Figma-Token': this.token` — matching the Figma API spec. Not `Authorization: Bearer`.

### 2. FigmaClient is a pure API client with no MCP awareness ✅
No MCP SDK imports in the service layer. Uses plain `fetch()`. Clean separation: services know nothing about MCP; integrations wrap them.

### 3. Error propagation is correct ✅
- **Service layer:** `request<T>()` throws `Error` with status code + body text on non-2xx.
- **Integration layer:** `wrapError()` catches all client errors and re-throws as `McpError(ErrorCode.InternalError)`.
- **Central dispatch** in `mcp-server.ts` also catches `ZodError` → `ErrorCode.InvalidParams`.

### 4. FigmaModule correctly implements IntegrationModule ✅
- Generic parameter: `IntegrationModule<{ figma: FigmaClient }>` — matches the pattern.
- `needsEnv()` returns `!!process.env.FIGMA_TOKEN` — consistent with GitHub's pattern.
- No `getResourceHandler` or `getPromptHandler` overrides — correct per plan (no Figma URI scheme yet).

### 5. Module registry is properly updated ✅
`src/integrations/index.ts` now imports `FigmaModule` and adds it to the array:
```typescript
export const modules = [new JiraModule(), new GitHubModule(), new FigmaModule()];
```

### 6. Bootstrap wiring is thorough ✅
- `figmaActive` flag uses `!!process.env.FIGMA_TOKEN` (line 31)
- Log line shows active/inactive (line 35)
- Client construction wrapped in try/catch (lines 55–62)
- `createHealthHandler` gets 3rd argument `!!clients.figma` (line 77)
- Module loop skips figma if client construction failed (lines 89–93)

### 7. Health type includes `figma` field ✅
`HealthResult.integrations.figma: boolean` is present in type, function parameter, and result construction.

### 8. Tool descriptions are exactly one sentence ✅
All 8 descriptions match the "one sentence, concise, no filler" convention.

### 9. Services barrel export is complete ✅
`src/services/index.ts` exports `FigmaClient` class and all 8 response types.

### 10. `.env.example` and `README.md` updated ✅
`FIGMA_TOKEN` documented in `.env.example` and README's config table.

### 11. Test coverage is strong ✅
- **25 new Figma-specific tests** (15 in `module.test.ts`, 10 in `index.test.ts`).
- All 207 tests pass.
- Uses the DI pattern: mock `FigmaClient`, call handler factories with mock.
- Tests cover: happy path, schema validation errors, error wrapping, default params, `needsEnv` edge cases (set, missing, empty).

---

## Issues to Address 🔴

### Issue 1: `mcp-health.test.ts` has a coverage gap for the `figma` field

**Severity:** Low | **File:** `src/mcp-health.test.ts`

The health tests call `createHealthHandler` with **2 arguments** (the pre-Figma signature):
```typescript
const handler = createHealthHandler(true, true);    // line 8
const handler = createHealthHandler(false, false);  // line 19
const handler = createHealthHandler(true, false);   // line 28
```

The function now expects 3 parameters (`jiraActive, githubActive, figmaActive`). At runtime this works (JS ignores extra/missing args; 3rd param becomes `undefined` which is falsy), and the tests only assert on `jira`/`github` fields. But **the `figma` field is never tested in `mcp-health.test.ts`**.

**Potential impact:** If the `figma` flag in `createHealthHandler` were accidentally dropped or broken, no test would catch it. The tests in `mcp-health.test.ts` would still pass.

**Fix:** Add test cases that pass all 3 args and assert on `body.integrations.figma`:

```typescript
it('returns figma status when figma is active', async () => {
  const handler = createHealthHandler(false, false, true);
  const result = await handler({});
  const body = JSON.parse(result.content[0].text);
  expect(body.integrations.figma).toBe(true);
});

it('returns figma status when figma is inactive', async () => {
  const handler = createHealthHandler(false, false, false);
  const result = await handler({});
  const body = JSON.parse(result.content[0].text);
  expect(body.integrations.figma).toBe(false);
});
```

---

### Issue 2: Zod defaults for `format` and `scale` aren't applied at the raw handler level

**Severity:** Low | **File:** `src/integrations/figma/module.ts` (line 106)

The `figmaGetImagesHandler` passes `args.format` and `args.scale` directly to `getImages()` without applying Zod defaults:

```typescript
// module.ts line 106
const result = await clients.figma.getImages(args.fileKey, args.ids, args.format, args.scale);
```

When called with defaults omitted through the raw handler (not going through FigmaModule's schema parsing), these are `undefined`:

```typescript
// Test confirms: Zod defaults are applied at the module level, not at the raw handler
expect(mockFigma.getImages).toHaveBeenCalledWith('ABC123', '1:2', undefined, undefined);
```

The FigmaModule's `createToolHandlers` delegates correctly — it calls `figmaGetImagesSchema.parse(args)` which DOES apply defaults before calling the handler. But the handler itself doesn't handle this, making it fragile if called without module-level schema parsing.

**Fix (optional — non-blocking):** Apply defaults in the handler itself as a safety net:

```typescript
const result = await clients.figma.getImages(
  args.fileKey,
  args.ids,
  args.format ?? 'png',
  args.scale ?? 1
);
```

**Note:** The test at line 140 documents this behavior explicitly (`"Zod defaults are applied at the module level, not at the raw handler"`). This is an intentional design choice consistent with existing integration patterns. Not required to fix, but worth noting.

---

### Issue 3: No `mcp-server.test.ts` coverage for Figma activation scenario

**Severity:** Low | **File:** `src/mcp-server.test.ts`

The `mcp-server.test.ts` mocks all 3 clients (good), but the only test scenario clears ALL env vars. There is no test that sets `FIGMA_TOKEN` and verifies the Figma module is registered.

**Fix (optional):** Add a test case that hoists `FIGMA_TOKEN` to be set and verifies `figma_get_me` appears in the registered tools.

---

## Secondary Concerns 🟡

1. **TypeScript strict mode doesn't cover test files.** The tsconfig `exclude` list includes `src/**/*.test.ts`, and vitest doesn't typecheck by default (no `typecheck` config). The parameter count mismatch in `mcp-health.test.ts` (Issue 1) would be caught by `tsc --noEmit` but isn't. This is a pre-existing pattern, not new to this feature.

2. **The `wrapError` helper loses original error stack traces.** It creates a new `McpError` instead of wrapping the original error. This is consistent with how `mcp-server.ts` handles non-McpError errors in its central dispatch (lines 136-139), but it does mean the original error's stack is lost. Not a priority for a fetch-based API client.

3. **No `typedoc` or JSDoc on the exported tool schemas.** The Zod schemas are exported but have no module-level docs. These are consumed by the module's `createToolHandlers`, which could benefit from brief inline comments.

---

## Pre-existing Issues (not introduced by this PR)

- `mcp-server.test.ts` only tests the "all env vars clear" scenario. There's no test for Jira activation, GitHub activation, or any combination. This was true before the Figma changes.
- `mcp-health.test.ts` uses 2-arg calls since before this feature. They continue to work.

---

## Verdict

| Category        | Score    | Notes |
| --------------- | -------- | ----- |
| Correctness     | ✅ | Auth header, error handling, schema validation, bootstrap wiring all correct |
| Edge cases      | ✅ | Empty fileKey rejected, invalid enum rejected, scale out-of-range rejected, null/undefined args for health |
| Code quality    | ✅ | Clean separation of concerns, factory pattern, consistent with existing conventions |
| Completeness    | ✅ | All 8 endpoints, all types exported, all integration points wired |
| Test coverage   | 🟡 | 25 new Figma-specific tests pass; minor gap in `mcp-health.test.ts` (no `figma` field assertion) and `mcp-server.test.ts` (no Figma activation scenario) |
| Backward compat | ✅ | `.env.example` and `README.md` updated; existing tests pass unchanged; health handler is backward-compatible |

**Merge-blocking:** No

**Should do before merge:**
1. Address Issue 1 — add `figma` field assertions to `mcp-health.test.ts` (quick win, closes a coverage gap)
2. Consider Issue 2 — adding default fallbacks in the handler is optional but defensive
3. Consider Issue 3 — adding a Figma-activation test to `mcp-server.test.ts` would be nice-to-have
