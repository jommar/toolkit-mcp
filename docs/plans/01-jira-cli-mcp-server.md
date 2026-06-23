# jira-cli → toolkit-mcp

## Overview

Evolve the existing `jira-cli` (a TypeScript Jira REST API client + CLI tool) into a full **toolkit-mcp** — an MCP (Model Context Protocol) server that bridges AI coding agents with the entire developer toolchain. The library layer (`JiraClient`, `GitHubClient`, `slim.ts`) stays untouched during Phase 1 foundation; new client methods are added in Phase 2+ alongside their MCP wrappers.

The server is organized as a **module-based integration hub**. Each external tool (Jira, GitHub, Confluence, etc.) is a self-contained integration module that registers tools, resources, and prompts only when its required environment variables are set. This prevents the LLM from discovering tools that would immediately fail with auth errors.

Long-term vision: a general-purpose **dev-workflow MCP hub** that goes beyond Jira/GitHub to cover code review, deployment tracking, release management, observability, and more — all through a single MCP server instance.

---

## Current State

The existing codebase (v0.2.0) provides:

- **`JiraClient`** (300 lines, 17 methods) — covers 10+ Jira REST API v3 endpoints with retry/backoff
- **`GitHubClient`** (291 lines, 2 public methods + helpers) — searches TransActComm repos for PRs by issue key, batched key lookup, review status fetching
- **`SlimIssue` / `toSlimIssue` / `adfToText`** (125 lines) — ~95% size reduction vs raw Jira payload via server-side field projection + client-side flattening
- **CLI layer** (235 lines) — 11 commands, single `cli.ts` file
- **27 tests** — GitHubClient (18) + error-helpers (9); **zero JiraClient tests, zero slim.ts tests**
- **Retry interceptor** — exponential backoff on both clients (429/5xx/ECONNABORTED, up to 3 retries)
- **Config** — `loadConfig()` reads `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` from `.env`; `GitHubClient` reads `GH_TOKEN` directly from `process.env`

Full API surface documented in `README.md` and prior plan `docs/plans/jira-cli-prs.md`.

---

## Goals

1. **Seamless agentic coding** — AI coding agents auto-discover and use Jira/GitHub tools through the MCP protocol (no manual CLI commands, no context-switching)
2. **Token cost savings** — all MCP tools return slim shapes by default, smart pagination with conservative defaults, batched operations, minimal tool descriptions
3. **Extensible foundation** — layered architecture so the server can grow into a general dev-tool MCP hub without rewriting the core library
4. **Backward compatibility** — the CLI continues working; existing library consumers (`npm run cli`, programmatic `import`) are unaffected

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                          MCP Transport Layer                          │
│  ┌──────────────────┐   ┌──────────────────────────────────────┐    │
│  │  stdio transport  │   │  Streamable HTTP transport (future)  │    │
│  └────────┬─────────┘   └────────────────┬─────────────────────┘    │
│           │                              │                            │
│           └──────────┬───────────────────┘                            │
│                      ▼                                                │
│              ┌────────────────┐                                        │
│              │   MCP Server   │  src/mcp-server.ts                     │
│              │   (Server)                   │   — imports modules from registry       │
│              │   registers    │  — creates shared client instances    │
│              │   tools/       │  — injects clients via DI             │
│              │   resources/   │                                        │
│              │   prompts      │                                        │
│              └────┬──────┬────┘                                        │
│                   │      │                                             │
│          ┌────────┘      └────────┐                                    │
│          ▼                         ▼                                     │
│  ┌─────────────────┐   ┌───────────────────────┐                        │
│  │  Integration     │   │  Integration           │                       │
│  │  Module: Jira    │   │  Module: GitHub        │   ...                  │
│  │  ┌─────────────┐ │   │  ┌─────────────────┐   │                        │
│  │  │ registerTools│ │   │  │ registerTools   │   │                        │
│  │  │ registerRes..│ │   │  │ registerRes..   │   │                        │
│  │  │ needsEnv()   │ │   │  │ needsEnv()      │   │                        │
│  │  └──────┬──────┘ │   │  └────────┬────────┘   │                        │
│  └─────────┼────────┘   └───────────┼────────────┘                        │
│            │                        │                                     │
│  ┌─────────┴────────────────────────┴────────────────────────────────┐   │
│  │    External Library: jira-cli (imported via npm dependency)      │   │
│  │                                                                   │   │
│  │  JiraClient  │  GitHubClient  │  ConfluenceClient  │  slim.ts     │   │
│  │  config.ts   │  index.ts      │  cli.ts            │              │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key architectural decisions:**

1. **Phase 1: MCP layer is additive — library layer is frozen during Phase 1 only.** In Phase 2+, new capabilities (e.g., `listProjects`, `getFieldMetadata`, `createPullRequest`) are added to the library layer alongside their MCP wrappers. The MCP layer always depends on the library, not the other way around.
2. **MCP layer is additive** — new files only. The CLI (`cli.ts`) continues to work and is not modified.
3. **Slim-by-default** — every MCP tool returns slim shapes; a `fields?: string[]` parameter on relevant tools lets the LLM request specific fields beyond the default set, instead of a raw boolean that undoes all token optimization.
4. **Fail fast in MCP handlers** — validate parameters at the handler boundary, return structured MCP error responses, never let uncaught exceptions propagate to the transport.
5. **Config extension via composition + safe bootstrap** — MCP-specific config (transport type, port, log level) lives in `mcp-config.ts`, which wraps `loadConfig()` in a try/catch. If `loadConfig()` throws due to missing Jira env vars, `mcp-config.ts` returns a partial config with null/missing Jira fields rather than crashing. The bootstrap flow: (a) read `process.env` directly for conditional module checks, (b) register only modules whose env vars are present, (c) create client instances only for qualified modules.
6. **Conditional tool registration** — tools are only registered if their corresponding environment variables are set. No env var = no tool for that domain. The server logs which integration sets are active at startup.
7. **Dependency injection** — tool handlers receive client instances (JiraClient, GitHubClient, etc.) rather than constructing them. The MCP server creates clients once and passes them to tool/resource/prompt registrations, making every handler unit-testable with mock clients.

### IntegrationModule Interface

Every integration module follows this contract:

```typescript
interface IntegrationModule<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique module identifier (e.g., "jira", "github", "confluence") */
  id: string;

  /**
   * Returns true if the required environment variables for this module
   * are all set. The MCP server calls this before registering the module.
   */
  needsEnv(): boolean;

  /**
   * Register all tools exposed by this module.
   * Receives the MCP Server instance and typed client instances.
   * Clients are injected (DI) — never constructed inside the handler.
   */
  registerTools(
    server: Server,
    clients: C,
  ): void;

  /**
   * Register all resource templates exposed by this module.
   * Same DI pattern as registerTools.
   */
  registerResources(
    server: Server,
    clients: C,
  ): void;

  /**
   * Register all prompt templates exposed by this module.
   * Same DI pattern as registerTools.
   */
  registerPrompts?(
    server: Server,
    clients: C,
  ): void;
}
```

Modules then type their expected clients:

```typescript
class JiraModule implements IntegrationModule<{ jira: JiraClient }> {
  registerTools(server: Server, clients: { jira: JiraClient }): void { ... }
}

class GitHubModule implements IntegrationModule<{ github: GitHubClient }> {
  registerTools(server: Server, clients: { github: GitHubClient }): void { ... }
}
```

The module registry (`src/integrations/index.ts`) explicitly imports and exports all modules. The main `src/mcp-server.ts` imports the registry, calls `needsEnv()` for each, and only registers those whose dependencies are met. Adding a new module requires creating its directory AND adding its import to the registry. If no modules are eligible, the server starts but returns an empty tools list.

### Registering Tools with the MCP SDK

The `registerTools` method on each `IntegrationModule` wires handler factories into the MCP SDK's `CallToolRequestSchema` handler via a dispatch switch:

```typescript
// In jira/module.ts
function registerTools(server: Server, clients: { jira: JiraClient }): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
      case 'jira_get_issues':   return handleJiraGetIssues(clients)(args);
      case 'jira_create_issue': return handleJiraCreateIssue(clients)(args);
      case 'jira_update_issue': return handleJiraUpdateIssue(clients)(args);
      case 'jira_transition_issue': return handleJiraTransitionIssue(clients)(args);
      case 'jira_assign_issue': return handleJiraAssignIssue(clients)(args);
      case 'jira_add_comment':  return handleJiraAddComment(clients)(args);
      case 'jira_link_issues':  return handleJiraLinkIssues(clients)(args);
      case 'jira_whoami':       return handleJiraWhoami(clients)(args);
      case 'jira_list_projects': return handleJiraListProjects(clients)(args);
      case 'jira_get_fields':   return handleJiraGetFields(clients)(args);
      case 'jira_search_users': return handleJiraSearchUsers(clients)(args);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'jira_get_issues',
        description: 'Fetch one or more Jira issues...',
        inputSchema: { /* zod-derived JSON Schema */ },
      },
      // ... every tool descriptor
    ],
  }));
}
```

The handler factory pattern separates tool logic from registration:

```typescript
// Pure handler factory — takes clients, returns a handler
type ToolHandler<T = unknown> = (
  clients: { jira?: JiraClient; github?: GitHubClient },
) => (args: T) => Promise<CallToolResult>;

// Example handler
const jiraGetIssuesHandler: ToolHandler<{ key?: string; jql?: string; ... }> =
  (clients) => async (args) => {
    if (args.key) {
      const issue = await clients.jira!.getIssueSlim(args.key);
      return { content: [{ type: 'text', text: JSON.stringify(issue) }] };
    }
    // ... search path with pagination
  };
```

This wiring makes tests straightforward — modules register handler factories, and tests call them with mock clients instead of going through `server.setRequestHandler`:

```typescript
const handler = jiraGetIssuesHandler({ jira: mockJiraClient });
const result = await handler({ key: 'TEST-123' });
expect(result).toMatchSnapshot();
```

### Standard Pagination Response Shape

All list-style tools return a uniform pagination envelope:

```typescript
interface PaginatedResponse<T> {
  items: T[];
  nextPageToken?: string;  // opaque pagination token; absent = no more results
  hasMore: boolean;        // true if there are additional results beyond this batch
}
```

Parameters accepted by every list-style tool:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `cursor` | `string` | — | Opaque pagination token |
| `limit` | `number` | `20` | Items per page (max `100` unless API imposes a lower cap) |

- `total` is NOT part of the generic envelope — it is only added per-tool when the backing API provides it (Jira's `search/jql` does; GitHub Search does not)
- `offset` is dropped entirely; cursors are more stable and the few offset-based APIs can use cursor as a page-number token internally
- `max` is dropped; the LLM can set a low `limit` or stop paginating when it has enough results

---

## Implementation Phases

---

### Phase 1: Foundation — MCP Server Layer

**Goal:** Ship a working MCP server with stdio transport that wraps every existing JiraClient and GitHubClient method as an MCP tool. Resources and prompts are thin wrappers at this stage.

#### MCP SDK Choice

Use `@modelcontextprotocol/sdk` v1.x (stable npm package). This SDK provides:
- `Server` class with tool/resource/prompt registration
- `stdio` and `sse` transport classes
- `CallToolResult`, `ListToolsResult`, `ReadResourceResult` typed response builders
- Built-in error types (`McpError`, `ErrorCode`)

**Tradeoff:** v1.x uses `zod` for schema validation of tool inputs. This is a new dependency but aligns with MCP SDK's first-class support and provides type-safe tool schemas with auto-generated JSON Schema for the LLM.

#### New Files

| File | Purpose |
|------|---------|
| `src/mcp-server.ts` | Main entry point: bootstraps `Server`, imports module registry, creates client instances, injects them via DI, starts transport |
| `src/mcp-config.ts` | MCP-specific config (transport mode, port, log level), wraps `loadConfig()` |
| `src/mcp-health.ts` | `mcp_get_health` tool handler — always registered, reports active integration status |
| `src/integrations/index.ts` | Module registry — exports array of all `IntegrationModule` implementations |
| `src/integrations/jira/index.ts` | Jira module definition + `needsEnv()` |
| `src/integrations/jira/module.ts` | Jira tool/resource/prompt registration functions |
| `src/integrations/github/index.ts` | GitHub module definition + `needsEnv()` |
| `src/integrations/github/module.ts` | GitHub tool/resource/prompt registration functions |

#### Conditional Registration

All tools are registered conditionally based on environment variables:

- `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN` all set → Jira module tools are registered
- `GH_TOKEN` set → GitHub module tools are registered
- Neither → server starts but returns an empty tools list
- The server logs at startup which integration sets are active (e.g., `[mcp] Jira integration: active`, `[mcp] GitHub integration: active`)
- A built-in `mcp_get_health` tool is always registered regardless of env vars

#### Tool Registration (per module)

Each tool maps to one or two existing client methods. All tools return JSON-serialized slim shapes by default. Every list-style tool includes the standard pagination parameters (see Architecture section).

**Jira Module** (registered when JIRA env vars are set):

| Tool Name | Underlying Method(s) | Key Parameters | Pagination | Notes |
|-----------|---------------------|----------------|------------|-------|
| `jira_get_issues` | `getIssueSlim` / `searchSlim` / `searchAllSlim` | `key?: string`, `jql?: string`, `fields?: string[]` | `cursor`, `limit` | Always returns `PaginatedResponse<SlimIssue>`. Pass `key` for a single issue (returns 1-item array with `hasMore: false`), `jql` for search. If both provided, `key` wins. Optional `fields` further restricts returned fields (e.g., `["key","status"]`). |
| `jira_create_issue` | `createIssue` | `projectKey: string`, `issueType: string`, `summary: string`, `description?: string`, `fields?: object` | — | Fields passthrough to Jira |
| `jira_update_issue` | `updateIssue` | `key: string`, `fields: object` | — | Returns nothing on success |
| `jira_transition_issue` | `listTransitions` + `transitionIssue` | `key: string`, `transitionId?: string`, `transitionName?: string`, `comment?: string` | — | Accepts either id or name (lookup in handler); emits early error if neither matches |
| `jira_assign_issue` | `assignIssue` / `assignToMe` | `key: string`, `assignee?: string` (accountId, "me", or "none") | — | Defaults to "me" |
| `jira_add_comment` | `addComment` | `key: string`, `body: string` | — | Plain text → ADF conversion |
| `jira_link_issues` | `linkIssues` + `listIssueLinkTypes` | `inwardKey: string`, `outwardKey: string`, `type: string`, `comment?: string` | — | Type validation in handler (fetch link types on first call, cache) |
| `jira_whoami` | `whoami` | none | — | Returns displayName, emailAddress, accountId |
| `jira_list_projects` | `listProjectsSlim` | none | `cursor`, `limit` | Returns projects accessible to the user. Requires adding `listProjectsSlim` to JiraClient. |
| `jira_get_fields` | `getFieldMetadata` | `projectKey?: string`, `issueType?: string` | — | Field metadata for issue creation. Requires adding `getFieldMetadata` to JiraClient. |
| `jira_search_users` | `searchUsers` | `query: string` | `cursor`, `limit` | Find users by name/email |

**GitHub Module** (registered when GH_TOKEN is set):

| Tool Name | Underlying Method(s) | Key Parameters | Pagination | Notes |
|-----------|---------------------|----------------|------------|-------|
| `github_get_prs` | `searchPrs` / `findPrsForIssueKeys` | `issueKey?: string`, `keys?: string[]`, `state?: string` ("open"\|"closed"\|"all") | `cursor`, `limit` | Polymorphic: pass `issueKey` for single-key search, `keys` for batched lookup. If both provided, `keys` wins. |
| `github_create_pr` | `createPullRequest` | `repo: string`, `title: string`, `head: string`, `base: string`, `body?: string`, `draft?: boolean` | — | Creates a PR from a branch |
| `github_list_branches` | `listBranches` | `repo: string` | `cursor`, `limit` | Lists branches for a repo |

**Built-in (always registered):**

| Tool Name | Underlying Method(s) | Key Parameters | Notes |
|-----------|---------------------|----------------|-------|
| `mcp_get_health` | none (server info) | none | Reports which integrations are active and their status: `{ jira: boolean, github: boolean, confluence: boolean, serverVersion: string }` |

**Tool naming convention:** `{domain}_{verb}_{noun}` — helps LLMs disambiguate on first try (no two tools share the same prefix segment). Note that `{noun}` is plural for list-style tools (e.g., `jira_get_issues`, `github_get_prs`) and singular when the tool returns or acts on a single item (e.g., `jira_create_issue`, `jira_add_comment`).

**Schema design:** Every required parameter appears first in the zod schema. Optional parameters use `.optional()`. Descriptions are concise (1 sentence) to save tokens in tool listings.

#### Resource Registration (per module)

Resources are also registered conditionally — only when the corresponding integration module is active.

**Jira Resources** (conditional on Jira env vars):

| Resource URI | Handler Logic | Returns |
|-------------|---------------|---------|
| `jira://issue/{key}` | Calls `getIssueSlim(key)` | SlimIssue as JSON |
| `jira://search/{jql}` | Calls `searchSlim(jql, { maxResults: 20 })` | SlimIssue[] as JSON |
| `jira://myself` | Calls `whoami()` | JiraUser as JSON |
| `jira://projects` | Calls `listProjectsSlim()` | Slim project list (potentially cached) |

**GitHub Resources** (conditional on GH_TOKEN):

| Resource URI | Handler Logic | Returns |
|-------------|---------------|---------|
| `github://prs/{issueKey}` | Calls `searchPrs(issueKey)` | PrInfo[] as JSON |

**Resource template** URIs use path parameters (`{key}`, `{jql}`). The MCP SDK's resource template mechanism handles parsing. The LLM can "read" an issue by fetching the resource.

#### Prompt Templates (per module)

Prompts are also registered conditionally — only available when their required integration modules are active.

**Jira Prompts** (conditional on Jira env vars):

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `create-issue` | `projectKey`, `issueType`, `summary` (required); `description`, `priority`, `labels` (optional) | Produces a guided issue-creation form with field descriptions and validation hints |
| `triage-issue` | `key` | Fetches the issue + transitions + PRs, then outputs a structured analysis: summary, status, assignee, what's blocking, available transitions, associated PRs |

**Cross-module Prompts** (conditional on both Jira AND GitHub being active):

| Prompt | Arguments | Description |
|--------|-----------|-------------|
| `pr-summary` | `key` (issue key) | Summarizes all open PRs for an issue — repo, number, title, author, review status, link |

**Prompt design principle:** Prompts are **tool composition helpers** — they call tools internally and format the output into a structured message. They do NOT introduce new API calls. Example: `triage-issue` calls `jira_get_issues` + `jira_get_issues` (for transitions) + `github_get_prs` under the hood. Prompts that span modules (like `pr-summary`) only register when all required modules are active.

#### `npm run mcp` Entry Point

Add to `package.json` scripts:

```json
{
  "scripts": {
    "mcp": "node --import tsx src/mcp-server.ts",
    "mcp:prod": "node dist/mcp-server.js",
    "mcp:inspect": "npx @modelcontextprotocol/inspector node --import tsx src/mcp-server.ts"
  }
}
```

- `npm run mcp` — dev mode, uses `tsx` for TypeScript execution (requires tsx ^4.19.x)
- `npm run mcp:prod` — production mode, uses compiled JS output (requires `npm run build` first)
- `npm run mcp:inspect` — launches the MCP inspector for debugging

The MCP server reads transport mode from env `MCP_TRANSPORT` (default `stdio`). When `MCP_TRANSPORT=http`, it starts an HTTP server on `MCP_PORT` (default 3000).

At startup, the server logs which integration sets are active:

```
[mcp] toolkit-mcp starting...
[mcp] Jira integration: active (JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN found)
[mcp] GitHub integration: active (GH_TOKEN found)
[mcp] Confluence integration: inactive (missing CONFLUENCE_BASE_URL)
[mcp] Registered X tools, Y resources, Z prompts
[mcp] Transport: stdio
```

If no integrations are active, the server still starts but logs a warning and registers only the `mcp_get_health` tool.

#### Connection Config for AI IDEs

The plan doc should specify what users put in their MCP client config:

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

**Conditional env vars:** The server inspects env vars at startup. Users can omit `GH_TOKEN` if they don't need GitHub tools, or omit `JIRA_*` if they only need GitHub. Tools are only registered for integrations whose env vars are fully present. The `mcp_get_health` tool reports which integrations are active.

---

### Token Optimization (built into Phase 1)

These principles are baked into the Foundation phase rather than deferred:

#### Conservative Pagination Defaults

- `limit` defaults to **20** — not the API default (Jira defaults to 50, GitHub to 30)
- By default, tools return a single page; the LLM explicitly requests pagination via `cursor`
- Pagination metadata (`hasMore`, `nextPageToken`) is included in every paginated response so the LLM knows whether more results are available
- No tool auto-fetches all pages — the agent must explicitly request pagination

| Rule | Rationale |
|------|-----------|
| Default `limit: 20` on all list tools | Prevents accidental large-result pulls |
| `hasMore` in every response | LLM can decide to paginate rather than being forced to |
| No tool auto-fetches all pages | The agent must explicitly request pagination via `cursor` |

#### Efficient Tool Names and Descriptions

Tool names are structured so the LLM can pick the right tool on first try without reading every description:
- `jira_get_issues` — polymorphic: returns `PaginatedResponse<SlimIssue>` with `key` for one issue or `jql` for search
- `github_get_prs` — polymorphic: single key or batched keys
- Plural nouns (`issues`, `prs`) for list-style tools; singular (`create_issue`, `add_comment`) for scalar operations

Descriptions are exactly 1 sentence, avoiding filler:

| Tool | Description |
|------|-------------|
| `jira_get_issues` | "Fetch one or more Jira issues. Pass `key` for a single issue, or `jql` to search." |
| `jira_create_issue` | "Create a new Jira issue in a project." |
| `jira_update_issue` | "Update fields on an existing Jira issue." |
| `jira_transition_issue` | "Transition a Jira issue to a new status." |
| `jira_add_comment` | "Add a comment to a Jira issue." |
| `github_get_prs` | "Find pull requests for one or more issue keys." |
| `github_create_pr` | "Create a pull request from a branch." |
| `github_list_branches` | "List branches in a GitHub repository." |
| `mcp_get_health` | "Report which integrations are active." |

#### Batching

- `github_get_prs` with `keys: string[]` already batches up to 20 keys into a single search query
- No need for multiple calls when the agent has several keys — prefer the batched form
- Tool descriptions should guide the LLM: "For multiple keys, pass them as an array in `keys` rather than calling this tool repeatedly."

#### Avoid Redundant Data in Responses

- `SlimIssue` already drops `null` fields and empty arrays
- The `fields?: string[]` parameter on `jira_get_issues` further restricts returned fields (e.g., only `key` and `status` for a status-check), saving tokens when the LLM needs only a subset
- Paginated responses include compact metadata (`hasMore`) before items — the LLM can decide to read items based on whether there are results, without parsing the full items array

#### JSON Serialization Efficiency

- Use `JSON.stringify` with no pretty-printing in MCP responses (single-line JSON, no indentation)
- Strip `undefined` values (they're redundant when a field is missing)

---

### Phase 2: New APIs — GitHub Enhancements

**Goal:** Extend the GitHub integration with pagination, configurable repos, PR creation, branch listing, and branch-name PR matching. Each new capability is organized into the existing `src/integrations/github/` module.

---

#### Module: GitHub (`src/integrations/github/`)

Existing `GitHubClient` lives in the library layer. The integration module wraps it with pagination-aware MCP tools and new methods.

##### 3.1 GitHub Pagination (Priority: High)

`searchPrs` and `findPrsForIssueKeys` currently only fetch 1 page (max 100 results per the `per_page` param). The GitHub Search API returns paginated results via the `Link` header.

**What to change (in `github-client.ts`):**

- Extract `Link` header parsing logic (standard `rel="next"`, `rel="last"` pattern)
- Add a private `fetchAllPages(url, params)` method that follows `Link: rel="next"` until exhausted or a `maxPages` cap (default 5)
- Modify `searchPrs` and `findPrsForIssueKeys` to use paginated fetching
- Add a `maxResults?: number` parameter to `searchPrs` to cap total returned PRs

**Tradeoff:** GitHub Search API has a 1000-result cap; pagination stops there anyway.

**Pagination:** The MCP tool `github_get_prs` exposes `cursor` and `limit` parameters per the standard pagination shape.

##### 3.2 Configurable Repo List (Priority: High)

`GH_REPOS` is currently hardcoded as a `const` array in `github-client.ts`:

```typescript
const GH_REPOS = [
  'TransActComm/TravelTracker',
  'TransActComm/Portage-backend',
  'TransActComm/Portage-frontend',
] as const;
```

**What to change:**

- Read `GH_REPOS` from env var `GH_REPOS` (comma-separated list of `owner/name` pairs)
- Keep the hardcoded list as the fallback default for backward compatibility
- Add to `.env.example`
- Optionally: allow a `repos` parameter on MCP tools to override per-call

**Config resolution priority:** explicit parameter > env var > hardcoded default.

##### 3.3 GitHub PR Creation (Priority: Medium)

Add method to `GitHubClient`:

```typescript
async createPullRequest(input: {
  repo: string;       // "owner/name"
  title: string;
  head: string;       // branch name
  base: string;       // target branch (usually "main" or "ops/development")
  body?: string;
  draft?: boolean;
  maintainerCanModify?: boolean;
}): Promise<{ number: number; htmlUrl: string; state: string }>;
```

**API:** `POST /repos/{owner}/{repo}/pulls`

**MCP tool:** `github_create_pr`

**Use case:** An AI agent that has finished coding on a branch can create a PR directly.

##### 3.4 GitHub Branch Listing (Priority: Medium)

Add method to `GitHubClient`:

```typescript
async listBranches(repo: string, opts?: { perPage?: number; page?: number }): Promise<Array<{ name: string; sha: string; protected: boolean }>>;
```

**API:** `GET /repos/{owner}/{repo}/branches`

**MCP tool:** `github_list_branches`

**Pagination:** Supports standard `cursor`, `limit` parameters.

**Use case:** An AI agent checking what branches exist for a repo, or finding the latest branch for a given issue.

##### 3.5 Branch Name PR Matching (Priority: Medium)

**Problem:** The current GitHub search uses `/search/issues`, which indexes PR titles and bodies but does NOT index `head.ref` (branch name). PRs where the issue key only appears in the branch name (e.g., `git checkout -b feature/TRIPS-1267-fix`) are invisible.

**Options considered:**

1. **GitHub GraphQL API** — can query PRs with `headRefName` filter. Tradeoff: adds GraphQL dependency, different auth model.
2. **Git refs endpoint** — `GET /repos/{owner}/{repo}/git/refs/heads` to list branches, then filter by issue key pattern. Tradeoff: expensive for repos with many branches; no direct PR mapping without additional calls.
3. **Dual search** — search issues (title/body) AND search refs (branches). Merge results. Tradeoff: more API calls.
4. **Branch-pattern heuristic** — search for `refs/heads/*TRIPS-NNNN*` via the Git refs API. This is the most targeted approach.

**Recommended approach (Option 4):** Add a new method `searchPrsByBranchName(issueKey)` that:
1. Lists branches via `GET /repos/{owner}/{repo}/git/refs/heads`
2. Filters for branches containing the issue key (case-insensitive)
3. For each matching branch, checks if there's an open PR from that branch via `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}`
4. Merges results with existing `searchPrs` output (deduplicated)

This is a separate method; `searchPrs` stays as-is for the fast path. The MCP tool `github_get_prs` can internally call both and merge, or expose a `searchBranches: boolean` parameter.

---

### Phase 3: New APIs — Jira & Confluence

**Goal:** Extend the Jira client with remaining capabilities and add the Confluence read module. Client methods are added to the library layer alongside their MCP wrappers.

---

#### Module: Jira (`src/integrations/jira/`)

New client capabilities for the Jira integration module.

##### 3.6 Jira User Search (Priority: Medium)

Add method to `JiraClient`:

```typescript
async searchUsers(query: string, opts?: { maxResults?: number }): Promise<Array<{
  accountId: string;
  displayName: string;
  emailAddress?: string;
}>>;
```

**API:** `GET /user/search?query=...`

**MCP tool:** `jira_search_users` (supports standard pagination: `cursor`, `limit`)

**Use case:** Finding an accountId to assign an issue to a specific person.

##### 3.7 Jira Sprint/Board Info (Priority: Low)

If using Jira Software, add:

```typescript
async listBoards(projectKey?: string): Promise<Array<{ id: number; name: string; type: string }>>;
async getActiveSprint(boardId: number): Promise<{ id: number; name: string; state: string; startDate?: string; endDate?: string } | null>;
```

**API:** `GET /agile/1.0/board`, `GET /agile/1.0/board/{id}/sprint?state=active`

**MCP tool:** `jira_get_active_sprint` (supports standard pagination: `cursor`, `limit` for board listing)

**Use case:** Agents working in a Scrum team need to know what sprint they're in.

##### 3.8 Attachment Download (Priority: Low)

Add method to expose `SlimAttachment.content` / `SlimAttachment.thumbnail` as downloadable content:

```typescript
async downloadAttachment(url: string): Promise<Buffer>;
```

**MCP tool:** `jira_download_attachment` — takes attachment URL, returns base64-encoded content with MIME type.

**Use case:** An AI agent that needs to inspect an image or file attached to a Jira ticket.

**Tradeoff:** Binary data in MCP responses is heavy. Only use when the LLM explicitly requests it (not included in slim resource fetches).

---

#### Module: Confluence (`src/integrations/confluence/`)

New integration module — conditional on `CONFLUENCE_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN`.

##### 3.9 Confluence Read Tools (Priority: Medium)

Add a `ConfluenceClient` class:

```typescript
class ConfluenceClient {
  async searchPages(cql: string, opts?: { maxResults?: number; cursor?: string }): Promise<PaginatedResponse<{ id: string; title: string; space: string; url: string }>>;
  async getPage(pageId: string): Promise<{ id: string; title: string; body: string; space: string; version: number }>;
}
```

**API:** `GET /wiki/rest/api/content/search?cql=...`, `GET /wiki/rest/api/content/{id}?expand=body.storage`

**Body format:** The client requests `body.storage` format (HTML) and converts to plain text for the slim response, matching the same ADF-to-text pattern used for Jira comments.

**Auth:** Same BASIC auth as Jira (Confluence Cloud uses the same API token). This works because Jira and Confluence share the same Atlassian organization — if a team uses different orgs for each, this breaks and a separate CONFLUENCE_TOKEN would be needed.

**MCP tool:** `confluence_get_pages` (polymorphic: pass `key` for single page, `cql` for search, with standard pagination)

**MCP resource:** `confluence://page/{id}`

**Dependencies:** No new npm packages (uses existing axios).

**Module registration:** Only registers when `CONFLUENCE_BASE_URL`, `JIRA_EMAIL`, and `JIRA_TOKEN` are all set (reuses Jira auth).

**Use case:** AI agents reading Confluence documentation (architecture docs, runbooks, feature specs) alongside Jira issues.

---

#### Module Template for Future Integrations

Every new integration follows a consistent directory structure and contract:

```
src/integrations/<name>/
  index.ts           — exports the IntegrationModule implementation
  module.ts          — registerTools, registerResources, registerPrompts implementations
  client.ts          — optional: library-layer client class (if not shared)
  module.test.ts     — tests with mocked client (DI pattern)
```

A new integration module is added by:

1. Creating the directory and implementing the `IntegrationModule` interface
2. Adding the client class (or reusing an existing one from the library layer)
3. Importing and registering the module in `src/integrations/index.ts` (the module registry)
4. The main `mcp-server.ts` imports the registry — no changes to the server bootstrap needed beyond adding the import to the registry

---

### Phase 4: dev-workflow Integration

**Goal:** Make the MCP server a hub for common dev workflow operations — not just data access but actionable workflows.

#### 4.1 PR Workflow

Expose a prompt that guides the LLM through the PR lifecycle:

1. `search issue PRs` → `jira_get_issues` (key mode) + `github_get_prs`
2. `check review status` → `github_get_prs` (reviewStatus is already part of PrInfo)
3. `add review comment` → future: GitHub PR review comment API
4. `merge PR` → future: GitHub PR merge API

**Prompt:** `pr-workflow` — guides the LLM step by step.

**Potential tool:** `github_get_pr_details` — fetches a single PR's full details (including review comments, status checks).

#### 4.2 Issue Workflow

`triage-issue` prompt already covers this partially. Extend to:

1. Search issues by JQL
2. Get issue details (slim)
3. List available transitions
4. Transition issue
5. Assign
6. Comment

**Prompt:** `issue-workflow` — "I want to move issue X from 'In Progress' to 'Ready for Code Review' and assign it to Y."

#### 4.3 Cross-Reference Dashboard

Show what's happening across the project:

- Issues in "In Progress" with assignee
- Associated open PRs per issue
- Review status per PR
- Recently merged PRs

**MCP tool:** `workflow_status` — composite tool that calls:
1. `jira_get_issues` (jql mode) for "In Progress" and "Ready For Code Review" issues
2. `github_get_prs` (keys mode) on the results
3. Returns a consolidated view

**Tradeoff:** This is a potentially expensive operation. Cap at 20 issues. The LLM can request specific JQL rather than getting everything.

#### 4.4 Release Tracking

List recent PRs merged to specific branches, cross-referenced with fixed issues:

**MCP tool:** `workflow_recent_releases` — parameters: `repo`, `branch`, `since` (ISO date), `maxResults`.

Implementation: Search GitHub for merged PRs to a branch, extract issue keys from PR titles/bodies, fetch Jira issue summaries.

#### 4.5 Partial-Failure Error Recovery for Composite Tools

Composite tools that orchestrate across multiple modules must handle partial failures gracefully rather than failing the entire operation:

- **Response shape:** Composite tools return `{ data: {...}, errors: Record<string, string> }`. If Jira succeeds but GitHub fails (rate limited, timeout), the response contains Jira results plus a `{ github: "rate limited — retry after X seconds" }` annotation.
- **Internal timeout per API leg:** Each external call within a composite tool has its own timeout. If GitHub takes too long, that leg fails independently rather than blocking the entire response.
- **No cascading failures:** A failure in one module's leg never prevents other legs from executing. The LLM receives partial results with an error annotation and can decide whether to retry.

---

### Phase 5: Quality & Testing

**Goal:** Comprehensive test coverage for the library layer (currently gaping holes) and the new MCP layer. Every tool handler is testable via dependency injection — no real credentials or network calls needed.

#### Dependency Injection Pattern for MCP Tools

All tool handlers accept their dependencies by injection. This is the central testing strategy:

```typescript
// Define a tool handler as a factory that takes clients, returns a handler
type ToolHandler<T = unknown> = (
  clients: { jira?: JiraClient; github?: GitHubClient; confluence?: ConfluenceClient },
) => (args: T) => Promise<CallToolResult>;

// Example: jira_get_issues handler
const jiraGetIssuesHandler: ToolHandler<{
  key?: string;
  jql?: string;
  limit?: number;
  cursor?: string;
  fields?: string[];
}> = (clients) => async (args) => {
  // clients.jira is injected — never constructed here
  if (args.key) {
    const issue = await clients.jira!.getIssueSlim(args.key);
    // Always return PaginatedResponse — single item becomes a one-item array
    return { content: [{ type: 'text', text: JSON.stringify({
      items: [issue], hasMore: false, nextPageToken: undefined
    }) }] };
  }
  // ... search path with pagination
};

// Registration uses the factory, passing real clients:
registerTools(server, { jira, github });

// Tests call the factory with mock clients:
const handler = jiraGetIssuesHandler({ jira: mockJiraClient });
const result = await handler({ key: 'TEST-123' });
expect(result).toMatchSnapshot();
```

This pattern applies to:
- **Tool handlers** — receive client instances, return `CallToolResult`
- **Resource handlers** — receive client instances, return `ReadResourceResult`
- **Prompt handlers** — receive client instances, return `GetPromptResult`
- **Composite/aggregate tools** — receive multiple client instances, orchestrate across them

**The MCP server** (`mcp-server.ts`) creates client instances once at startup, passes them to each module's `registerTools(server, clients)`, and never touches client construction again.

#### Current Coverage

#### 5.1 JiraClient Tests

Add `src/jira-client.test.ts`:

- **Constructor & config** — throws on missing env vars, creates axios with correct baseURL/auth
- **Retry interceptor** — retries on 429 with Retry-After, retries on 5xx, does not retry on 400/404, stops after MAX_RETRIES
- **`whoami`** — happy path, error propagation
- **`getIssue`** — happy path, field projection
- **`getIssueSlim`** — happy path, auto-fetches truncated comments, handles missing fields
- **`getComments`** — paginated fetch, empty comments
- **`search` / `searchSlim`** — one page, nextPageToken, slim mapping
- **`searchAll` / `searchAllSlim`** — multi-page, max cap
- **`createIssue`** — minimal fields, with description, with extra fields
- **`updateIssue`** — happy path
- **`addComment`** — ADF conversion, response parsing
- **`listTransitions`** — happy path
- **`transitionIssue`** — with/without comment, with fields
- **`assignIssue` / `assignToMe`** — happy path, whoami delegation
- **`listIssueLinkTypes`** — happy path
- **`linkIssues`** — with/without comment
- **`describeError`** — error formatting coverage

**Strategy:** Mock `axios.create` exactly like `github-client.test.ts` does. Return controlled responses from the mock axios instance. Do NOT make real API calls.

#### 5.2 slim.ts Tests

Add `src/slim.test.ts`:

- **`adfToText`** — plain paragraph, nested content, heading, bullet list, ordered list, inline code, hardBreak, empty content, null input, mixed content
- **`toSlimIssue`** — maps all fields correctly, handles missing/null fields, handles empty arrays, reverse-comment ordering
- **`toSlimComment`** — maps fields, handles anonymous comments, handles null body
- **`toSlimAttachment`** — maps fields, handles null author/thumbnail
- **`DEV_FIELDS`** — expected field names present

No mocking needed — pure data transformation tests.

#### 5.3 MCP Server Integration Tests

Add `src/mcp-server.test.ts` and per-module test files (e.g., `src/integrations/jira/module.test.ts`):

- **Module discovery** — all modules discovered from the registry
- **Conditional registration** — modules only register when their `needsEnv()` returns true
- **Tool registration** — all tools registered with correct names per integration module
- **Resource registration** — all resources/templates registered per module
- **Prompt registration** — all prompts registered, cross-module prompts only when dependencies are met
- **Tool execution via DI** — call each tool handler factory with mock clients, verify output shape
- **Pagination responses** — handlers return the standard `PaginatedResponse` shape with `hasMore`, `nextPageToken`
- **Error handling** — client throws → MCP error response
- **Parameter validation** — missing required params → validation error
- **Polymorphic dispatch** — `jira_get_issues` with `key` returns one-item `PaginatedResponse` (`hasMore: false`); with `jql` returns `PaginatedResponse`; with both, `key` wins
- **`mcp_get_health` tool** — returns correct active integration status based on mock env

**DI Strategy:** Each module's `registerTools` function receives client instances. Tests create mock clients (using vitest mocking or hand-rolled stubs that implement the relevant interface) and pass them to the module. This avoids needing real credentials in tests.

```typescript
// Example: testing the GitHub module with DI
const mockGitHubClient = {
  searchPrs: vi.fn().mockResolvedValue([mockPrInfo]),
  searchPrsByBranchName: vi.fn().mockResolvedValue([]),
};

const module = new GitHubModule();
const server = new Server(...);

// Call the handler factory directly (not via server.setRequestHandler)
const handler = githubGetPrsHandler({ github: mockGitHubClient });
const result = await handler({ issueKey: 'TRIPS-123' });
expect(mockGitHubClient.searchPrs).toHaveBeenCalledWith('TRIPS-123', expect.any(Object));
expect(result).toMatchSnapshot();
```

#### 5.4 GitHubClient Test Additions

Current tests mock `axios.create` and verify behavior. Add:

- Pagination test helpers (for Phase 2 GitHub pagination changes)
- `createPullRequest` tests (mocked)
- `listBranches` tests (mocked)

#### 5.5 Config Tests

Add `src/config.test.ts`:

- `loadConfig` with all env vars set
- `loadConfig` throws for missing `JIRA_BASE_URL`
- `loadConfig` throws for missing `JIRA_EMAIL`
- `loadConfig` throws for missing `JIRA_TOKEN`
- `loadConfig` strips trailing slashes from baseUrl

#### 5.6 Vitest Config Update

Extend `vitest.config.ts` to include new test files and add coverage for `jira-client.ts`, `slim.ts`, `config.ts`, and MCP files:

```typescript
coverage: {
  provider: 'v8',
  include: [
    'src/github-client.ts',
    'src/jira-client.ts',
    'src/slim.ts',
    'src/config.ts',
    'src/mcp-server.ts',
    'src/mcp-config.ts',
    'src/mcp-health.ts',
    'src/integrations/**/*.ts',
  ],
},
```

#### 5.7 Retry Interceptor Testing

The retry interceptor is installed via `axios.interceptors.response.use()`. To test it without refactoring:
- Mock the interceptor registration (capture the error handler function)
- Call it with various error scenarios
- Verify it returns the retry promise or throws based on error type

The existing `github-client.test.ts` mocks the interceptor but doesn't test its logic. Add dedicated retry tests.

---

## File Changes

### New Files — Integrations (per module)

| File | Phase | Purpose |
|------|-------|---------|
| `src/integrations/index.ts` | 1 | Module registry — imports all modules, exports array for discovery |
| `src/integrations/jira/index.ts` | 1 | Jira `IntegrationModule` implementation, `needsEnv()` check |
| `src/integrations/jira/module.ts` | 1 | Jira tool/resource/prompt registrations with injected clients |
| `src/integrations/jira/module.test.ts` | 5 | Jira module tests with DI (mock JiraClient) |
| `src/integrations/github/index.ts` | 1 | GitHub `IntegrationModule` implementation, `needsEnv()` check |
| `src/integrations/github/module.ts` | 1 | GitHub tool/resource/prompt registrations with injected clients |
| `src/integrations/github/module.test.ts` | 5 | GitHub module tests with DI (mock GitHubClient) |
| `src/integrations/confluence/index.ts` | 3 | Confluence `IntegrationModule` implementation, `needsEnv()` check |
| `src/integrations/confluence/module.ts` | 3 | Confluence tool/resource/prompt registrations with injected clients |
| `src/integrations/confluence/module.test.ts` | 5 | Confluence module tests with DI (mock ConfluenceClient) |

### New Files — Core MCP

| File | Phase | Purpose |
|------|-------|---------|
| `src/mcp-server.ts` | 1 | MCP server entry: bootstrap, transport, module registry import, DI wiring |
| `src/mcp-config.ts` | 1 | MCP-specific configuration |
| `src/mcp-health.ts` | 1 | `mcp_get_health` tool handler — reports active integrations |

### New Files — Tests (Library Layer)

| File | Phase | Purpose |
|------|-------|---------|
| `src/jira-client.test.ts` | 5 | JiraClient test suite |
| `src/slim.test.ts` | 5 | slim.ts transformation tests |
| `src/config.test.ts` | 5 | Config loading tests |
| `src/mcp-server.test.ts` | 5 | MCP server integration tests (module discovery, conditional registration, health tool) |

### Modified Files

| File | Phase | What Changes |
|------|-------|--------------|
| `package.json` | 1 | Add `mcp` and `mcp:inspect` scripts; add `@modelcontextprotocol/sdk` and `zod` deps |
| `tsconfig.json` | 1 | Exclude new test files from compilation (already uses `src/**/*.test.ts` pattern — verify it covers new tests in nested directories) |
| `vitest.config.ts` | 5 | Add new source files (including `src/integrations/**/*.ts`) to coverage include list |
| `src/github-client.ts` | 2 | Add `GH_REPOS` env var support; add `fetchAllPages` pagination; add `createPullRequest`, `listBranches`, `searchPrsByBranchName` methods |
| `src/github-client.test.ts` | 2, 5 | Add tests for new methods and pagination |
| `src/index.ts` | 1, 2, 3 | Re-export integration module types and new client methods |
| `.env.example` | 1, 2 | Add `MCP_TRANSPORT`, `MCP_PORT`, `GH_REPOS` docs; note conditional registration behavior |

### Unchanged / Out of Scope (Initial Implementation)

| File | Rationale |
|------|-----------|
| `jira-cli/` (external dep) | Library layer is a separate npm dependency (`"jira-cli": "file:../jira-cli"`). Frozen during Phase 1; new methods added in Phase 2+ (no existing signatures changed, additions only). |
| `src/slim.ts` | Library layer frozen during Phase 1; no changes expected |
| `src/config.ts` | Not modified directly; `mcp-config.ts` wraps it for MCP-specific settings |
| `../jira-cli/src/cli.ts` | External library; CLI continues to work independently |
| `../jira-cli/src/error-helpers.test.ts` | External library; already adequate coverage |
| `TravelTracker/`, `Portage-backend/`, `Portage-frontend/` | Not touched by this work |
| `migration/` | Not touched by this work |

---

## Future Ideas (Out of Scope for Initial Implementation)

- **Multi-user HTTP server with OAuth** — The single-user stdio approach fits the coding-agent use case. Multi-user (OAuth 2.0, Streamable HTTP) is only needed for team-wide deployment and adds significant complexity.

- **Additional integrations** — The module architecture makes adding Sentry, PagerDuty, Slack, or GitLab straightforward; each becomes a directory under `src/integrations/<name>/` implementing the same `IntegrationModule` interface. The pattern is proven with Jira, GitHub, and Confluence before expanding.

---

## Existing Ecosystem Context

### sooperset/mcp-atlassian

This is the dominant open-source MCP server for Atlassian (5.4k stars, 72 tools, Python, active development). It covers both Jira and Confluence with a broad tool surface.

**How we differ:**

| Dimension | sooperset/mcp-atlassian | toolkit-mcp |
|-----------|----------------------|------------------------|
| Language | Python | TypeScript (matching our stack) |
| Focus | General Atlassian | TransAct-specific dev workflow + GitHub + extensible modules |
| Slim shapes | No | Yes — core design principle |
| GitHub integration | No | Yes — PR search, creation, status |
| CLI tool | No | Yes — continues working |
| Dev workflow prompts | No | Yes — triage, PR summary, release tracking |
| Custom fields | Generic | TransAct-specific field metadata |
| Module system | No | Yes — `IntegrationModule` interface for any tool |

**Strategic decision:** We are NOT competing with sooperset. Our MCP server is purpose-built for the TransAct monorepo's specific workflow. It integrates Jira + GitHub in ways that a general Atlassian MCP cannot. Over time, it may absorb Confluence read capability, but the primary value is the **Jira ↔ GitHub cross-reference** that no existing MCP server provides.

### Atlassian Official MCP

Atlassian announced an official MCP server in late 2025. As of June 2026, it exists as a closed beta. It likely covers basic Jira/Confluence CRUD.

**Risk:** If Atlassian's official MCP server becomes fully open and covers our use cases, we might reconsider. However:
1. It will not integrate GitHub (our core differentiator)
2. It will not understand TransAct-specific fields, workflows, or project conventions
3. It will not have slim shapes or token optimization
4. Our CLI layer is independent of MCP and remains useful regardless

**Mitigation:** The module architecture already isolates each integration. If we ever want to delegate Jira CRUD to Atlassian's MCP, only `src/integrations/jira/module.ts` needs refactoring — the rest of the server is unaffected. This is unlikely given our token optimization requirements, but the module boundary makes the decision reversible.

### MCP Protocol Maturity

MCP is still evolving (protocol version 2025-03-26 as of early 2026). Key watch items:
- **Streamable HTTP** is experimental in v1.x — stable transport may change
- **Resource subscriptions** are not universally supported by clients
- **Progress notifications** are optional but useful for long-running operations

**Recommendation:** Pin `@modelcontextprotocol/sdk` to a specific minor version. Use stdio transport for initial release (widest client support). Add Streamable HTTP when the spec stabilizes.

---

## Package.json Dependency Changes

### New Dependencies (Phase 1)

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "zod": "^3.23.x"
  }
}
```

`zod` is a transitive dependency of the MCP SDK but should be listed explicitly since we use it for tool input schemas.

### Dev Dependencies (Phase 5)

No new dev dependencies — vitest is already configured for TypeScript testing.

---

## Rollout Strategy

### Phase 1 (MCP Foundation + Token Optimization) — Week 1-2
- Build module infrastructure: `IntegrationModule` interface, module registry, DI wiring
- Ship `src/integrations/jira/` and `src/integrations/github/` modules with conditional registration
- Polymorphic `jira_get_issues` (key + jql, always returns `PaginatedResponse<SlimIssue>`), `github_get_prs` (issueKey + keys)
- Simplified pagination envelope: `items`, `nextPageToken`, `hasMore`; `cursor` + `limit` params only
- `mcp_get_health` tool, startup logging
- `fields?: string[]` parameter on `jira_get_issues` for field-level control
- Jira project listing (`jira_list_projects`) and field metadata (`jira_get_fields`) tools
- Slim-by-default, conservative pagination defaults (`limit: 20`, no auto-fetch)
- 3 resources, 3 prompts (cross-module prompts conditional on both modules)
- stdio transport only
- Verify with `npx @modelcontextprotocol/inspector`

### Phase 2 (GitHub Enhancements) — Week 2-3
- **GitHub module** — pagination (high), configurable repos (high), PR creation (medium), branch listing (medium), branch-name PR matching (medium)
- Each follows the `IntegrationModule` contract with conditional registration and pagination

### Phase 3 (Jira & Confluence) — Week 3-5
- **Jira module** — user search (medium), sprint/board info (low), attachment download (low)
- **Confluence module** — new integration: `confluence_get_pages` (medium), `confluence://page/{id}` resource
- Each follows the `IntegrationModule` contract with conditional registration and pagination

### Phase 4 (Dev Workflow) — Week 5-6
- `workflow_status` composite tool (orchestrates across modules)
- `workflow_recent_releases` tool
- Extended prompts: `pr-workflow`, `issue-workflow`

### Phase 5 (Quality) — Ongoing
- Library layer tests: JiraClient (gating for Phase 1 — must have before shipping), slim.ts, config.ts
- Module tests via DI pattern: per-module `module.test.ts` with mock clients
- MCP server integration tests: module discovery, conditional registration, health reporting
- Pagination response shape validation
- Retry interceptor tests

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MCP SDK v1 API changes (pre-1.0) | Medium | High | Pin exact version; follow semver |
| LLM chooses wrong tool due to naming collision | Low | Medium | Distinct prefix per domain (`jira_`, `github_`, `confluence_`); polymorphic tools reduce total surface area |
| LLM struggles with polymorphic `jira_get_issues` return type (PaginatedResponse with one-item array vs expecting bare object) | Medium | Medium | Always returns `PaginatedResponse<SlimIssue>` — consistent shape regardless of input. Clear tool description and input examples. |
| Polymorphic return type confusion (PaginatedResponse wrapping) | Medium | Medium | Mitigated by always-return-PaginatedResponse fix. LLM always gets `{ items, nextPageToken, hasMore }`. Test with LLM interaction scenarios. |
| Token costs still too high despite slim shapes | Medium | Medium | `fields?: string[]` subset parameter; pagination metadata before items; monitor response sizes |
| `loadConfig()` throws on missing Jira env vars | Low | High | `mcp-config.ts` wraps `loadConfig()` in try/catch; bootstrap reads `process.env` directly for conditional module checks before creating clients. Was High risk before this fix. |
| GitHub API rate limiting | Medium | Medium | Retry with backoff already implemented; document limits |
| Confluence API differences vs Jira | Medium | Low | Separate client class, same auth pattern |
| Module system too abstract for 2 modules (YAGNI violation) | Medium | Low | Only two modules at launch; interface is lightweight (3 methods); if unnecessary, inline into `mcp-server.ts` |
| Existing CLI users broken by refactors | Low | High | Library layer frozen during Phase 1 buildout; Phase 2+ library additions are additive (new methods, no signature changes) |
