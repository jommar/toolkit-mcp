import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { ConfluenceClient, storageToText, markdownToStorage, describeConfluenceError } from './confluence-client.js';

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('axios', async () => {
  const real = await vi.importActual<typeof import('axios')>('axios');
  return {
    default: { create: createMock, AxiosError: real.AxiosError, isAxiosError: real.isAxiosError },
    isAxiosError: real.isAxiosError,
  };
});

interface MockAxiosInstance {
  get: Mock;
  post: Mock;
  put: Mock;
  interceptors: { response: { use: Mock } };
}

function mockAxiosInstance(): MockAxiosInstance {
  const instance: MockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    interceptors: { response: { use: vi.fn() } },
  };
  createMock.mockReturnValue(instance);
  return instance;
}

const ATLASSIAN_VARS = [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_TOKEN',
  'CONFLUENCE_BASE_URL',
  'CONFLUENCE_EMAIL',
  'CONFLUENCE_TOKEN',
];

describe('ConfluenceClient', () => {
  let http: MockAxiosInstance;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    for (const v of ATLASSIAN_VARS) saved[v] = process.env[v];
    for (const v of ATLASSIAN_VARS) delete process.env[v];
    process.env.JIRA_BASE_URL = 'https://test.atlassian.net';
    process.env.JIRA_EMAIL = 'me@test.com';
    process.env.JIRA_TOKEN = 'tok';
    http = mockAxiosInstance();
  });

  afterEach(() => {
    for (const v of ATLASSIAN_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  describe('constructor', () => {
    it('throws when no Atlassian credentials are set', () => {
      for (const v of ATLASSIAN_VARS) delete process.env[v];
      expect(() => new ConfluenceClient()).toThrow(/Missing required env var/);
    });

    it('falls back to JIRA_* creds and targets the /wiki/rest/api base', () => {
      new ConfluenceClient();
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://test.atlassian.net/wiki/rest/api',
          auth: { username: 'me@test.com', password: 'tok' },
        }),
      );
    });

    it('normalizes a base URL that already ends in /wiki', () => {
      process.env.CONFLUENCE_BASE_URL = 'https://other.atlassian.net/wiki/';
      new ConfluenceClient();
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://other.atlassian.net/wiki/rest/api' }),
      );
    });
  });

  describe('search', () => {
    it('sends the CQL query and maps + cleans results', async () => {
      http.get.mockResolvedValue({
        data: {
          results: [
            {
              content: { id: '1', type: 'page', _links: { webui: '/spaces/STD/pages/1/x' } },
              title: 'Title',
              excerpt: '@@@hl@@@foo@@@endhl@@@ &quot;bar&quot;',
              url: '/spaces/STD/pages/1/x',
              resultGlobalContainer: { title: 'Space Name', displayUrl: '/spaces/STD' },
              lastModified: '2026-01-01T00:00:00.000Z',
            },
          ],
          start: 0,
          limit: 25,
          size: 1,
          totalSize: 5,
          _links: { next: '/rest/api/search?next=true' },
        },
      });

      const client = new ConfluenceClient();
      const res = await client.search('type = page', { limit: 25, start: 0 });

      expect(http.get).toHaveBeenCalledWith('/search', {
        params: { cql: 'type = page', limit: 25, start: 0 },
      });
      expect(res.hasMore).toBe(true);
      expect(res.totalSize).toBe(5);
      expect(res.results[0]).toEqual({
        id: '1',
        title: 'Title',
        type: 'page',
        spaceKey: 'STD',
        spaceName: 'Space Name',
        excerpt: 'foo "bar"',
        url: 'https://test.atlassian.net/wiki/spaces/STD/pages/1/x',
        lastModified: '2026-01-01T00:00:00.000Z',
      });
    });
  });

  describe('getPageById', () => {
    it('expands body/version/space and renders body to plain text', async () => {
      http.get.mockResolvedValue({
        data: {
          id: '1',
          title: 'T',
          type: 'page',
          status: 'current',
          space: { key: 'STD', name: 'Space' },
          version: { number: 3 },
          body: { storage: { value: '<p>Hello <strong>world</strong></p>' } },
          _links: { webui: '/spaces/STD/pages/1' },
        },
      });

      const client = new ConfluenceClient();
      const page = await client.getPageById('1');

      expect(http.get).toHaveBeenCalledWith('/content/1', {
        params: { expand: 'body.storage,version,space' },
      });
      expect(page.body).toBe('Hello world');
      expect(page.bodyStorage).toBeUndefined();
      expect(page.version).toBe(3);
      expect(page.spaceKey).toBe('STD');
      expect(page.url).toBe('https://test.atlassian.net/wiki/spaces/STD/pages/1');
    });

    it('includes raw storage XHTML when includeStorage is true', async () => {
      http.get.mockResolvedValue({
        data: { id: '1', title: 'T', type: 'page', body: { storage: { value: '<p>hi</p>' } } },
      });
      const client = new ConfluenceClient();
      const page = await client.getPageById('1', { includeStorage: true });
      expect(page.bodyStorage).toBe('<p>hi</p>');
      expect(page.body).toBe('hi');
    });
  });

  describe('getPageByTitle', () => {
    it('returns null when no page matches', async () => {
      http.get.mockResolvedValue({ data: { results: [] } });
      const client = new ConfluenceClient();
      expect(await client.getPageByTitle('STD', 'Nope')).toBeNull();
    });
  });

  describe('createPage', () => {
    it('posts storage-format content and maps the response', async () => {
      http.post.mockResolvedValue({
        data: {
          id: '99',
          title: 'New Page',
          type: 'page',
          space: { key: 'STD' },
          _links: { webui: '/spaces/STD/pages/99' },
        },
      });

      const client = new ConfluenceClient();
      const page = await client.createPage({ space: 'STD', title: 'New Page', body: '<p>hi</p>' });

      expect(http.post).toHaveBeenCalledWith('/content', {
        type: 'page',
        title: 'New Page',
        space: { key: 'STD' },
        body: { storage: { value: '<p>hi</p>', representation: 'storage' } },
      });
      expect(page).toMatchObject({ id: '99', title: 'New Page', spaceKey: 'STD' });
      expect(page.url).toBe('https://test.atlassian.net/wiki/spaces/STD/pages/99');
    });

    it('includes ancestors when parentId is given', async () => {
      http.post.mockResolvedValue({ data: { id: '99', title: 'New Page', type: 'page' } });
      const client = new ConfluenceClient();
      await client.createPage({ space: 'STD', title: 'New Page', body: '<p>hi</p>', parentId: '42' });

      expect(http.post).toHaveBeenCalledWith(
        '/content',
        expect.objectContaining({ ancestors: [{ id: '42' }] }),
      );
    });
  });

  describe('updatePage', () => {
    it('fetches the current version and increments it', async () => {
      http.get.mockResolvedValue({
        data: { id: '99', title: 'Old Title', type: 'page', version: { number: 3 } },
      });
      http.put.mockResolvedValue({
        data: { id: '99', title: 'Old Title', type: 'page', version: { number: 4 } },
      });

      const client = new ConfluenceClient();
      const page = await client.updatePage({ pageId: '99', body: '<p>new</p>' });

      expect(http.get).toHaveBeenCalledWith('/content/99', { params: { expand: 'body.storage,version,space' } });
      expect(http.put).toHaveBeenCalledWith('/content/99', {
        id: '99',
        type: 'page',
        title: 'Old Title',
        version: { number: 4 },
        body: { storage: { value: '<p>new</p>', representation: 'storage' } },
      });
      expect(page.version).toBe(4);
    });

    it('uses the given title instead of the current one when provided', async () => {
      http.get.mockResolvedValue({ data: { id: '99', title: 'Old Title', type: 'page', version: { number: 1 } } });
      http.put.mockResolvedValue({ data: { id: '99', title: 'New Title', type: 'page', version: { number: 2 } } });

      const client = new ConfluenceClient();
      await client.updatePage({ pageId: '99', body: '<p>new</p>', title: 'New Title' });

      expect(http.put).toHaveBeenCalledWith(
        '/content/99',
        expect.objectContaining({ title: 'New Title', version: { number: 2 } }),
      );
    });
  });

  describe('listSpaces', () => {
    it('maps spaces and forwards filters', async () => {
      http.get.mockResolvedValue({
        data: {
          results: [{ id: 42, key: 'STD', name: 'Docs', type: 'global', _links: { webui: '/spaces/STD' } }],
          start: 0,
          limit: 25,
          size: 1,
          _links: {},
        },
      });
      const client = new ConfluenceClient();
      const res = await client.listSpaces({ type: 'global', keys: ['STD'] });

      expect(http.get).toHaveBeenCalledWith('/space', {
        params: { limit: 25, start: 0, type: 'global', spaceKey: ['STD'] },
      });
      expect(res.hasMore).toBe(false);
      expect(res.results[0]).toEqual({
        id: '42',
        key: 'STD',
        name: 'Docs',
        type: 'global',
        url: 'https://test.atlassian.net/wiki/spaces/STD',
      });
    });
  });
});

describe('storageToText', () => {
  it('strips tags, converts block ends to newlines, and decodes entities', () => {
    const html = '<h1>Title</h1><p>Line1<br/>Line2 &amp; more</p>';
    expect(storageToText(html)).toBe('Title\nLine1\nLine2 & more');
  });

  it('returns empty string for empty input', () => {
    expect(storageToText('')).toBe('');
  });

  it('drops macro-config parameters so they do not leak into body text', () => {
    const html =
      '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="style">none</ac:parameter></ac:structured-macro>' +
      '<h2><strong>Why?</strong></h2><p>Because.</p>';
    expect(storageToText(html)).toBe('Why?\nBecause.');
  });

  it('unwraps CDATA (e.g. code-block macros) keeping the inner text', () => {
    const html = '<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body>';
    expect(storageToText(html)).toBe('const x = 1;');
  });

  it('decodes named typographic entities (smart quotes, dashes, ellipsis)', () => {
    const html = '<p>&ldquo;hi&rdquo; &mdash; done&hellip;</p>';
    expect(storageToText(html)).toBe('“hi” — done…');
  });

  it('decodes numeric entities (decimal and hex)', () => {
    expect(storageToText('<p>caf&#233; &#x1F600;</p>')).toBe('café 😀');
  });

  it('decodes each entity once (no double-decoding of &amp;lt;)', () => {
    expect(storageToText('<p>&amp;lt;tag&amp;gt;</p>')).toBe('&lt;tag&gt;');
  });

  it('leaves unknown named entities verbatim', () => {
    expect(storageToText('<p>a &frobnicate; b</p>')).toBe('a &frobnicate; b');
  });
});

describe('markdownToStorage', () => {
  it('converts headings and paragraphs', () => {
    expect(markdownToStorage('# Title\n\nSome text.')).toBe('<h1>Title</h1><p>Some text.</p>');
  });

  it('converts unordered and ordered lists', () => {
    expect(markdownToStorage('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(markdownToStorage('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  it('converts a fenced code block, preserving language and content', () => {
    const md = '```js\nconst x = 1;\n```';
    expect(markdownToStorage(md)).toBe(
      '<ac:structured-macro ac:name="code">' +
        '<ac:parameter ac:name="language">js</ac:parameter>' +
        '<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body>' +
        '</ac:structured-macro>',
    );
  });

  it('converts a pipe table with header separator', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    expect(markdownToStorage(md)).toBe(
      '<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></tbody></table>',
    );
  });

  it('applies inline bold, italic, inline code, and links', () => {
    expect(markdownToStorage('**bold** and *italic* and `code` and [link](https://x.test)')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <code>code</code> and <a href="https://x.test">link</a></p>',
    );
  });

  it('escapes HTML-significant characters in plain text', () => {
    expect(markdownToStorage('a < b & c > d')).toBe('<p>a &lt; b &amp; c &gt; d</p>');
  });
});

describe('describeConfluenceError', () => {
  it('passes through a plain Error message', () => {
    expect(describeConfluenceError(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(describeConfluenceError('nope')).toBe('nope');
  });
});
