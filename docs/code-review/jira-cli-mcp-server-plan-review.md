# Plan Review: jira-cli → Dev Workflow MCP Hub

**Document:** `docs/plans/01-jira-cli-mcp-server.md` (1128 lines)
**Reviewer:** Automated plan review
**Date:** 2026-06-23

---

## Overview

**Verdict: Changes requested** — the plan is ambitious, well-structured, and grounded in a real understanding of the existing codebase. However, it contains several architectural contradictions, design over-engineering, and sequencing issues that should be resolved before implementation begins. The core idea (module-based MCP hub with conditional registration, DI, and slim-by-default responses) is sound. The main problems are: (1) the "immutable library layer" promise is violated by Phase 3, (2) the pagination envelope is over-engineered for v1, (3) the DI pattern as described doesn't cleanly map to the MCP SDK's actual API, and (4) the plan conflates "planning" with "commitment" in several places.

---

## Things Done Well ✅

1. **Excellent constraint surface.** The plan explicitly maps every existing library method to its MCP tool equivalent (Phase 1 tool table), and every new client method to its rationale. This makes it easy to evaluate completeness.

2. **Conditional registration is the right call.** `needsEnv()` per module prevents LLM from discovering tools that would fail with auth errors. The fallback (server starts with empty tools) is graceful. This is a strong UX win.

3. **Slim-by-default + token optimization.** Building slim responses into every tool from day one, with `raw` as opt-in, shows real understanding of the MCP cost model. The `fields` subset parameter idea (Phase 2) is a good extension.

4. **Honest ecosystem positioning.** The section comparing against `sooperset/mcp-atlassian` and Atlassian's official MCP is clear-eyed — identifying the Jira↔GitHub cross-reference as the unique differentiator is the right strategic call.

5. **DI pattern for testability.** The `ToolHandler` factory pattern (`(clients) => (args) => Promise<CallToolResult>`) makes every handler unit-testable without real credentials. This is the right approach and the plan shows concrete examples.

6. **Risk register is well-thought-out.** Low/Medium/High likelihood with specific mitigations. The YAGNI risk on the module system with only 2 modules is a particularly honest self-assessment.

---

## Issues Found

### [L] Issue 1: "Immutable Library Layer" Is Contradicted by Phase 3

- **Location:** Architecture section (line 81), Phase 3 (lines 416–508, 515–598, 607–628)
- **Problem:** The plan states **"Library layer is immutable — no changes to JiraClient, GitHubClient, slim.ts, or config.ts during the MCP buildout"** as a key architectural decision. However, Phase 3 explicitly adds:
  - `fetchAllPages()` and `maxResults` param to `GitHubClient` (section 3.1)
  - `GH_REPOS` env var support to `GitHubClient` (section 3.2)
  - `createPullRequest()` method to `GitHubClient` (section 3.3)
  - `listBranches()` method to `GitHubClient` (section 3.4)
  - `searchPrsByBranchName()` method to `GitHubClient` (section 3.5)
  - `listProjects()` / `listProjectsSlim()` to `JiraClient` (section 3.6)
  - `getFieldMetadata()` to `JiraClient` (section 3.7)
  - `searchUsers()` to `JiraClient` (section 3.8)
  - Entirely new `ConfluenceClient` class (section 3.11)

  The "immutable" claim holds only for Phase 1. Phase 3 substantially mutates the library layer. This is fine as a phased approach, but calling it immutable is misleading and could cause an implementer to waste time trying to avoid library changes.

- **Recommendation:** Re-label the constraint: **"Phase 1: MCP layer is additive — library layer is frozen during Phase 1 only."** Or restructure the statement as: "The library layer is treated as stable; new capabilities are added to the library layer in Phase 3 alongside their MCP wrappers." Update the architecture diagram to show Phase 3 arrows back into the library layer.

---

### [L] Issue 2: Pagination Envelope Is Over-Engineered for v1

- **Location:** Architecture — Standard Pagination Response Shape (lines 140–156)
- **Problem:** The pagination envelope includes **four** parameters (`cursor`, `offset`, `limit`, `max`) and three response fields (`nextCursor`, `total`, `hasMore`). This is a lot of surface area for v1, especially when:
  - No backend in the existing library actually supports all of these. `JiraClient.search()` uses cursor-based pagination via `nextPageToken`/`isLast`. `GitHubClient.searchPrs()` uses offset-based `per_page`/`page` and doesn't even expose pagination yet.
  - The `max` parameter (total cap) and `limit` (page size) overlap significantly. An LLM can achieve the same effect by setting `limit` and reading `hasMore`.
  - The plan itself says "Cursor-based over offset-based when available" — but then exposes both in every tool's interface, creating ambiguity about which one the LLM should use.
  - Maintaining both cursor and offset across every list-style tool means every handler needs to decide which pagination strategy to apply, adding complexity and testing burden.

- **Recommendation:** Simplify to a **two-parameter envelope** for v1:

  ```typescript
  interface PaginatedResponse<T> {
    items: T[];
    nextPageToken?: string;  // opaque cursor; absent = no more results
    hasMore: boolean;
  }
  ```

  Drop `offset` entirely (cursors are more stable and the `max`/`total` can be stripped or added per-tool only when the backing API provides them). Drop `max` — if an LLM needs to cap results, it can set a low `limit` or stop paginating when it has enough. Add `total` only when the API provides it (Jira's `search/jql` does, GitHub Search does not). This reduces handler complexity and testing surface by ~40%.

---

### [M] Issue 3: DI Pattern Doesn't Cleanly Map to MCP SDK `Server.registerTool()`

- **Location:** Phase 5 — Dependency Injection Pattern (lines 716–754)
- **Problem:** The plan shows tools being called via `server.callTool()` directly in tests (line 828: `const result = await server.callTool({ name: 'github_get_prs', ... })`), but this is an MCP client-side method, not a server-side one. On the server side, `server.registerTool()` takes a handler function directly:

  ```typescript
  server.setRequestHandler(ListToolsRequestSchema, ...);
  // or in more recent SDK versions:
  server.tool("name", schema, handler);
  ```

  The `ToolHandler` factory pattern in the plan produces `(args) => Promise<CallToolResult>` functions. The gap is how these get wired into the MCP SDK's own handler registration. The plan needs to be explicit about how the DI wiring translates to the SDK's API — e.g., whether modules register directly with the SDK or return tool descriptor objects that `mcp-server.ts` registers.

  Current plan: `registerTools(server, { jira, github })` — but what does this call internally? `server.setRequestHandler(ListToolsRequestSchema, ...)`? That only handles the listing. For actually calling tools, it needs `server.setRequestHandler(CallToolRequestSchema, ...)` with a dispatch based on `request.params.name`. The plan hand-waves this critical integration point.

- **Recommendation:** Add a concrete wiring section showing the actual `registerTools` implementation:

  ```typescript
  // In module.ts
  function registerTools(server: Server, clients: Record<string, unknown>): void {
    // Register each tool as a named handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      switch (name) {
        case 'jira_get_issues':
          return jiraGetIssuesHandler(clients)(args);
        case 'jira_create_issue':
          return jiraCreateIssueHandler(clients)(args);
        // ... etc
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    });
  }
  ```

  Or, if the MCP SDK v1 supports per-tool handlers via a builder pattern, show that. Don't leave this as an exercise for the implementer.

---

### [M] Issue 4: `confluence_get_pages` and `confluence_get_page` Are Redundant

- **Location:** Phase 3 — Confluence Module (lines 620)
- **Problem:** The plan proposes both a polymorphic `confluence_get_pages` (accepting `key` for single page OR `cql` for search) AND a `confluence_get_page` "alias for single page by ID" (line 620 literally says "alias"). This violates the plan's own design principle of reducing the tool surface (line 7 in the goals: "minimal tool descriptions", line 365: "polymorphic tools reduce total surface area"). Two tools that do the same thing will confuse LLMs.

- **Recommendation:** Drop `confluence_get_page`. The polymorphic `confluence_get_pages` already handles single-page lookup via `key`. If an LLM wants one page, it passes `key`. If it wants to search, it passes `cql`. Same pattern as `jira_get_issues`. No need for an alias.

---

### [M] Issue 5: `jira_get_issues` Polymorphism Has an Asymmetry Problem

- **Location:** Phase 1 — Tool Registration Table (line 209)
- **Problem:** When `jira_get_issues` is called with `key`, it returns a single `SlimIssue` object. When called with `jql`, it returns a `PaginatedResponse<SlimIssue>`. The return type changes based on the parameter. LLMs in practice struggle with polymorphic return types — they may try to iterate over a single object or fail to unwrap a paginated response.

  The plan says "If both provided, `key` wins" (line 209), which is deterministic, but the changing response shape is a real usability concern. An LLM that expects `{ items: [...] }` and gets a bare SlimIssue will be confused.

- **Recommendation:** Make `jira_get_issues` **always return a `PaginatedResponse<SlimIssue>`**. When called with `key`, return a one-item array with `hasMore: false` and no cursor. This makes the return type consistent regardless of the input mode. The only cost is one extra level of wrapping (which you can mitigate by having `items` as a top-level key), but the LLM always knows what shape to expect. Alternatively, split into `jira_get_issue` (singular, returns SlimIssue) and `jira_search_issues` (returns PaginatedResponse). This adds one tool but eliminates the polymorphic confusion entirely.

---

### [M] Issue 6: `mcp_health` Tool Name Violates the Plan's Own Naming Convention

- **Location:** Built-in Tools (lines 232–233)
- **Problem:** The plan's naming convention is `{domain}_{verb}_{noun}` (line 235: "`jira_get_issues`, `github_get_prs`"). But `mcp_health` uses `mcp` as the domain prefix, which is fine, but `health` is a noun with no verb. It should be `mcp_get_health` or `mcp_check_health` for consistency.

  Minor, but naming conventions that aren't applied uniformly confuse LLMs that have learned the pattern.

- **Recommendation:** Rename to `mcp_get_health` to match the `{domain}_{verb}_{noun}` convention.

---

### [S] Issue 7: `clients: Record<string, unknown>` Erases Type Safety

- **Location:** IntegrationModule Interface (lines 94–131)
- **Problem:** The `clients` parameter across all interface methods is typed as `Record<string, unknown>`. This means every module's `registerTools` and `registerResources` implementations need to cast clients (e.g., `const jira = clients.jira as JiraClient`). This loses the type-safety benefit that motivated the DI pattern in the first place.

- **Recommendation:** Make the interface generic over available clients, or use a discriminated union type:

  ```typescript
  interface IntegrationModule<T extends Record<string, unknown> = Record<string, unknown>> {
    registerTools(server: Server, clients: T): void;
    registerResources(server: Server, clients: T): void;
  }
  ```

  Then modules type their expected clients:
  ```typescript
  class JiraModule implements IntegrationModule<{ jira: JiraClient }> { ... }
  class GitHubModule implements IntegrationModule<{ github: GitHubClient }> { ... }
  ```

  Or, simplistically, just define specific typed interfaces for the known clients and let the MCP server's bootstrap function pass them through with their correct types.

---

### [S] Issue 8: Phase 3 Adds the Wrong Thing First — GitHub Deserves Priority Over Jira Enhancements

- **Location:** Phase 3 — Priority labels across sections (3.1–3.10)
- **Problem:** The plan labels GitHub PR creation (Medium), branch listing (Medium), and branch-name PR matching (Medium) — but labels Jira sprint/board info (Low) and attachment download (Low). This misses the actual pain point: the existing `GitHubClient` has working PR search. The value gap is in **adding the missing Jira methods** (project listing, field metadata, user search) that are High/Medium but essential for the initial MCP use case.

  Without `listProjects` and `getFieldMetadata` in Phase 1, an LLM trying to create a Jira issue via MCP will hit a wall — it needs to validate project keys and know required fields. These should be bumped to Phase 1 or very early Phase 3, ahead of GitHub branch listing and branch-name PR matching (which are nice-to-haves).

- **Recommendation:** Move Jira project listing (3.6) and field metadata (3.7) to **Phase 1** as first-class tools alongside the existing client wrappers. They're prerequisites for the `jira_create_issue` tool to be useful to an LLM. The GitHub branch-name matching (3.5) can wait.

---

### [S] Issue 9: No Error Recovery Strategy for Multi-Tool Composite Operations

- **Location:** Phase 4 — `workflow_status` tool (lines 692–697), Phase 5 — Testing (error handling section line 806)
- **Problem:** Phase 4 proposes composite tools that orchestrate across multiple integration modules (`workflow_status` calls Jira search, then GitHub PR lookup). The plan doesn't address: what happens if the Jira call succeeds but GitHub fails? Does the tool return partial results? Propagate the error? Retry just the failing leg?

  The error handling section (line 806) only covers "client throws → MCP error response" — there's no mention of partial failures, timeouts on composite tools, or the risk of taking too long (MCP requests can timeout).

- **Recommendation:** Add a concrete error-recovery strategy for composite tools:
  - **Partial failure:** Return both data and errors in the response (e.g., `{ results: [...], errors: { github: "rate limited" } }`)
  - **Timeout guard:** Composite tools should have an internal timeout per API leg
  - **Graceful degradation:** If one module fails, return results from the other with an error annotation

---

### [S] Issue 10: The Module Registry Is Static, Not Auto-Discovered

- **Location:** Architecture section (line 134: "discovers all modules in `src/integrations/`")
- **Problem:** The plan says the server "discovers" modules, but the actual implementation (line 185: `src/integrations/index.ts` — Module registry — "exports array of all IntegrationModule implementations") is a static registry: every module is explicitly imported. This isn't discovery — it's a compile-time list. True discovery (file-system scanning) would be dynamic but is unnecessary.

  The language "discovers" creates an expectation that adding a new module only requires creating a directory, when in reality you also need to add an import to the registry. This is a minor documentation issue but could cause confusion.

- **Recommendation:** Use precise language: **"The module registry (`src/integrations/index.ts`) explicitly imports and exports all module implementations. Adding a new module requires creating its directory AND adding its import to the registry."** If you want true auto-discovery via file-system glob, call that out as a future improvement. But for v1, the explicit import is fine and preferable (avoids dynamic imports and keeps tree-shaking working).

---

## Secondary Concerns 🟡

1. **Phase 2 (token optimization) should not be a separate phase.** Token optimization (slim defaults, pagination caps, concise descriptions) is baked into Phase 1 already. Making it Phase 2 implies it's optional or deferred. Merge Phase 2's concrete action items (the `fields` subset parameter, response metadata ordering) into Phase 1.

2. **The `raw` boolean on `jira_get_issues` is risky.** An LLM that doesn't know what it's missing may never use `raw`, and a developer who needs to debug a custom field won't know to ask for it. Consider a `fields` parameter instead of a raw boolean — let the LLM request specific fields it needs. `raw: true` is a sledgehammer that undoes all the token optimization.

3. **Confluence auth reuses Jira tokens, but the doc doesn't confirm this works in practice.** The plan says "Same BASIC auth as Jira (Confluence Cloud uses the same API token)" (line 618). This is true for Atlassian Cloud, but the plan should note that this only works for the same Atlassian organization. If a team uses different orgs for Confluence vs Jira, this breaks. The conditional env var check (`CONFLUENCE_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN`) is correct for the most common case.

4. **Missing: Confluence `getPage` body format.** The plan shows `ConfluenceClient.getPage()` returning `body: string`, but the Confluence REST API returns body in multiple formats (`storage`, `atlas_doc_format`, `view`). The plan doesn't specify which format the client requests or whether ADF-to-text conversion is needed. Add this detail.

5. **The `npm run mcp` script uses `node --import tsx` which works but is fragile.** The `--import` flag for tsx requires tsx ^4.19.x (current dependency). This is fine for now, but if someone upgrades their toolchain and tsx drops `--import` support, the MCP server silently breaks. Consider a compiled entry point with `"build": "tsc"` and a `"start:mcp": "node dist/mcp-server.js"` as a fallback. The plan already mentions the Docker image tradeoff (line 1001) but doesn't address this for local dev.

6. **Missing: `JiraClient` constructor already requires `loadConfig()` — but `loadConfig()` throws if Jira env vars are missing.** The plan's conditional registration works only if the Jira env vars are optional at the config level. Currently, `loadConfig()` throws if `JIRA_BASE_URL`, `JIRA_EMAIL`, or `JIRA_TOKEN` are missing (config.ts line 23). The MCP server must handle this: either make `loadConfig()` not throw but return a partial config, or wrap it in a try/catch in the module's `needsEnv()` check. The plan uses `mcp-config.ts` to wrap `loadConfig()` (line 85) but doesn't say whether this wrapper catches the throw or lets it propagate.

   **This is a merge-blocking bug in the plan** — if the server starts and `needsEnv()` calls Jira module registration before checking env vars, `loadConfig()` may throw and crash the entire server process.

7. **The "out of scope" table (lines 928–937) lists `TravelTracker/`, `Portage-backend/`, `Portage-frontend/` as "not touched."** This is correct, but the GH_REPOS env var change (section 3.2) affects how GitHubClient discovers repos and should be cross-referenced with the monorepo's own CI/CD configs. Not a blocking concern, but something to note for rollout.

8. **Future ideas section (lines 941–1010) is 70 lines of unstructured "maybe."** The plan should either (a) commit to which future items are tracked as roadmap tickets, or (b) remove them from the plan document and link to a separate roadmap doc. As-is, they add noise. This is a minor readability concern.

---

## Verdict

| Category | Score | Notes |
|---|---|---|
| Architecture soundness | 🟡 | Strong foundation but the "immutable library" contradiction and over-engineered pagination need fixing |
| Tool design | 🟡 | Good coverage; the `confluence_get_page` redundancy and `jira_get_issues` asymmetric return type are fixable |
| Feasibility | 🟡 | Phase sequencing needs reordering; the `loadConfig()` crash risk is a real blocker |
| Testability | ✅ | DI pattern is well-thought-out; per-module test files are sensible |
| Completeness | 🟡 | Good risk register; missing error recovery for composite tools and a key blocking issue around config |
| Backward compat | ✅ | CLI is untouched; library frozen in Phase 1 |

**Merge-blocking:** Yes — **2 blocking issues must be resolved before implementation:**

1. **Fix the loadConfig() crash risk.** The MCP server must not crash when modules are inactive. Either make `loadConfig()` not throw on missing Jira env vars, or wrap the bootstrap in try/catch so a missing Jira config doesn't prevent the GitHub module from loading. Add this to Phase 1.

2. **Resolve the pagination envelope over-engineering.** Simplify to `items` + `nextPageToken` + `hasMore` for v1. Drop `offset` and `max`. Add `total` only when the API provides it. This reduces the per-handler implementation burden significantly.

**Should do before merge (high priority):**
- Document the actual `registerTools` implementation showing how DI wires into the MCP SDK's `CallToolRequestSchema` handler
- Always-return-paginated for `jira_get_issues` (fix the asymmetric return type), or split into separate `jira_get_issue` + `jira_search_issues`
- Move Jira project listing and field metadata into Phase 1
- Merge Phase 2's concrete items into Phase 1

**Should do before merge (medium priority):**
- Drop `confluence_get_page` alias
- Rename `mcp_health` → `mcp_get_health`
- Type the `clients` parameter instead of `Record<string, unknown>`
- Add partial-failure error recovery for composite tools
- Clarify the "static registry" vs "auto-discovery" language

**Should do before merge (low priority):**
- Add compiled-entry fallback for `npm run mcp`
- Explicitly state which Confluence body format the client fetches
- Prune the future-ideas section to only tracked roadmap items
