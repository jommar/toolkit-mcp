# CLAUDE.md — toolkit-mcp

> Dev Workflow MCP Hub — bridges AI coding agents with Jira, GitHub, and more.
> Node, TypeScript, MCP SDK, Zod.

## Project Identity

**toolkit-mcp** is an MCP (Model Context Protocol) server that exposes developer toolchain operations (Jira issue management, GitHub PR search, and more) as MCP tools, resources, and prompts for AI coding agents.

The `JiraClient`, `GitHubClient`, and utility modules (`slim.ts`, `config.ts`) live **inside** toolkit-mcp as an internal service layer at `src/services/`. The MCP integration layer (`src/integrations/`) wraps these services with Zod schemas and MCP response formatting. There is no external library dependency — everything is self-contained.

### Architecture Layers

| Layer | Location | Responsibility |
|-------|----------|----------------|
| **Service layer** | `src/services/` | API clients (`JiraClient`, `GitHubClient`), data shapes (`SlimIssue`, `PrInfo`), slim transformations, config loading |
| **Integration layer** | `src/integrations/` | MCP server bootstrap, integration modules, tool/resource/prompt registration, DI wiring |

- The standalone CLI (`npm run cli` in `../jira-cli/`) is deprecated but still available as a legacy convenience.

## Architecture

```
src/
├── mcp-server.ts              # Entry: bootstrap, transport, module registry, DI wiring
├── mcp-config.ts              # MCP-specific config (transport, port, log level)
├── mcp-health.ts              # mcp_get_health tool handler (always registered)
├── services/
│   ├── index.ts               # Barrel — re-exports all service classes/types
│   ├── config.ts              # loadConfig() + dotenv (shared by Jira/GitHub)
│   ├── slim.ts                # SlimIssue, toSlimIssue, adfToText
│   ├── jira/
│   │   └── jira-client.ts     # JiraClient class
│   └── github/
│       ├── github-client.ts   # GitHubClient class
│       └── github-client.test.ts
├── integrations/
│   ├── index.ts               # Module registry — static import of all modules
│   ├── helpers.ts             # PaginatedResponse helper, zodToJsonSchema
│   ├── jira/
│   │   ├── index.ts           # IntegrationModule impl + needsEnv()
│   │   ├── module.ts          # registerTools, registerResources, registerPrompts
│   │   └── module.test.ts     # Tests with mocked JiraClient
│   └── github/
│       ├── index.ts           # IntegrationModule impl + needsEnv()
│       ├── module.ts          # registerTools, registerResources, registerPrompts
│       └── module.test.ts     # Tests with mocked GitHubClient
```

### IntegrationModule Interface

Every integration module follows this contract:

```typescript
interface IntegrationModule<C extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  needsEnv(): boolean;                         // true if all required env vars are set
  createToolHandlers(clients: C): Record<string, ToolHandlerFn>;
  getToolDescriptors(): ToolDescriptor[];
  getResourceHandler?(clients: C): (uri: string) => Promise<ReadResourceResult>;
  getPromptHandler?(clients: C): (name: string, args: Record<string, unknown> | undefined) => Promise<GetPromptResult>;
}
```

Modules type their expected clients via the generic parameter:

```typescript
class JiraModule implements IntegrationModule<{ jira: JiraClient }> { ... }
class GitHubModule implements IntegrationModule<{ github: GitHubClient }> { ... }
```

### Conditional Tool Registration

- **Jira module** — registered only if `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` are all set.
- **GitHub module** — registered only if `GH_TOKEN` is set.
- **Jenkins module** — registered only if `JENKINS_URL`, `JENKINS_USER`, `JENKINS_TOKEN` are all set (read-only tools).
- **No env vars?** The server starts with an empty tools list (graceful degradation). A built-in `mcp_get_health` tool is always registered to report active integrations.
- The server logs which integration sets are active at startup.

### Dependency Injection (DI)

Tool handlers are defined as **handler factories** that receive client instances and return the actual handler:

```typescript
type ToolHandler<T = unknown> = (
  clients: { jira?: JiraClient; github?: GitHubClient },
) => (args: T) => Promise<CallToolResult>;

// The handler factory pattern:
const jiraGetIssuesHandler: ToolHandler<{ key?: string; jql?: string; ... }> =
  (clients) => async (args) => {
    if (args.key) {
      const issue = await clients.jira!.getIssueSlim(args.key);
      return { content: [{ type: 'text', text: JSON.stringify(issue) }] };
    }
    // ... search path with pagination
  };
```

This makes every handler testable with mock clients — no real credentials needed.

### Module Registry

**Static, not auto-discovered.** The registry at `src/integrations/index.ts` explicitly imports and exports all module implementations. Adding a new integration requires:
1. Creating `src/integrations/<name>/` with an `IntegrationModule` implementation
2. Adding its import to `src/integrations/index.ts`

### Safe Bootstrap

`mcp-config.ts` wraps `loadConfig()` (from `src/services/config.js`) in try/catch. If `loadConfig()` throws due to missing Jira env vars, `mcp-config.ts` returns a partial config rather than crashing. The bootstrap flow:
1. Read `process.env` directly for conditional module checks
2. Register only modules whose env vars are present
3. Create client instances only for qualified modules

## Key Design Rules

### Paginated Response Shape

All list-style tools return a uniform envelope:

```typescript
interface PaginatedResponse<T> {
  items: T[];
  nextPageToken?: string;  // opaque cursor; absent = no more results
  hasMore: boolean;        // true if there are additional results
}
```

Parameters accepted by every list tool:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cursor` | `string` | — | Opaque pagination token |
| `limit` | `number` | `20` | Items per page (max 100) |

- `total` is **not** part of the generic envelope — added per-tool only when the backing API provides it.
- `offset` is dropped entirely; cursors are more stable.
- No tool auto-fetches all pages — the agent must explicitly paginate via `cursor`.

### Polymorphic Tools (Always Return PaginatedResponse)

`jira_get_issues` accepts `key` (single issue) OR `jql` (search). **Always returns `PaginatedResponse<SlimIssue>`** — even a single-issue lookup returns a one-item array with `hasMore: false`. This gives LLMs a consistent response shape regardless of the input mode.

If both `key` and `jql` are provided, `key` wins.

### Tool Naming Convention

`{domain}_{verb}_{plural_noun}` — e.g., `jira_get_issues`, `github_get_prs`.

Use **plural** for list-style tools, **singular** when the tool returns or acts on a single item: `jira_create_issue`, `jira_add_comment`.

### Tool Descriptions

Exactly one sentence. Concise. No filler.

| Tool | Description |
|------|-------------|
| `jira_get_issues` | "Fetch one or more Jira issues. Pass `key` for a single issue, or `jql` to search." |
| `jira_create_issue` | "Create a new Jira issue in a project." |
| `jira_update_issue` | "Update fields on an existing Jira issue." |
| `jira_transition_issue` | "Transition a Jira issue to a new status." |
| `jira_add_comment` | "Add a comment to a Jira issue." |
| `github_get_prs` | "Find pull requests for one or more issue keys." |
| `github_create_pr` | "Create a pull request from a branch." |
| `github_add_pr_comment` | "Add an issue-level comment to a pull request." |
| `github_update_pr` | "Update an existing pull request (title, body, state, base branch, or maintainer settings)." |
| `github_list_branches` | "List branches in a GitHub repository." |
| `mcp_get_health` | "Report which integrations are active." |

### JSON Serialization

- Single-line JSON in MCP responses (no pretty-printing).
- Strip `undefined` values.

### Key Parameters on Every Tool

- Required parameters appear first in the zod schema.
- Optional parameters use `.optional()`.
- In the `fields?: string[]` parameter, agents request specific fields they need (not a raw boolean).

## Setup

```bash
cd toolkit-mcp
npm install
cp .env.example .env    # or cp ../jira-cli/.env .env if you already have one
```

## Running

| Command | Description |
|---------|-------------|
| `npm run mcp` | Dev mode — `tsx` TypeScript execution, stdio transport |
| `npm run mcp:prod` | Production — compiled JS (`npm run build` first) |
| `npm run mcp:inspect` | Launch MCP inspector for debugging |
| `npm run build` | TypeScript compilation (`tsc`) |
| `npm run typecheck` | TypeScript type-check only (`tsc --noEmit`) |
| `npm run test` | Run all tests (vitest) |
| `npm run test:watch` | Vitest watch mode |

### Configuration

All optional — tools only register if their env vars are present:

| Variable | Integration | Required for |
|----------|-------------|-------------|
| `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN` | Jira | All Jira tools |
| `GH_TOKEN` | GitHub | All GitHub tools / PR search |
| `JENKINS_URL` + `JENKINS_USER` + `JENKINS_TOKEN` | Jenkins | All Jenkins tools (read-only) |
| `MCP_TRANSPORT` | Server | Transport mode (`stdio` default, `http`) |
| `MCP_PORT` | Server | HTTP port (default `3000`) |
| `MCP_LOG_LEVEL` | Server | `silent` | `info` | `debug` |

Full `.env.example` in project root.

### MCP Client Config (for AI IDEs)

```json
{
  "mcpServers": {
    "toolkit-mcp": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/toolkit-mcp/src/mcp-server.ts"],
      "env": {
        "JIRA_BASE_URL": "https://pathwise.atlassian.net",
        "JIRA_EMAIL": "you@pathwisek12.com",
        "JIRA_TOKEN": "...",
        "GH_TOKEN": "..."
      }
    }
  }
}
```

## Testing

Framework: **vitest** (configured in `vitest.config.ts`).

```bash
npm run test              # Run all tests
npx vitest run path/to/file.test.ts   # Single test file
```

### DI Pattern for Testability

All tool handlers are defined as factories that receive client instances. Tests call the factory directly with mock clients:

```typescript
const mockJiraClient = {
  getIssueSlim: vi.fn().mockResolvedValue(mockSlimIssue),
  // ...
};
const handler = jiraGetIssuesHandler({ jira: mockJiraClient });
const result = await handler({ key: 'TEST-123' });
expect(result).toMatchSnapshot();
```

This avoids needing real credentials or network calls.

### Test Files

| File | What it tests |
|------|---------------|
| `src/services/github/github-client.test.ts` | GitHubClient class (54 tests) |
| `src/services/error-helpers.test.ts` | describeError / describeGitHubError (9 tests) |
| `src/integrations/jira/module.test.ts` | Jira module — tool handlers with mock JiraClient |
| `src/integrations/github/module.test.ts` | GitHub module — tool handlers with mock GitHubClient |
| `src/integrations/jira/index.test.ts` | JiraModule — needsEnv, resources, prompts |
| `src/integrations/github/index.test.ts` | GitHubModule — needsEnv, resources |
| `src/integrations/index.test.ts` | Module registry |
| `src/mcp-server.test.ts` | Module discovery, conditional registration, health tool |
| `src/mcp-config.test.ts` | Config loading logic |
| `src/mcp-health.test.ts` | Health handler |

Coverage includes: `src/mcp-server.ts`, `src/mcp-config.ts`, `src/mcp-health.ts`, `src/integrations/**/*.ts`, `src/services/**/*.ts`.

## Important Constraints

1. **Services are pure API clients with no MCP awareness.** They remain testable without MCP SDK dependencies. Integrations import services, wrap them with Zod schemas and MCP response formatting.
2. **Graceful degradation.** If no env vars are set, the server starts with only the `mcp_get_health` tool. No crashes.
3. **Module registry is static.** Adding a new integration requires creating the directory AND adding its import to `src/integrations/index.ts`.
4. **`loadConfig()` must not crash the bootstrap.** `mcp-config.ts` wraps it in try/catch so missing Jira env vars don't prevent GitHub-only operation.
5. **Composite tools must handle partial failures.** If one API leg fails, the response should include the successful results plus an error annotation for the failed leg. Never cascade failures.
6. **The `jira-cli` standalone CLI is deprecated.** All library development now happens in `src/services/`.

## Reference

- **Architecture plan (v1):** `docs/plans/01-jira-cli-mcp-server.md` — original implementation plan.
- **Port jira-cli into services:** `docs/plans/03-port-jira-cli-into-toolkit-mcp.md` — the plan to absorb jira-cli as an internal service layer.
- **Monorepo conventions:** `/ezat/AGENTS.md` — project tables, code change workflow, code review workflow.
