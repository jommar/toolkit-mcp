# toolkit-mcp — server reference

Loaded from [`../SKILL.md`](../SKILL.md) when a tool is missing, to check which integrations are live,
or to use the server's MCP resources and prompts.

## Health — always registered

| Tool | Use for | Key params |
|------|---------|-----------|
| `mcp_get_health` | Server version, Node version and which integrations are active | _none_ |

## Resources and prompts (when a client surfaces them)

**Resources** (read-only URIs, JSON payloads) mirror the read tools. Prefer the tools in agent flows;
the resources exist for clients that read resources directly.

- `jira://issue/{KEY}` — slim issue
- `jira://search/{url-encoded-JQL}` — search results (some JQL keywords are blocked in resource queries)
- `jira://myself` — authenticated user
- `github://prs/{KEY}` — PRs for an issue key

**Prompts:**

- `create-issue` — args `projectKey`, `issueType`, `summary`, `description?`, `priority?`, `labels?`
- `triage-issue` — arg `key`; a triage briefing (summary, status, assignee, description, transitions, comments)

**Skills:** this guide is served over the MCP Skills extension at `skill://toolkit-mcp/SKILL.md` to
clients on protocol 2026-07-28 that support it.

## If a tool is missing

Tools register conditionally. Run `mcp_get_health` to see which integrations are live, then check the
server's `.env` against `.env.example`:

| Integration | Needs |
|-------------|-------|
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` |
| Confluence | the Jira credentials, or `CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_TOKEN` |
| GitHub | `GH_TOKEN` |
| Jenkins | `JENKINS_URL`, `JENKINS_USER`, `JENKINS_TOKEN`, and the server reachable at startup |
| Figma | `FIGMA_TOKEN` |
| Slack | `SLACK_ENABLED=true` (exactly `true`) |

The server starts with no env vars at all; only `mcp_get_health` is guaranteed. A tool or parameter
added after the server started is not visible until it restarts (for example `/mcp` reconnect).
