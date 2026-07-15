# toolkit-mcp

**Dev Workflow MCP Hub** — bridges AI coding agents with Jira, GitHub, and more via the [Model Context Protocol](https://modelcontextprotocol.io).

An MCP server that exposes developer toolchain operations (Jira issue management, GitHub PR search, and more) as MCP tools, resources, and prompts for AI coding agents. AI IDEs and coding assistants auto-discover and use these tools through the MCP protocol — no manual CLI commands or context-switching required.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                 MCP Transport Layer (stdio)           │
│  ┌─────────────────────────────────────────────────┐ │
│  │                 MCP Server                       │ │
│  │               (central dispatch)                 │ │
│  └──────┬─────────────────────────────┬────────────┘ │
│         │                             │               │
│  ┌──────┴──────┐    ┌─────────┴──────────┐   ┌─────────┴──────────┐   │
│  │  Jira Module │    │  GitHub Module     │   │  Figma Module      │   │
│  │  8 tools     │    │  11 tools          │   │  8 tools           │   │
│  │  3 resources │    │  1 resource        │   │                    │   │
│  │  2 prompts   │    │                    │   │                    │   │
│  └──────┬──────┘    └─────────┬──────────┘   └─────────┬──────────┘   │
│         │                             │               │
│  ┌──────┴─────────────────────────────┴──────────┐   │
│  │       Service Layer: src/services/               │   │
│  │  JiraClient │ GitHubClient │ slim │ config        │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

The server is organized as a **module-based integration hub**. Each external tool (Jira, GitHub, etc.) is a self-contained integration module that registers its capabilities only when its required environment variables are present. The **built-in `mcp_get_health` tool** is always registered.

For the full architecture breakdown, see [`docs/plans/01-jira-cli-mcp-server.md`](docs/plans/01-jira-cli-mcp-server.md).

---

## Quick Start

```bash
cd toolkit-mcp
cp .env.example .env
npm install
npm run mcp              # start the MCP server (stdio)
```

The server starts with stdio transport, ready for MCP client connections. Tools are conditionally registered based on your `.env` values — see [Configuration](#configuration).

---

## Configuration

All variables are optional — tools only register if their required env vars are present.

| Variable | Integration | Required for |
|---|---|---|
| `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN` | Jira | All Jira tools, resources, and prompts |
| `GH_TOKEN` | GitHub | All 11 GitHub tools and `github://prs/{issueKey}` resource |
| `GH_REPOS` | GitHub | Comma-separated repo list for GitHub searches (default: `TransActComm/TravelTracker,TransActComm/Portage-backend,TransActComm/Portage-frontend`) |
| `FIGMA_TOKEN` | Figma | All Figma tools |
| `JENKINS_URL` + `JENKINS_USER` + `JENKINS_TOKEN` | Jenkins | All Jenkins tools (API token preferred over a password) |
| `MCP_TRANSPORT` | Server | Transport mode: `stdio` (default) or `http` |
| `MCP_PORT` | Server | HTTP port (default `3000`, only used for `http` transport) |
| `MCP_LOG_LEVEL` | Server | Log verbosity: `silent`, `info` (default), or `debug` |

Full `.env.example` in the project root. If no integration env vars are set, the server starts with only the `mcp_get_health` tool — graceful degradation.

---

## Tools

Tools are grouped by integration; all are conditional except the built-in `mcp_get_health`, which is always registered.

### Jira Tools (registered when `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN` are set)

| Tool | Description | Key Parameters |
|---|---|---|
| `jira_whoami` | Return the authenticated Jira user profile. | *(none)* |
| `jira_get_issues` | Fetch one or more Jira issues. Pass `key` for a single issue, or `jql` to search. | `key`, `jql`, `limit`, `cursor`, `fields` |
| `jira_create_issue` | Create a new Jira issue in a project. | `projectKey`, `issueType`, `summary`, `description`, `fields` |
| `jira_update_issue` | Update fields on an existing Jira issue. | `key`, `fields` |
| `jira_transition_issue` | Transition a Jira issue to a new status. | `key`, `transitionId` or `transitionName`, `comment` |
| `jira_assign_issue` | Assign a Jira issue to a user or unassign it. | `key`, `assignee` (accountId, "me", or "none") |
| `jira_add_comment` | Add a comment to a Jira issue. | `key`, `body` |
| `jira_update_comment` | Update an existing comment on a Jira issue. | `key`, `commentId`, `body` |
| `jira_link_issues` | Link two Jira issues together. | `inwardKey`, `outwardKey`, `type`, `comment` |

### GitHub Tools (registered when `GH_TOKEN` is set)

| Tool | Description | Key Parameters |
|---|---|---|
| `github_get_prs` | Find pull requests for one or more issue keys. Supports title/body search and optional branch-name matching. | `issueKey`, `keys`, `state`, `limit`, `cursor`, `searchBranches` |
| `github_create_pr` | Create a pull request on GitHub. | `repo`, `title`, `head`, `base`, `body`, `draft` |
| `github_add_pr_comment` | Add an issue-level comment to a pull request. | `repo`, `prNumber`, `body` |
| `github_get_pr_comments` | List issue-level (conversation) comments on a pull request. | `repo`, `prNumber`, `limit`, `cursor` |
| `github_update_pr_comment` | Update an existing issue-level comment on a pull request by comment ID. | `repo`, `commentId`, `body` |
| `github_list_branches` | List branches for a repository. | `repo`, `limit`, `cursor` |
| `github_get_pr_details` | Get full PR details (body, files changed, additions/deletions, mergeable state, base/head branches) by repo + PR number. | `repo`, `prNumber` |
| `github_get_pr_reviews` | Get PR review comments and review thread summaries. | `repo`, `prNumber` |
| `github_get_pr_checks` | Get PR status check / CI results (check-runs for the latest commit on the PR). | `repo`, `prNumber` |
| `github_update_pr` | Update an existing pull request (title, body, state, base branch, or maintainer settings). | `repo`, `prNumber`, `title`, `body`, `state`, `base`, `maintainerCanModify` |
| `github_search_prs` | Flexible PR search by author, repo, state, or free-text query. Provide at least one of `query`, `author`, or `repo`. | `query`, `author`, `repo`, `state`, `limit`, `cursor` |

### Figma Tools (registered when `FIGMA_TOKEN` is set)

| Tool | Description | Key Parameters |
|---|---|---|
| `figma_get_me` | Return the authenticated Figma user profile. | *(none)* |
| `figma_get_file` | Get a Figma file overview (name, pages, last modified). | `fileKey` |
| `figma_get_nodes` | Inspect specific nodes/design elements by ID. | `fileKey`, `ids` |
| `figma_get_images` | Export frames as PNG/SVG/PDF image URLs. | `fileKey`, `ids`, `format`, `scale` |
| `figma_get_comments` | Read design comments on a file. | `fileKey` |
| `figma_get_styles` | List colors, text styles, and effects. | `fileKey` |
| `figma_get_variables` | List design tokens and variable collections. | `fileKey` |
| `figma_get_versions` | List version history for a file. | `fileKey` |

### Jenkins Tools (registered when `JENKINS_URL` + `JENKINS_USER` + `JENKINS_TOKEN` are set)

Read-only. All list tools return the paginated response shape (`items`, `nextPageToken`, `hasMore`); pass the returned `nextPageToken` back as `cursor` for the next page.

| Tool | Description | Key Parameters |
|---|---|---|
| `jenkins_get_jobs` | List Jenkins jobs with their current build status. | `limit`, `cursor` |
| `jenkins_get_builds` | List recent builds for a job (newest first), paginated. | `job`, `limit`, `cursor` |
| `jenkins_get_build` | Get details for a single build; omit `buildNumber` for the most recent. | `job`, `buildNumber` |
| `jenkins_get_console` | Get a build console log, paginated by line; omit `buildNumber` for the most recent. | `job`, `buildNumber`, `limit`, `cursor` |
| `jenkins_healthcheck` | Report whether the last build of each requested job succeeded; omit `jobs` to check all visible jobs. | `jobs` |

### Built-in (always registered)

| Tool | Description | Key Parameters |
|---|---|---|
| `mcp_get_health` | Report which integrations are active. | *(none)* |

### Paginated Response Shape

All list-style tools return a uniform envelope:

```json
{
  "items": [],
  "nextPageToken": "opaque-cursor-or-null",
  "hasMore": true
}
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `cursor` | string | — | Opaque pagination token from a previous response |
| `limit` | number | 20 | Items per page (max 100) |

- `jira_get_issues` with `key` always returns a one-item `PaginatedResponse` with `hasMore: false` — consistent shape regardless of input mode.
- No tool auto-fetches all pages; the agent must explicitly paginate via `cursor`.

---

## Resources

4 resources total (all conditional).

| URI | Module | Description | Returns |
|---|---|---|---|
| `jira://issue/{key}` | Jira | Single Jira issue by key | `SlimIssue` as JSON |
| `jira://search/{jql}` | Jira | Jira search results by JQL query (URI-encoded) | `SlimIssue[]` as JSON (max 20) |
| `jira://myself` | Jira | Current authenticated Jira user profile | Jira user as JSON |
| `github://prs/{issueKey}` | GitHub | Pull requests for an issue key | `PrInfo[]` as JSON |

JQL in `jira://search/{jql}` is URI-encoded (e.g., `jira://search/project%20%3D%20TRIPS`). Restricted keywords (DELETE, UPDATE, CREATE, INSERT, DROP, ALTER, EXEC, ADMIN) are rejected for safety.

---

## Prompts

2 prompts total (both conditional on Jira env vars).

| Prompt | Arguments | Description |
|---|---|---|
| `create-issue` | `projectKey`, `issueType`, `summary` (required); `description`, `priority`, `labels` (optional) | Produces a guided issue-creation message prompting the agent to call `jira_create_issue`. |
| `triage-issue` | `key` | Fetches the issue + available transitions + comments, returns a structured analysis: summary, status, assignee, priority, description, available transitions, comment history. |

---

## Conditional Registration Behavior

- **Jira module** — registered only if `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_TOKEN` are all set.
- **GitHub module** — registered only if `GH_TOKEN` is set.
- **Figma module** — registered only if `FIGMA_TOKEN` is set.
- **Jenkins module** — registered only if `JENKINS_URL`, `JENKINS_USER`, and `JENKINS_TOKEN` are all set.
- **Fallback** — if no env vars are set, the server starts with only `mcp_get_health`. No crashes.
- The server logs active integrations at startup: `[mcp] Jira integration: active`.

---

## Testing

335 tests across 17 test files using **vitest**:

```bash
npm run test                 # Run all tests
npx vitest path/to/file.test.ts   # Single test file
```

All tool handlers are testable via **dependency injection** — mock clients are passed to handler factories, no real credentials needed.

---

## Scripts

| Script | Description |
|---|---|
| `npm run mcp` | Dev mode — `tsx` TypeScript execution, stdio transport (default) |
| `npm run mcp:prod` | Production mode — compiled JS (`npm run build` first) |
| `npm run mcp:inspect` | Launch MCP inspector for debugging |
| `npm run build` | TypeScript compilation (`tsc`) |
| `npm run typecheck` | TypeScript type-check only (`tsc --noEmit`) |
| `npm run test` | Run all tests (vitest) |
| `npm run test:watch` | Vitest watch mode |

---

## MCP Client Configuration (AI IDEs)

### OpenCode / Claude Desktop

```json
{
  "mcpServers": {
    "toolkit-mcp": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/toolkit-mcp/src/mcp-server.ts"],
      "env": {
        "JIRA_BASE_URL": "https://pathwise.atlassian.net",
        "JIRA_EMAIL": "you@pathwisek12.com",
        "JIRA_TOKEN": "<atlassian-api-token>",
        "GH_TOKEN": "<github-token>"
      }
    }
  }
}
```

### VS Code (Cline, Continue, etc.)

```json
{
  "mcpServers": {
    "toolkit-mcp": {
      "command": "node",
      "args": ["--import", "tsx", "/path/to/toolkit-mcp/src/mcp-server.ts"],
      "env": {
        "JIRA_BASE_URL": "https://pathwise.atlassian.net",
        "JIRA_EMAIL": "you@pathwisek12.com",
        "JIRA_TOKEN": "<atlassian-api-token>",
        "GH_TOKEN": "<github-token>"
      }
    }
  }
}
```

**Note:** Omit env vars for integrations you don't need (e.g., skip `GH_TOKEN` if you only use Jira). Tools are only registered for integrations whose env vars are present.

---

## Project Layout

```
src/
├── mcp-server.ts              # Entry: bootstrap, transport, central dispatch
├── mcp-config.ts              # MCP-specific config (transport, port, log level)
├── mcp-health.ts              # mcp_get_health tool handler
├── services/
│   ├── index.ts               # Barrel — re-exports all service classes/types
│   ├── config.ts              # loadConfig() + dotenv (shared by Jira/GitHub)
│   ├── slim.ts                # SlimIssue, toSlimIssue, adfToText
│   ├── jira/
│   │   └── jira-client.ts     # JiraClient class
│   └── github/
│       └── github-client.ts   # GitHubClient class
├── integrations/
│   ├── index.ts               # Module registry + IntegrationModule interface
│   ├── helpers.ts             # PaginatedResponse helper, zodToJsonSchema
│   ├── jira/
│   │   ├── index.ts           # JiraModule: needsEnv, createToolHandlers, resources, prompts
│   │   └── module.ts          # Jira tool handlers, Zod schemas, descriptors
│   └── github/
│       ├── index.ts           # GitHubModule: needsEnv, createToolHandlers, resources
│       └── module.ts          # GitHub tool handlers, Zod schemas, descriptors

---

## Dependencies

- **@modelcontextprotocol/sdk** — MCP protocol implementation (server, transport, types).
- **zod** — Schema validation for tool input parameters.
- **axios** — HTTP client for Jira and GitHub API calls.
- **dotenv** — Environment variable loading from `.env`.

> **Note:** The `jira-cli` library has been absorbed into `src/services/` as an internal service layer. No external dependency is needed — JiraClient, GitHubClient, and their utilities live directly in the toolkit-mcp codebase.

---

## Reference

- **Architecture plan:** [`docs/plans/01-jira-cli-mcp-server.md`](docs/plans/01-jira-cli-mcp-server.md) — full implementation plan covering all phases.
- **Architecture review:** [`docs/code-review/jira-cli-mcp-server-plan-review.md`](docs/code-review/jira-cli-mcp-server-plan-review.md) — 18 findings addressed.
- **Phase 1 review:** [`docs/code-review/phase1-mcp-implementation-review.md`](docs/code-review/phase1-mcp-implementation-review.md).
- **Agentic conventions:** `/ezat/AGENTS.md` — monorepo-level workflow, build/lint/test commands.
