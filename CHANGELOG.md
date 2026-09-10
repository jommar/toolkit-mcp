# Changelog

All notable changes to the toolkit-mcp project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **GitHub: `github_get_copilot_unresolved_prs`** — Lists PRs together with the full originating comment body of every unresolved Copilot-started review thread, so an agent can pick up outstanding Copilot feedback without re-reading resolved threads. Omit `prNumbers` for the authenticated user's PRs, pass `[]` to scan all authors, or pass explicit numbers to inspect any PR regardless of author or state. `limit` bounds candidate PRs scanned (not matches), so sparse pages can still report `hasMore: true`; per-PR thread-inspection failures are reported in a compact `errors` array instead of failing the call.

## [0.3.0] — 2026-07-30

### Added

- **GitHub: diff reading tools** (`github_get_pr_files`, `github_get_pr_commits`, `github_get_file_contents`) — Review PRs via MCP with no local worktree. Per-file patches with truncation, decoded file contents with size guard, commit list with SHAs and messages.
- **GitHub: review lifecycle** — Full PR management surface:
  - `github_get_pr_review_threads`, `github_resolve_review_thread`, `github_unresolve_review_thread` — GraphQL-powered review thread tracking (query + resolve/unresolve mutations). Eliminates agent repeating comments on resolved threads.
  - `github_merge_pr` — Merges a PR with merge method and optional SHA guard. Surfaces 405/409 clearly.
  - `github_request_pr_reviewers` — Add/remove individual and team reviewers.
  - `github_update_pr_labels`, `github_update_pr_assignees` — Replace labels and assignees on a PR.
  - `github_dismiss_pr_review` — Dismiss a stale review blocking merge.
  - `github_delete_pr_issue_comment` — Delete an issue-level PR comment.
- **GitHub: search filter expansion** — `github_search_prs` now supports `label`, `reviewRequested`, and `base` filters.
- **GitHub: PullRequestDetail expansion** — `requestedReviewers`, `requestedTeams`, `labels`, `assignees` now included in PR details.
- **Jira: exposed capabilities** — `jira_get_comments`, `jira_list_transitions`, `jira_list_issue_link_types`, `jira_search_users`, `jira_delete_comment` (previously unreachable client methods).
- **Confluence: `confluence_whoami`** — verify credentials.
- **Figma: expansion** — `depth`, `ids`, `geometry`, `version` params on `figma_get_file`; `figma_post_comment` for design feedback loop.
- **`SlimComment.id`** — comment ID now available (fixes `jira_update_comment`).
- **Shared retry helper** (`src/services/http-retry.ts`) — deduplicated from 4 near-identical copies. Fixed: 403 with `retry-after` honoured, socket errors retried, write methods only retried on errors with no response.
- **Test coverage** — New test files: `jira-client.test.ts`, `figma-client.test.ts`, `slim.test.ts`, `config.test.ts`, `helpers.test.ts`. Test count: 362 → 581.

### Fixed

- **C2: `zodToJsonSchema` unwraps all `ZodEffects` layers** — multi-refine schemas (e.g. `githubCreatePrReviewCommentSchema`) now advertise their full parameter sets. Added invariant test across all module descriptors.
- **C1: `searchBranches: true`** — fixed `/pulls` response parsing (was reading absent fields).
- **C3: `github_get_prs` cursor** — cursors now honoured; results past `limit` are reachable.
- **C4: `dotenv` config** — `override: true` dropped; host-supplied credentials always win.
- **H2: pagination `hasMore`** — all list handlers use `limit + 1` probe instead of `length >= limit` (phantom page on exactly-full last page).
- **H3: `searchPrs` limit** — passes `limit` as `maxResults` instead of fanning out review-status requests for all matched PRs.
- **H4: repo validation** — per-segment `.`/`..` rejection added to `assertRepo` (defence-in-depth).
- **H5: Confluence envelope** — responses mapped to `{items, nextPageToken?, hasMore}`.
- **H6: `jira_get_issues` shape** — always returns `SlimIssue` regardless of `fields` param.
- **H7: Jira pagination** — `isLast` honoured alongside `nextPageToken`.
- **H8: JQL blocklist** — false-positive-blocking validateJql removed.
- **H9: branch search cap** — counter decremented before each request; `continue` not `break`; per-repo budget.
- **M1-M10: misc robustness** — branch refs cache TTL, attachment size guard, fetchAllPages truncation signal, Jenkins healthcheck single-fetch, cursor NaN rejection, Figma timeout/retry/truncation, error-reporting adoption, resource handler URI-scheme dispatch, env-var validation.
- **S1-S5: config/safety** — Jira token removed from McpConfig, `MCP_TRANSPORT` validation, `GH_REPOS` constructor read, Figma error truncation, Jira resource URI validation.
- **D1/D2 deduplication** — `assertRepo()`, `repoField` Zod schema, `mapPullRequestDetail()`, shared `installRetry()`, shared issue-key pattern.

### Changed

- `github_create_pr_review_comment` now correctly advertises all parameters (including `inReplyTo`) via MCP descriptors.
- Confluence `baseUrl` normalization in `loadConfluenceConfig` is now tested.
- Resource handlers dispatched by URI scheme instead of try-all loop.
- `PullRequestDetail` returned by `getPullRequest` and `updatePullRequest` are shape-identical.

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
