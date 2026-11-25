# toolkit-mcp — Confluence reference

Loaded from [`../SKILL.md`](../SKILL.md). **Writes need a human OK first** — that rule is in `SKILL.md`
and applies before every `confluence_create_page` / `confluence_update_page`. Confluence registers
whenever the Jira credentials are set (it shares the Atlassian token); `CONFLUENCE_BASE_URL`,
`CONFLUENCE_EMAIL` and `CONFLUENCE_TOKEN` override them for a different site.

## Tools

| Tool | Use for | Key params |
|------|---------|-----------|
| `confluence_search` | Search wiki content (free text or raw CQL) | `query` **or** `cql`; `space?`, `limit`(25), `start` |
| `confluence_get_page` | Read a page → metadata and body as plain text | `id` **or** (`space` + `title`); `includeStorage`(false) |
| `confluence_list_spaces` | Discover spaces | `type?`(`global`/`personal`), `keys[]?`, `limit`(25), `start` |
| `confluence_whoami` | Authenticated Confluence user | _none_ |
| `confluence_create_page` | **Write** — create a page in a space | `space`, `title`, `body`, `format`(`storage`\|`markdown`), `parentId?` |
| `confluence_update_page` | **Write** — replace a page's body, auto-incrementing the version | `pageId`, `body`, `format`(`storage`\|`markdown`), `title?` |

## Behaviors

- **`confluence_search` builds CQL for you:** a free-text `query` becomes `text ~ "..."` (quotes escaped), optionally AND-ed with `space`. For anything richer (dates, labels, `type=blogpost`, ancestor), pass raw `cql` — it overrides `query` and `space`.
- **`confluence_get_page` body is plain text** — storage XHTML is stripped (macro config dropped, code-block CDATA unwrapped). Pass `includeStorage: true` for the raw XHTML, which you need before an update.
- **`confluence_get_page` by `space` + `title`** errors if nothing matches the exact title.
- **Reads are permission-scoped to your account:** a missing page may be a permission gap, not a bad id.
- **Formats:** prefer `format: "markdown"` for new prose; use `"storage"` when round-tripping existing XHTML.

## Recipes

**Find a wiki page and read it**

```text
confluence_search { query: "approval workflow", space: "ENG", limit: 5 }   // → results[].id, title, url, excerpt
confluence_get_page { id: "99057676" }                                     // → body as plain text
confluence_get_page { space: "ENG", title: "Release checklist" }            // straight by exact title
```

**Update a page without losing content** (after the user said yes)

```text
confluence_get_page { id: "99057676", includeStorage: true }   // edit the returned storage body
confluence_update_page { pageId: "99057676", body: "<edited storage>", format: "storage" }
```
