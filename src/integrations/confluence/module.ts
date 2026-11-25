import { z } from 'zod';
import { ConfluenceClient, describeConfluenceError, markdownToStorage } from '../../services/index.js';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { paginated } from '../helpers.js';
import type { ToolDescriptor } from '../index.js';
import { ADDITIVE_HINTS, DESTRUCTIVE_NON_IDEMPOTENT_HINTS, READ_ONLY_HINTS } from '../register.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------
export const confluenceSearchSchema = z
  .object({
    query: z
      .string()
      .max(1000)
      .optional()
      .describe('Free-text search, matched as CQL `text ~ "..."`. Ignored when `cql` is given. Returns slim results (id, title, space, excerpt, url).'),
    cql: z
      .string()
      .max(4096)
      .optional()
      .describe('Raw CQL (advanced) — overrides `query`/`space`. e.g. `type=page AND space=STD AND text ~ "approval"`.'),
    space: z.string().max(100).optional().describe('Restrict to a space by key (e.g. "STD"). Combined with `query`.'),
    limit: z.number().min(1).max(100).optional().default(25).describe('Max results (default 25).'),
    start: z.number().min(0).optional().default(0).describe('Offset for pagination (default 0).'),
  })
  .refine((d) => !!(d.query || d.cql), { message: 'Provide either query or cql' });

export const confluenceGetPageSchema = z
  .object({
    id: z.string().max(30).optional().describe('Page/content ID (e.g. "99057676").'),
    space: z.string().max(100).optional().describe('Space key — required when looking up by title.'),
    title: z.string().max(255).optional().describe('Exact page title — used with `space` when `id` is omitted.'),
    includeStorage: z
      .boolean()
      .optional()
      .default(false)
      .describe('Also return raw storage-format XHTML (default false — body is plain text). Returns metadata plus body as plain text.'),
  })
  .refine((d) => !!(d.id || (d.space && d.title)), { message: 'Provide either id, or both space and title' });

export const confluenceListSpacesSchema = z.object({
  type: z.enum(['global', 'personal']).optional().describe('Filter by space type.'),
  keys: z.array(z.string().max(100)).optional().describe('Filter to specific space keys.'),
  limit: z.number().min(1).max(100).optional().default(25).describe('Max results (default 25).'),
  start: z.number().min(0).optional().default(0).describe('Offset for pagination (default 0).'),
});

export const confluenceWhoamiSchema = z.object({}).describe('Empty — no parameters required.');

const confluenceBodyFormatSchema = z
  .enum(['storage', 'markdown'])
  .optional()
  .default('storage')
  .describe(
    'Format of `body`: "storage" is Confluence storage-format XHTML (default); ' +
      '"markdown" is converted via a deliberately limited subset — headings, paragraphs, ' +
      'lists, pipe tables, fenced code blocks, bold/italic, inline code, and links. ' +
      'Anything else (nested lists, blockquotes, images, raw HTML) is not converted.',
  );

export const confluenceCreatePageSchema = z.object({
  space: z.string().max(100).describe('Space key to create the page in (e.g. "STD").'),
  title: z.string().max(255).describe('Page title.'),
  body: z.string().max(500_000).describe('Page content — see `format` for the accepted representation.'),
  format: confluenceBodyFormatSchema,
  parentId: z.string().max(30).optional().describe('Parent page ID to nest this page under.'),
});

export const confluenceUpdatePageSchema = z.object({
  pageId: z.string().max(30).describe('ID of the page to update.'),
  body: z.string().max(500_000).describe('New page content — see `format` for the accepted representation.'),
  title: z.string().max(255).optional().describe('New title (omit to keep the existing title).'),
  format: confluenceBodyFormatSchema,
});

// ---------------------------------------------------------------------------
// CQL helpers
// ---------------------------------------------------------------------------

/** Escape a value for safe embedding inside a CQL double-quoted string literal. */
export function cqlQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Build a CQL query from the simple params, or pass through a raw `cql`. */
export function buildCql(args: { query?: string; cql?: string; space?: string }): string {
  if (args.cql) return args.cql;
  const clauses: string[] = [];
  if (args.space) clauses.push(`space = ${cqlQuote(args.space)}`);
  if (args.query) clauses.push(`text ~ ${cqlQuote(args.query)}`);
  return clauses.join(' AND ');
}

// ---------------------------------------------------------------------------
// Handler Factories
// ---------------------------------------------------------------------------
type ToolHandler<T = unknown> = (
  clients: { confluence: ConfluenceClient },
) => (args: T) => Promise<{ content: { type: 'text'; text: string }[] }>;

function toMcp(err: unknown): never {
  throw new ProtocolError(ProtocolErrorCode.InternalError, describeConfluenceError(err));
}

export const confluenceSearchHandler: ToolHandler<z.infer<typeof confluenceSearchSchema>> =
  (clients) => async (args) => {
    try {
      const cql = buildCql(args);
      const result = await clients.confluence.search(cql, { limit: args.limit, start: args.start });
      // Map Confluence's {results, start, limit, size} envelope to {items, nextPageToken, hasMore}
      const body = {
        ...paginated(result.results, result.hasMore ? String(result.start + result.limit) : undefined),
        totalSize: result.totalSize,
      };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      toMcp(err);
    }
  };

export const confluenceGetPageHandler: ToolHandler<z.infer<typeof confluenceGetPageSchema>> =
  (clients) => async (args) => {
    try {
      const page = args.id
        ? await clients.confluence.getPageById(args.id, { includeStorage: args.includeStorage })
        : await clients.confluence.getPageByTitle(args.space!, args.title!, { includeStorage: args.includeStorage });
      if (!page) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `No page found for space="${args.space}" title="${args.title}"`,
        );
      }
      return { content: [{ type: 'text', text: JSON.stringify(page) }] };
    } catch (err) {
      if (err instanceof ProtocolError) throw err;
      toMcp(err);
    }
  };

export const confluenceListSpacesHandler: ToolHandler<z.infer<typeof confluenceListSpacesSchema>> =
  (clients) => async (args) => {
    try {
      const result = await clients.confluence.listSpaces({
        type: args.type,
        keys: args.keys,
        limit: args.limit,
        start: args.start,
      });
      // Map Confluence's Paged envelope to {items, nextPageToken, hasMore}
      const body = {
        ...paginated(result.results, result.hasMore ? String(result.start + result.limit) : undefined),
      };
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    } catch (err) {
      toMcp(err);
    }
  };

export const confluenceCreatePageHandler: ToolHandler<z.infer<typeof confluenceCreatePageSchema>> =
  (clients) => async (args) => {
    try {
      const body = args.format === 'markdown' ? markdownToStorage(args.body) : args.body;
      const page = await clients.confluence.createPage({
        space: args.space,
        title: args.title,
        body,
        parentId: args.parentId,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id: page.id, title: page.title, spaceKey: page.spaceKey, url: page.url }),
          },
        ],
      };
    } catch (err) {
      toMcp(err);
    }
  };

export const confluenceUpdatePageHandler: ToolHandler<z.infer<typeof confluenceUpdatePageSchema>> =
  (clients) => async (args) => {
    try {
      const body = args.format === 'markdown' ? markdownToStorage(args.body) : args.body;
      const page = await clients.confluence.updatePage({ pageId: args.pageId, body, title: args.title });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id: page.id, title: page.title, version: page.version, url: page.url }),
          },
        ],
      };
    } catch (err) {
      toMcp(err);
    }
  };

export const confluenceWhoamiHandler: ToolHandler<z.infer<typeof confluenceWhoamiSchema>> =
  (clients) => async (_args) => {
    try {
      const user = await clients.confluence.whoami();
      return { content: [{ type: 'text', text: JSON.stringify(user) }] };
    } catch (err) {
      toMcp(err);
    }
  };

/** All tool descriptors; register.ts registers them with the server. */
export const confluenceToolDescriptors: ToolDescriptor[] = [
  {
    name: 'confluence_search',
    title: 'Search Confluence',
    description:
      'Search Confluence content via free text or raw CQL.',
    inputSchema: confluenceSearchSchema,
    annotations: READ_ONLY_HINTS,
  },
  {
    name: 'confluence_get_page',
    title: 'Get Confluence page',
    description:
      'Fetch a Confluence page by ID, or by space + exact title.',
    inputSchema: confluenceGetPageSchema,
    annotations: READ_ONLY_HINTS,
  },
  {
    name: 'confluence_list_spaces',
    title: 'List Confluence spaces',
    description: 'List Confluence spaces (key, name, type, url) for discovery.',
    inputSchema: confluenceListSpacesSchema,
    annotations: READ_ONLY_HINTS,
  },
  {
    name: 'confluence_create_page',
    title: 'Create Confluence page',
    description:
      'Create a Confluence page. Accepts `format: "storage"` (XHTML, default) or `format: "markdown"` ' +
      '(limited subset — see schema).',
    inputSchema: confluenceCreatePageSchema,
    annotations: ADDITIVE_HINTS,
  },
  {
    name: 'confluence_update_page',
    title: 'Update Confluence page',
    description:
      'Update an existing Confluence page in place, auto-incrementing the version. Accepts ' +
      '`format: "storage"` (XHTML, default) or `format: "markdown"` (limited subset — see schema).',
    inputSchema: confluenceUpdatePageSchema,
    annotations: DESTRUCTIVE_NON_IDEMPOTENT_HINTS,
  },
  {
    name: 'confluence_whoami',
    title: 'Get current Confluence user',
    description: 'Return the authenticated Confluence user profile.',
    inputSchema: confluenceWhoamiSchema,
    annotations: READ_ONLY_HINTS,
  },
];
