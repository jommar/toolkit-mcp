# Changelog

All notable changes to the toolkit-mcp project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Jenkins integration** (read-only): 5 new MCP tools, registered only when `JENKINS_URL` + `JENKINS_USER` + `JENKINS_TOKEN` are set.
  - `jenkins_get_jobs` — list jobs with current build status (paginated).
  - `jenkins_get_builds` — recent build history for a job, newest first (paginated).
  - `jenkins_get_build` — details for a single build (defaults to the last build).
  - `jenkins_get_console` — build console log, paginated by line for token economy (defaults to the last build).
  - `jenkins_healthcheck` — aggregate rollup of whether each job's last build succeeded; checks all visible jobs by default, or a `jobs` subset. In-progress builds don't fail the check; unknown job names are reported, not thrown.
- **`JenkinsClient`** (`src/services/jenkins/jenkins-client.ts`) — minimal read-only client over the Jenkins REST API. HTTP Basic auth (`JENKINS_USER` / `JENKINS_TOKEN`, API token preferred), transient-failure retry with backoff, and `describeJenkinsError`. New service types: `JenkinsJob`, `JenkinsBuild`, `JenkinsBuildDetail`, `JenkinsConsolePage`.
- **GitHub: update PR tool** (`github_update_pr`) — Update an existing pull request's title, body, state, base branch, or maintainer settings via `PATCH /repos/{owner}/{repo}/pulls/{number}`. Parameters: `repo`, `prNumber`, `title`, `body`, `state`, `base`, `maintainerCanModify`.
- **`GitHubClient.updatePullRequest()`** — Calls `PATCH /repos/{owner}/{repo}/pulls/{number}` with a partial update object. Returns `PullRequestDetail`. Validates that at least one update field is provided.
- **GitHub: inline PR review comments** (`github_create_pr_review_comment`, `github_get_pr_review_comments`, `github_update_pr_review_comment`, `github_delete_pr_review_comment`) — Line-specific diff comments on pull requests, with optional suggested changes via the `suggestedReplacement` parameter (rendered as GitHub suggestion code fences).
- **GitHub: formal PR review submission** (`github_submit_pr_review`) — Submit a formal PR review with `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` events, optionally including inline comments and a summary body.
- **New service types:** `PrReviewComment`, `CreateReviewCommentInput`, `PrReviewSubmitted`, `PrReviewEvent`, `SubmitPrReviewInput`.
- **`GitHubClient` methods:** `createPrReviewComment()`, `getPrReviewComments()`, `updatePrReviewComment()`, `deletePrReviewComment()`, `submitPrReview()`.
- **Architecture plan:** `docs/plans/04-pr-review-capabilities.md`.

## [0.2.0] — 2026-06-29

### Added

- **Figma integration**: 8 new MCP tools for design file access
  - `figma_get_me` — authenticated user profile
  - `figma_get_file` — file overview (pages, metadata)
  - `figma_get_nodes` — inspect specific design nodes
  - `figma_get_images` — export frames as image URLs
  - `figma_get_comments` — read design comments
  - `figma_get_styles` — list colors, text styles, effects
  - `figma_get_variables` — list design token collections
  - `figma_get_versions` — version history
  - Configuration: `FIGMA_TOKEN` env var (personal access token)
  - Auth: `X-Figma-Token` header
  - New files: `src/services/figma/figma-client.ts`, `src/integrations/figma/`

## [0.2.0] — 2026-06-23

### Added

- **GitHub: create PR tool** (`github_create_pr`) — Create pull requests on any repository via `POST /repos/{repo}/pulls`. Parameters: `repo`, `title`, `head`, `base`, `body`, `draft`.
- **GitHub: list branches tool** (`github_list_branches`) — List git branches for a repository via `GET /repos/{repo}/branches`. Returns `{ name, sha, protected }[]`. Cursor-based pagination using page number.
- **GitHub: branch-name PR search** — `github_get_prs` now supports `searchBranches: boolean` parameter that enumerates git refs, filters by issue key, and finds open PRs from matching branches. Results are merged with title/body search (deduplicated).
- **GitHub: functional `state` parameter** — `github_get_prs` now passes `state` (`open`/`closed`/`all`) to all search methods. Default remains `open`.
- **Configurable `GH_REPOS`** — `GH_REPOS` env var (comma-separated) controls which repos are searched, with fallback to `TransActComm/TravelTracker`, `TransActComm/Portage-backend`, `TransActComm/Portage-frontend`.

### jira-cli library

- **`createPullRequest()`** — POST /repos/{repo}/pulls, returns `PrCreated` (`{ number, htmlUrl, state }`).
- **`listBranches()`** — GET /repos/{repo}/branches, returns `BranchInfo[]` (`{ name, sha, protected }`).
- **`searchPrsByBranchName()`** — Enumerates git refs, filters by issue key, finds open PRs from matching branches. Features branch refs caching and API call budget (max 20 calls) to prevent rate-limit amplification.
- **`state` parameter** — Added to `searchPrs()`, `findPrsForIssueKeys()`, and `searchPrsByBranchName()`.
- **GitHub pagination** — `fetchAllPages()` follows GitHub Link headers (`rel="next"`) with a max 5 page cap, used by `searchPrs()` and `findPrsForIssueKeys()`.
- **New exported types** — `PrCreated` (`number`, `htmlUrl`, `state`) and `BranchInfo` (`name`, `sha`, `protected`).
- **Input validation** — Repo format validation (`owner/name`), issue key format validation (`PROJECT-123`), and query sanitization for `findPrsForIssueKeys()`.

### Changed

- GitHub module: 1 tool → 3 tools (conditional on `GH_TOKEN`).
- `github_get_prs` now returns PRs from title/body search AND optionally from branch-name matching.
- `github_get_prs` now respects the `state` parameter (previously hardcoded to `open`).

### Code Reviews

- [Phase 2 Implementation Review](docs/code-review/phase2-github-review.md)

## [0.1.0] — 2026-06-23

### Added

- **MCP Server foundation** (`src/mcp-server.ts`) — central MCP server with stdio transport, module registry, and central dispatch for tools/resources/prompts. Starts with graceful degradation when no env vars are set.
- **Jira integration module** (`src/integrations/jira/`) — 8 tools, 3 resources, 2 prompts, registered when `JIRA_BASE_URL` + `JIRA_EMAIL` + `JIRA_TOKEN` are all set:
  - Tools: `jira_whoami`, `jira_get_issues`, `jira_create_issue`, `jira_update_issue`, `jira_transition_issue`, `jira_assign_issue`, `jira_add_comment`, `jira_link_issues`
  - Resources: `jira://issue/{key}`, `jira://search/{jql}`, `jira://myself`
  - Prompts: `create-issue`, `triage-issue`
- **GitHub integration module** (`src/integrations/github/`) — 1 tool, 1 resource, registered when `GH_TOKEN` is set:
  - Tool: `github_get_prs` (polymorphic: single `issueKey` or batched `keys`)
  - Resource: `github://prs/{issueKey}`
- **Built-in health tool** (`src/mcp-health.ts`) — `mcp_get_health` always registered, reports `jira`/`github` boolean status.
- **Module registry** (`src/integrations/index.ts`) — `IntegrationModule` interface with DI pattern: `createToolHandlers`, `getToolDescriptors`, optional `getResourceHandler`/`getPromptHandler`.
- **Safe bootstrap** (`src/mcp-config.ts`) — wraps `loadConfig()` in try/catch so missing Jira env vars don't crash GitHub-only operation.
- **Pagination helpers** (`src/integrations/helpers.ts`) — `PaginatedResponse<T>` shape, `paginated()` factory, `zodToJsonSchema()` for MCP schema generation.
- **Test suite** — 93 tests across 8 test files (vitest). All tool handlers testable via DI with mock clients.
- **Configuration** — `.env.example` with docs for `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, `GH_TOKEN`, `MCP_TRANSPORT`, `MCP_PORT`, `MCP_LOG_LEVEL`.
- **Scripts** — `npm run mcp`, `npm run mcp:prod`, `npm run mcp:inspect`, `npm run build`, `npm run typecheck`, `npm run test`, `npm run test:watch`.

### Architecture

- **Module-based integration hub** — each external tool is a self-contained `IntegrationModule`. Adding a new module requires creating `src/integrations/<name>/` and registering it in the module registry.
- **Dependency injection** — tool handlers receive client instances (`JiraClient`, `GitHubClient`) rather than constructing them. Enables unit testing without real credentials.
- **Conditional registration** — tools are only registered when their required env vars are present. No env var = no tool for that domain.
- **Central dispatch** — single `CallToolRequestSchema` handler dispatches to registered handlers by tool name. Single `ReadResourceRequestSchema` handler tries all resource handlers.
- **Polymorphic tools** — `jira_get_issues` accepts `key` (single issue) or `jql` (search); both return `PaginatedResponse<SlimIssue>` for a consistent shape.
- **Slim-by-default** — all tools return slim data shapes. `fields?: string[]` parameter allows agents to request specific fields beyond defaults.
- **JSON serialization** — single-line (no pretty-printing), `undefined` values stripped.

### Code Reviews

- [Plan Review](docs/code-review/jira-cli-mcp-server-plan-review.md)
- [Phase 1 Implementation Review](docs/code-review/phase1-mcp-implementation-review.md)
