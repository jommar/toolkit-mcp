import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildCql,
  cqlQuote,
  confluenceSearchSchema,
  confluenceGetPageSchema,
  confluenceListSpacesSchema,
  confluenceSearchHandler,
  confluenceGetPageHandler,
  confluenceWhoamiHandler,
  confluenceToolDescriptors,
} from './module.js';

describe('cqlQuote', () => {
  it('wraps in double quotes and escapes " and \\', () => {
    expect(cqlQuote('plain')).toBe('"plain"');
    expect(cqlQuote('a"b')).toBe('"a\\"b"');
    expect(cqlQuote('a\\b')).toBe('"a\\\\b"');
  });
});

describe('buildCql', () => {
  it('passes through a raw cql verbatim', () => {
    expect(buildCql({ cql: 'type = blogpost', query: 'ignored', space: 'X' })).toBe('type = blogpost');
  });

  it('builds text ~ clause from a free-text query', () => {
    expect(buildCql({ query: 'approval flow' })).toBe('text ~ "approval flow"');
  });

  it('combines space and query with AND', () => {
    expect(buildCql({ space: 'STD', query: 'x' })).toBe('space = "STD" AND text ~ "x"');
  });

  it('escapes quotes in the query so CQL is not broken', () => {
    expect(buildCql({ query: 'say "hi"' })).toBe('text ~ "say \\"hi\\""');
  });
});

describe('schemas', () => {
  it('confluenceSearchSchema requires query or cql', () => {
    expect(confluenceSearchSchema.safeParse({}).success).toBe(false);
    expect(confluenceSearchSchema.safeParse({ query: 'x' }).success).toBe(true);
    expect(confluenceSearchSchema.safeParse({ cql: 'type=page' }).success).toBe(true);
  });

  it('confluenceGetPageSchema requires id, or space + title', () => {
    expect(confluenceGetPageSchema.safeParse({}).success).toBe(false);
    expect(confluenceGetPageSchema.safeParse({ id: '1' }).success).toBe(true);
    expect(confluenceGetPageSchema.safeParse({ space: 'S' }).success).toBe(false);
    expect(confluenceGetPageSchema.safeParse({ space: 'S', title: 'T' }).success).toBe(true);
  });

  it('confluenceListSpacesSchema rejects an invalid type', () => {
    expect(confluenceListSpacesSchema.safeParse({ type: 'bogus' }).success).toBe(false);
    expect(confluenceListSpacesSchema.safeParse({ type: 'global' }).success).toBe(true);
    expect(confluenceListSpacesSchema.safeParse({}).success).toBe(true);
  });
});

describe('handlers', () => {
  it('confluence_search forwards the built (escaped) CQL to the client', async () => {
    const search = vi.fn().mockResolvedValue({ results: [], start: 0, limit: 25, size: 0, hasMore: false });
    const clients = { confluence: { search } as any };

    await confluenceSearchHandler(clients)({ query: 'say "hi"', space: 'STD', limit: 25, start: 0 });

    expect(search).toHaveBeenCalledWith('space = "STD" AND text ~ "say \\"hi\\""', { limit: 25, start: 0 });
  });

  it('confluence_get_page raises InvalidParams when a title lookup finds nothing', async () => {
    const getPageByTitle = vi.fn().mockResolvedValue(null);
    const clients = { confluence: { getPageByTitle } as any };

    await expect(
      confluenceGetPageHandler(clients)({ space: 'STD', title: 'Nope', includeStorage: false }),
    ).rejects.toThrow(/No page found/);
  });
});

describe('confluenceWhoamiHandler', () => {
  let mockConfluence: { whoami: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfluence = { whoami: vi.fn() };
  });

  it('returns the authenticated user', async () => {
    const user = { accountId: 'abc', displayName: 'Test User', email: 'test@example.com' };
    mockConfluence.whoami.mockResolvedValue(user);

    const handler = confluenceWhoamiHandler({ confluence: mockConfluence as any });
    const result = await handler({});

    expect(mockConfluence.whoami).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual(user);
  });

  it('wraps client errors as McpError', async () => {
    mockConfluence.whoami.mockRejectedValue(new Error('API error'));

    const handler = confluenceWhoamiHandler({ confluence: mockConfluence as any });
    await expect(handler({})).rejects.toThrow('API error');
  });
});

describe('confluenceToolDescriptors', () => {
  it('exposes exactly the four tools with object input schemas', () => {
    const names = confluenceToolDescriptors.map((d) => d.name).sort();
    expect(names).toEqual(['confluence_get_page', 'confluence_list_spaces', 'confluence_search', 'confluence_whoami']);
    for (const d of confluenceToolDescriptors) {
      expect(d.inputSchema).toMatchObject({ type: 'object' });
      expect(typeof d.description).toBe('string');
    }
  });
});
