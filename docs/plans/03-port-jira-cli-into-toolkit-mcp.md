# Port jira-cli into toolkit-mcp as an Internal Service Layer

- **Ticket:** TBD
- **Goal:** Absorb the `jira-cli` library (`JiraClient`, `GitHubClient`, `config`, `slim`) into `toolkit-mcp/src/services/` as a first-class internal service layer, then sunset `jira-cli` as a standalone package.

---

## Current Architecture

```
jira-cli/                          toolkit-mcp/
  src/                               src/
    index.ts      ← exports ──────    mcp-server.ts       (imports JiraClient, GitHubClient)
    jira-client.ts                    mcp-config.ts       (imports loadConfig)
    github-client.ts                  integrations/
    config.ts                           jira/index.ts     (imports JiraClient)
    slim.ts                             jira/module.ts    (imports JiraClient, toSlimIssue)
    cli.ts                              github/index.ts   (imports GitHubClient)
    [test files]                        github/module.ts  (imports GitHubClient)
                                    package.json         (depends on "jira-cli": "file:../jira-cli")
```

- `toolkit-mcp` depends on `jira-cli` via `"jira-cli": "file:../jira-cli"` in its `package.json`
- Every `src/integrations/*` module imports client classes from `'jira-cli'`
- `src/mcp-server.ts` constructs `new JiraClient()` and `new GitHubClient()` from `'jira-cli'`
- `src/mcp-config.ts` calls `loadConfig()` from `'jira-cli'`
- 7 test files mock `'jira-cli'` via `vi.mock('jira-cli', ...)`
- `jira-cli/src/cli.ts` is a standalone CLI entry point (11 commands) — independent from toolkit-mcp

---

## Decisions

### Directory: `src/services/` for the ported library

**Decision:** Place ported files under `src/services/jira/` and `src/services/github/` (two directories, not one monolithic `services/jira-cli/`).

**Rationale:**
- `jira-client.ts` and its config/utilities are Jira-specific
- `github-client.ts` is GitHub-specific  
- Keeping them separated by domain mirrors the `integrations/jira/` and `integrations/github/` structure and avoids a single bloated directory
- A barrel `src/services/index.ts` re-exports everything for convenient imports

### Services vs. Integrations: Separate concerns, same architecture

**Decision:** Keep `src/integrations/` as the MCP adapter layer. Services are pure API clients with no MCP awareness. Integrations import services, wrap them with Zod schemas and MCP response formatting.

**Rationale:** Separation of concerns — services remain testable without MCP SDK dependencies, and integrations remain thin orchestration wrappers. This is the established pattern (integrations currently import from `'jira-cli'`; after the port, they import from `'../services/...'` with zero behavioral change).

### CLI: Leave behind in jira-cli, then deprecate

**Decision:** Do NOT port `cli.ts` into toolkit-mcp. The CLI is a standalone developer tool that operates independently. Once the library files are ported, add a deprecation notice to `jira-cli/README.md` directing users to `npm run mcp` for agentic usage, with `cli.ts` kept as a legacy convenience until explicitly removed.

**Rationale:** `cli.ts` adds no value to the MCP server (which has its own agentic dispatch). Porting it would add dead code and maintenance burden. The `jira-cli` repo becomes a thin CLI wrapper + deprecation notice that can be removed as a final cleanup step.

---

## Step-by-Step Migration Order

### Phase 1: Port files into toolkit-mcp, update imports, verify

**Goal:** All source files from `jira-cli/src/` (except `cli.ts`) exist under `toolkit-mcp/src/services/` and all existing toolkit-mcp imports compile against them.

Files to create under `toolkit-mcp/src/services/`:

| New file | Source | Notes |
|----------|--------|-------|
| `src/services/jira/jira-client.ts` | `jira-cli/src/jira-client.ts` | Remove `.js` extension from local imports (relative paths, not file deps) |
| `src/services/github/github-client.ts` | `jira-cli/src/github-client.ts` | Same — fix imports |
| `src/services/config.ts` | `jira-cli/src/config.ts` | Dotenv config loader — shared by both services |
| `src/services/slim.ts` | `jira-cli/src/slim.ts` | Imports `JiraIssue` from `./jira/jira-client.js` → `./jira/jira-client` |
| `src/services/index.ts` | `jira-cli/src/index.ts` | Barrel re-export — change all import paths to relative services paths |

Import path changes needed in ported files:

| File | Old import | New import |
|------|-----------|------------|
| `jira-client.ts` | `from './config.js'` | `from '../config.js'` |
| `jira-client.ts` | `from './slim.js'` | `from '../slim.js'` |
| `slim.ts` | `from './jira-client.js'` | `from './jira/jira-client.js'` |
| `github-client.ts` | (no internal dep imports) | (none) |

Update ALL toolkit-mcp imports from `'jira-cli'` to relative services paths:

| File | Old | New |
|------|-----|-----|
| `src/mcp-server.ts` | `import { JiraClient, GitHubClient } from 'jira-cli'` | `import { JiraClient, GitHubClient } from './services/index.js'` |
| `src/mcp-config.ts` | `import { loadConfig } from 'jira-cli'` | `import { loadConfig } from './services/config.js'` |
| `src/integrations/jira/module.ts` | `import { JiraClient, toSlimIssue } from 'jira-cli'` + type imports | `import { JiraClient, toSlimIssue } from '../../services/index.js'` |
| `src/integrations/jira/index.ts` | `import { JiraClient } from 'jira-cli'` | `import { JiraClient } from '../../services/index.js'` |
| `src/integrations/github/module.ts` | `import { GitHubClient } from 'jira-cli'` + type imports | `import { GitHubClient } from '../../services/index.js'` |
| `src/integrations/github/index.ts` | `import { GitHubClient } from 'jira-cli'` | `import { GitHubClient } from '../../services/index.js'` |

**Verify:** Run `npx tsc --noEmit` in toolkit-mcp — zero compilation errors.

---

### Phase 2: Port test files from jira-cli into toolkit-mcp

**Goal:** The test coverage that existed in `jira-cli` is preserved inside toolkit-mcp.

Files to create under `src/services/`:

| New file | Source | Notes |
|----------|--------|-------|
| `src/services/github/github-client.test.ts` | `jira-cli/src/github-client.test.ts` | Fix imports: `from './github-client.js'` → `from './github-client.js'` |
| `src/services/error-helpers.test.ts` | `jira-cli/src/error-helpers.test.ts` | Fix imports to use services paths |

**Changes needed in ported test files:**

1. `github-client.test.ts` — change `from './github-client.js'` to `from './github-client.js'` (same file, just moves). Update the `vi.mock('axios', ...)` path — it's already relative, so it should work as-is.
2. `error-helpers.test.ts` — change `from './github-client.js'` → `from './github/github-client.js'` and `from './jira-client.js'` → `from './jira/jira-client.js'`

**Verify:** Run `npm run test` in toolkit-mcp — all ported tests pass.

---

### Phase 3: Update test mocks from `'jira-cli'` to service paths

**Goal:** Every `vi.mock('jira-cli', ...)` in toolkit-mcp tests is replaced with the correct service-path mock.

Files to modify:

| File | Current mock | New mock |
|------|-------------|----------|
| `src/mcp-server.test.ts` | `vi.mock('jira-cli', () => ({ ... }))` | `vi.mock('./services/index.js', () => ({ ... }))` |
| `src/mcp-config.test.ts` | `vi.mock('jira-cli', () => ({ loadConfig: vi.fn() }))` | `vi.mock('./services/config.js', () => ({ loadConfig: vi.fn() }))` |
| `src/mcp-config.test.ts` | `import { loadConfig } from 'jira-cli'` (line 8) | `import { loadConfig } from './services/config.js'` |
| `src/integrations/index.test.ts` | `vi.mock('jira-cli', ...)` | `vi.mock('../services/index.js', ...)` |
| `src/integrations/jira/module.test.ts` | `vi.mock('jira-cli', ...)` | `vi.mock('../../services/index.js', ...)` |
| `src/integrations/jira/index.test.ts` | `vi.mock('jira-cli', ...)` | `vi.mock('../../services/index.js', ...)` |
| `src/integrations/github/module.test.ts` | `vi.mock('jira-cli', ...)` | `vi.mock('../../services/index.js', ...)` |
| `src/integrations/github/index.test.ts` | `vi.mock('jira-cli', ...)` | `vi.mock('../../services/index.js', ...)` |

**Important:** The mock content MUST match the exact export shape that each test needs. Currently all mocks look like:
```ts
vi.mock('jira-cli', () => ({
  JiraClient: class MockJiraClient {},
  GitHubClient: class MockGitHubClient {},
  // sometimes: toSlimIssue: vi.fn(...)
}));
```

These must become:
```ts
vi.mock('../../services/index.js', () => ({
  JiraClient: class MockJiraClient {},
  GitHubClient: class MockGitHubClient {},
  // same additional exports as before
}));
```

**Verify:** Run `npm run test` — all 7 test files' mocks resolve correctly.

---

### Phase 4: Update `mcp-server.ts` bootstrap

**Goal:** The service instantiation (`new JiraClient()`, `new GitHubClient()`) continues to work with the new import path. This import was already updated in Phase 1 — this phase is a verification checkpoint.

Change in `src/mcp-server.ts`:
- `import { JiraClient, GitHubClient } from 'jira-cli'` → `import { JiraClient, GitHubClient } from './services/index.js'`

The bootstrap itself (lines 36–52, the `clients` object creation) is unchanged because `JiraClient` and `GitHubClient` have the exact same constructor signatures — only their module location changes.

**Verify:** Run `npm run typecheck`.

---

### Phase 5: Update package.json — remove jira-cli dep, add axios + dotenv

**Goal:** toolkit-mcp no longer depends on `jira-cli` as an external package; `axios` and `dotenv` become direct dependencies.

Changes to `package.json`:

```diff
-   "jira-cli": "file:../jira-cli",
+   "axios": "^1.7.7",
+   "dotenv": "^16.4.5",
```

Full diff:

| Action | Key | Value |
|--------|-----|-------|
| Remove | `dependencies["jira-cli"]` | `"file:../jira-cli"` |
| Add | `dependencies["axios"]` | `"^1.7.7"` |
| Add | `dependencies["dotenv"]` | `"^16.4.5"` |

**Verify:** Run `npm install` in toolkit-mcp, then `npm run typecheck`, then `npm run test`. All pass.

---

### Phase 6: Deprecate jira-cli standalone package

**Goal:** Mark `jira-cli` as deprecated and frozen; remove it from any monorepo workspace registrations.

1. **Update `jira-cli/README.md`** — add a deprecation banner at the top:

   > ⚠️ **DEPRECATED** — This library has been absorbed into `toolkit-mcp`. The `jira-cli` npm scripts (`npm run cli`, `npm run whoami`, etc.) still work but will not receive further updates. For agentic integration, use `toolkit-mcp` via `npm run mcp` instead.

2. **Update `jira-cli/package.json`** — add a `"deprecated"` field or note in `"description"`.

3. **Check for external consumers** — `git grep "jira-cli" -- :^toolkit-mcp/node_modules :^jira-cli/node_modules` to find any other monorepo consumers referencing `jira-cli`. If Portage-backend, Portage-frontend, or migration scripts reference it, flag those for separate migration.

4. **Remove from CI/CD** — if `jira-cli` is built or tested in any root-level scripts (check root `package.json`, `.github/workflows/`, etc.), remove those references.

5. **Final step (future): Remove `jira-cli/` from the monorepo entirely** — this is gated on verifying zero active consumers.

---

## Dependency Changes Summary

| Package | Before | After | Notes |
|---------|--------|-------|-------|
| `jira-cli` (file dep) | toolkit-mcp dep | **removed** | Absorbed into `src/services/` |
| `axios` | toolkit-mcp (transitive via jira-cli) | **direct dep** | `^1.7.7` |
| `dotenv` | toolkit-mcp (transitive via jira-cli) | **direct dep** | `^16.4.5` |
| `@modelcontextprotocol/sdk` | unchanged | unchanged | `^1.29.0` |
| `zod` | unchanged | unchanged | `^3.23.x` |
| `tsx`, `typescript`, `vitest`, `@types/node` | dev deps unchanged | unchanged | — |

There are no other npm packages in `jira-cli` beyond `axios` and `dotenv`, so no other transitive deps need to be added to toolkit-mcp.

---

## Risk Assessment

### 1. Module resolution confusion
**Risk:** Vitest's `vi.mock()` may not resolve relative paths the same as Node.js/tsx, especially with `moduleResolution: "Bundler"`.

**Mitigation:** Run `npm run typecheck` and `npm run test` after every phase. The `github-client.test.ts` already uses relative-path imports within the same project and works fine — it just moves.

### 2. Incorrect mock export shapes
**Risk:** Some tests mock `'jira-cli'` with only a subset of its exports. After switching to `vi.mock('../../services/index.js', ...)`, if the mock doesn't provide the same export names, tests will fail with `undefined is not a constructor`.

**Mitigation:** Audit every `vi.mock` call to ensure it exports **exactly** the same names as before. The safest approach: after the port, keep the mock content identical and only change the module path.

### 3. Dotenv double-call
**Risk:** `config.ts` calls `dotenv.config({ override: true })` as a module side effect. If `mcp-config.ts` imports it at the same time, there could be a double-call (though dotenv is idempotent).

**Mitigation:** No action needed — `dotenv.config()` with `override: true` is idempotent. The import is already `import { loadConfig } from 'jira-cli'` which triggers `config.ts`'s side effect. After the port, `import { loadConfig } from './services/config.js'` triggers the same side effect.

### 4. CLI becomes orphaned
**Risk:** The `cli.ts` in `jira-cli/` still references `'./jira-client.js'` and `'./github-client.js'`. If someone removes `jira-cli/` while `cli.ts` is still in use, the CLI breaks.

**Mitigation:** Do NOT remove `jira-cli/` until Phase 6 step 5. The standalone `cli.ts` keeps working because the jira-cli source files remain in place during the deprecation window. The deprecation notice directs users away.

### 5. New exports that jira-cli doesn't expose
**Risk:** What if a new developer adds something to `jira-cli` after the port starts? This creates divergence.

**Mitigation:** After Phase 1 is complete, add a freeze notice to `jira-cli/README.md`. The port should be the LAST change to `jira-cli` source — after this, all development happens in `toolkit-mcp/src/services/`.

---

## File Change Inventory

### Files to CREATE in toolkit-mcp

| File | Action | What to do |
|------|--------|------------|
| `src/services/index.ts` | **Create** | Barrel that re-exports all public API: `JiraClient`, `GitHubClient`, `loadConfig`, `describeError`, `describeGitHubError`, `toSlimIssue`, `adfToText`, `DEV_FIELDS`, and all types. Copy content from `jira-cli/src/index.ts`, update import paths to relative `./config.js`, `./jira/jira-client.js`, `./github/github-client.js`, `./slim.js` |
| `src/services/config.ts` | **Create** | Copy from `jira-cli/src/config.ts`. No import path changes needed (only imports `dotenv`). |
| `src/services/slim.ts` | **Create** | Copy from `jira-cli/src/slim.ts`. Change import `from './jira-client.js'` → `from './jira/jira-client.js'` |
| `src/services/jira/jira-client.ts` | **Create** | Copy from `jira-cli/src/jira-client.ts`. Change imports: `from './config.js'` → `from '../config.js'`, `from './slim.js'` → `from '../slim.js'`. `MAX_RETRIES` and `sleep` are local — unchanged. |
| `src/services/github/github-client.ts` | **Create** | Copy from `jira-cli/src/github-client.ts`. No internal imports to change (only imports `axios`). |
| `src/services/github/github-client.test.ts` | **Create** | Copy from `jira-cli/src/github-client.test.ts`. Change `vi.importActual<typeof import('axios')>('axios')` — this stays the same. Change `from './github-client.js'` → `from './github-client.js'` (same path, relocated). No other import changes needed. |
| `src/services/error-helpers.test.ts` | **Create** | Copy from `jira-cli/src/error-helpers.test.ts`. Change `from './github-client.js'` → `from './github/github-client.js'` and `from './jira-client.js'` → `from './jira/jira-client.js'` |

### Files to MODIFY in toolkit-mcp

| File | Action | What to do |
|------|--------|------------|
| `package.json` | **Modify** | Remove `"jira-cli": "file:../jira-cli"` from dependencies. Add `"axios": "^1.7.7"` and `"dotenv": "^16.4.5"`. |
| `src/mcp-server.ts` | **Modify** | Line 11: change `import { JiraClient, GitHubClient } from 'jira-cli'` to `import { JiraClient, GitHubClient } from './services/index.js'` |
| `src/mcp-config.ts` | **Modify** | Line 1: change `import { loadConfig } from 'jira-cli'` to `import { loadConfig } from './services/config.js'` |
| `src/integrations/jira/index.ts` | **Modify** | Line 1: change `import { JiraClient } from 'jira-cli'` to `import { JiraClient } from '../../services/index.js'` |
| `src/integrations/jira/module.ts` | **Modify** | Lines 2-3: change `from 'jira-cli'` to `from '../../services/index.js'` for both value imports and type imports. Fix `toSlimIssue` import too. |
| `src/integrations/github/index.ts` | **Modify** | Line 1: change `import { GitHubClient } from 'jira-cli'` to `import { GitHubClient } from '../../services/index.js'` |
| `src/integrations/github/module.ts` | **Modify** | Lines 2-3: change `from 'jira-cli'` to `from '../../services/index.js'` |
| `src/mcp-server.test.ts` | **Modify** | Line 67: change `vi.mock('jira-cli', ...)` to `vi.mock('./services/index.js', ...)` — keep mock content identical |
| `src/mcp-config.test.ts` | **Modify** | Line 3: change `vi.mock('jira-cli', ...)` to `vi.mock('./services/config.js', ...)` — keep mock content identical |
| `src/integrations/index.test.ts` | **Modify** | Line 3: change `vi.mock('jira-cli', ...)` to `vi.mock('../services/index.js', ...)` — keep mock content identical |
| `src/integrations/jira/module.test.ts` | **Modify** | Lines 5-8: change `vi.mock('jira-cli', ...)` to `vi.mock('../../services/index.js', ...)` — keep mock content identical |
| `src/integrations/jira/index.test.ts` | **Modify** | Lines 5-8: change `vi.mock('jira-cli', ...)` to `vi.mock('../../services/index.js', ...)` — keep mock content identical |
| `src/integrations/github/module.test.ts` | **Modify** | Lines 4-6: change `vi.mock('jira-cli', ...)` to `vi.mock('../../services/index.js', ...)` — keep mock content identical |
| `src/integrations/github/index.test.ts` | **Modify** | Lines 3-5: change `vi.mock('jira-cli', ...)` to `vi.mock('../../services/index.js', ...)` — keep mock content identical |
| `vitest.config.ts` | **Modify** | Add `'src/services/**/*.ts'` to the coverage include list to cover the ported services |
| `README.md` | **Modify** | Update any setup instructions — note that `jira-cli` dependency is no longer needed |

### Files to MODIFY in jira-cli (Phase 6)

| File | Action | What to do |
|------|--------|------------|
| `README.md` | **Modify** | Add deprecation banner at the top |
| `package.json` | **Modify** | Optionally add deprecation notice to `description` field |

### Files to DELETE (Phase 6 — final step)

| File | Action | Condition |
|------|--------|-----------|
| `jira-cli/` (entire directory) | **Delete** | Only after verifying zero active consumers of the standalone package |

### Files UNCHANGED

| File | Rationale |
|------|-----------|
| `src/integrations/helpers.ts` | No jira-cli imports |
| `src/mcp-health.ts` | No jira-cli imports |
| `src/mcp-health.test.ts` | No jira-cli imports |
| `tsconfig.json` | Already uses `src/**/*.test.ts` exclusion pattern — covers new nested test files |
| `.env.example` | Already has all necessary env vars documented |

---

## Final Directory Layout (After Port)

```
toolkit-mcp/src/
  services/
    index.ts                            ← barrel re-export
    config.ts                           ← loadConfig() + dotenv
    slim.ts                             ← toSlimIssue, adfToText, SlimIssue, etc.
    error-helpers.test.ts               ← describeError / describeGitHubError tests
    jira/
      jira-client.ts                    ← JiraClient class
    github/
      github-client.ts                  ← GitHubClient class
      github-client.test.ts             ← GitHubClient tests
  integrations/
    index.ts                            ← IntegrationModule interface + module registry
    helpers.ts                          ← paginated(), zodToJsonSchema()
    jira/
      index.ts                          ← JiraModule class
      module.ts                         ← Jira tool/resource/prompt registrations
      index.test.ts                     ← JiraModule integration tests
      module.test.ts                    ← Jira tool handler unit tests
    github/
      index.ts                          ← GitHubModule class
      module.ts                         ← GitHub tool/resource/prompt registrations
      index.test.ts                     ← GitHubModule integration tests
      module.test.ts                    ← GitHub tool handler unit tests
  mcp-server.ts                         ← main entry point
  mcp-config.ts                         ← MCP-specific config
  mcp-health.ts                         ← health tool handler
  mcp-server.test.ts                    ← server bootstrap tests
  mcp-config.test.ts                    ← config tests
  mcp-health.test.ts                    ← health handler tests
```

---

## Verification Checklist (per Phase)

| Phase | Command | Expected |
|-------|---------|----------|
| 1 | `npx tsc --noEmit` | 0 errors |
| 1 | `npm run build` | Build succeeds |
| 2 | `npm run test` | All tests pass (includes ported tests) |
| 3 | `npm run test` | All tests pass (mocks resolved) |
| 4 | `npm run typecheck` | 0 errors |
| 5 | `npm install && npm run test` | Install succeeds, all tests pass |
| 5 | `npm run build` | Build succeeds with new deps |
| 6 | Manual — check `git grep 'jira-cli'` | No remaining references |

---

## Rollback Plan

If the port causes issues:

1. **Per-file rollback:** Each phase is a separate commit. `git revert <phase-commit>` on any phase.
2. **Keep `jira-cli` at original path:** No files are removed from `jira-cli/` during Phases 1–5. toolkit-mcp can be pointed back to `"jira-cli": "file:../jira-cli"` by reverting Phase 5.
3. **Test gate fails:** If `npm run test` fails on any phase, do NOT proceed to the next phase. Fix within the current phase before committing.
