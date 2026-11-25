# toolkit-mcp — Jenkins and Figma reference

Loaded from [`../SKILL.md`](../SKILL.md). Jenkins is read-only and registers only if `JENKINS_URL`,
`JENKINS_USER` and `JENKINS_TOKEN` are set and the server answers at startup. Figma registers only if
`FIGMA_TOKEN` is set.

## Jenkins tools

| Tool | Use for | Key params |
|------|---------|-----------|
| `jenkins_get_jobs` | List jobs with current build status | `limit`(20), `cursor` |
| `jenkins_get_builds` | Recent builds for a job, newest first | `job`; `limit`(20), `cursor` |
| `jenkins_get_build` | One build's details; omit `buildNumber` for the most recent | `job`; `buildNumber?` |
| `jenkins_get_console` | Build console log, paginated by line, or its last lines | `job`; `buildNumber?`, `limit`(200), `cursor`, `tail?` (last `limit` lines; not with `cursor`) |
| `jenkins_healthcheck` | Did the last build of each requested job succeed? | `jobs[]?` (omit → every visible job) |

## Figma tools

| Tool | Use for | Key params |
|------|---------|-----------|
| `figma_get_me` | Authenticated Figma user | _none_ |
| `figma_get_file` | File by key; document tree slimmed unless narrowed | `fileKey`; `depth?`, `ids?`, `geometry?`, `version?` |
| `figma_get_nodes` | Specific nodes by id | `fileKey`, `ids`; `depth?` |
| `figma_get_images` | Export images for nodes | `fileKey`, `ids`; `format`(png), `scale`(1) |
| `figma_get_comments` | Comments on a file | `fileKey` |
| `figma_get_styles` | Styles published to a file | `fileKey` |
| `figma_get_variables` | Local variables in a file | `fileKey` |
| `figma_get_versions` | Version history of a file | `fileKey` |
| `figma_post_comment` | Post a comment (optionally threaded) | `fileKey`, `message`; `parentId?` |

## Behaviors

- **Jenkins tools missing although configured** means the server was unreachable at startup; they stay absent until the MCP server restarts.
- **Jenkins `job` names can be nested** (`"folder/job"`); build and console cursors are numeric line or offset tokens.
- **`figma_get_file` slims the document tree** unless you pass `depth` or `ids` — `document` becomes a `{truncated: true}` marker. Use `figma_get_nodes` for specific nodes.
- **`figma_post_comment` is visible to everyone on the file** — confirm the wording with the user first.

## Recipes

**Check build health and tail a failing build**

```text
jenkins_healthcheck { jobs: ["api-build", "web-build"] }
jenkins_get_builds { job: "api-build", limit: 5 }
jenkins_get_build { job: "api-build", buildNumber: 123 }
jenkins_get_console { job: "api-build", tail: true }  // latest build, last 200 lines
```

**Read a Figma file and export assets**

```text
figma_get_file { fileKey: "ABC123def456", depth: 2 }
figma_get_nodes { fileKey: "ABC123def456", ids: "1:2,3:4" }
figma_get_images { fileKey: "ABC123def456", ids: "1:2,3:4", format: "png", scale: 2 }
figma_get_comments { fileKey: "ABC123def456" }
figma_post_comment { fileKey: "ABC123def456", message: "..." }   // after the user approves the wording
```
