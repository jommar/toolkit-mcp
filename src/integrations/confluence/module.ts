import { z } from 'zod';
import { ConfluenceClient, describeConfluenceError } from '../../services/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from '../helpers.js';

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------
export const confluenceSearchSchema = z
  .object({
    query: z
      .string()
      .max(1000)
      .optional()
      .describe('Free-text search, matched as CQL `text ~ "..."`. Ignored when `cql` is given.'),
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
      .describe('Also return raw storage-format XHTML (default false — body is plain text).'),
  })
  .refine((d) => !!(d.id || (d.space && d.title)), { message: 'Provide either id, or both space and title' });

export const confluenceListSpacesSchema = z.object({
  type: z.enum(['global', 'personal']).optional().describe('Filter by space type.'),
  keys: z.array(z.string().max(100)).optional().describe('Filter to specific space keys.'),
  limit: z.number().min(1).max(100).optional().default(25).describe('Max results (default 25).'),
  start: z.number().min(0).optional().default(0).describe('Offset for pagination (default 0).'),
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
  throw new McpError(ErrorCode.InternalError, describeConfluenceError(err));
}

export const confluenceSearchHandler: ToolHandler<z.infer<typeof confluenceSearchSchema>> =
  (clients) => async (args) => {
    try {
      const cql = buildCql(args);
      const result = await clients.confluence.search(cql, { limit: args.limit, start: args.start });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
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
        throw new McpError(
          ErrorCode.InvalidParams,
          `No page found for space="${args.space}" title="${args.title}"`,
        );
      }
      return { content: [{ type: 'text', text: JSON.stringify(page) }] };
    } catch (err) {
      if (err instanceof McpError) throw err;
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
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      toMcp(err);
    }
  };

/** All tool descriptors for the ListToolsRequestSchema response. */
export const confluenceToolDescriptors = [
  {
    name: 'confluence_search',
    description:
      'Search Confluence content via free text or raw CQL. Returns slim results (id, title, space, excerpt, url).',
    inputSchema: zodToJsonSchema(confluenceSearchSchema),
  },
  {
    name: 'confluence_get_page',
    description:
      'Fetch a Confluence page by ID, or by space + exact title. Returns metadata plus body as plain text.',
    inputSchema: zodToJsonSchema(confluenceGetPageSchema),
  },
  {
    name: 'confluence_list_spaces',
    description: 'List Confluence spaces (key, name, type, url) for discovery.',
    inputSchema: zodToJsonSchema(confluenceListSpacesSchema),
  },
];
