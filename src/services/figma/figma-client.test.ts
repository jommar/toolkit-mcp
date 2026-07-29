import { describe, it, expect, vi, beforeEach } from 'vitest';

// We don't mock fetch here — each test sets its own vi.fn() on global.fetch
// so the constructor (which doesn't call fetch) can use the real fetch.

describe('FigmaClient', () => {
  let client: import('./figma-client.js').FigmaClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FIGMA_TOKEN = 'figma_test_token_123';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  // Dynamic import after env is set
  async function createClient() {
    const { FigmaClient } = await import('./figma-client.js');
    client = new FigmaClient();
    return client;
  }

  describe('constructor', () => {
    it('throws when FIGMA_TOKEN is not set', async () => {
      delete process.env.FIGMA_TOKEN;
      await expect(async () => {
        const { FigmaClient: FC } = await import('./figma-client.js');
        new FC();
      }).rejects.toThrow('FIGMA_TOKEN env var is required');
    });

    it('throws when FIGMA_TOKEN is empty', async () => {
      process.env.FIGMA_TOKEN = '   ';
      await expect(async () => {
        const { FigmaClient: FC } = await import('./figma-client.js');
        new FC();
      }).rejects.toThrow('FIGMA_TOKEN env var is required');
    });

    it('creates a client when FIGMA_TOKEN is set', async () => {
      const c = await createClient();
      expect(c).toBeDefined();
      expect(typeof c.getMe).toBe('function');
    });
  });

  describe('getMe', () => {
    it('calls /v1/me and returns user', async () => {
      const user = { id: 'u1', email: 'a@b.com', handle: 'alice', img_url: '' };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(user),
      });

      const c = await createClient();
      const result = await c.getMe();

      expect(fetchMock).toHaveBeenCalledWith('https://api.figma.com/v1/me', {
        headers: { 'X-Figma-Token': 'figma_test_token_123' },
        signal: expect.any(AbortSignal),
      });
      expect(result).toEqual(user);
    });
  });

  describe('getFile', () => {
    it('calls /v1/files/{key} with no optional params', async () => {
      const file = { name: 'Test', lastModified: '', version: '1', document: {}, schemaVersion: 0 };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(file),
      });

      const c = await createClient();
      const result = await c.getFile('ABC123');

      expect(fetchMock).toHaveBeenCalledWith('https://api.figma.com/v1/files/ABC123', expect.anything());
      expect(result.name).toBe('Test');
    });

    it('passes optional params as query string', async () => {
      const file = { name: 'T', lastModified: '', version: '1', document: {}, schemaVersion: 0 };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(file),
      });

      const c = await createClient();
      await c.getFile('ABC123', { depth: 2, ids: '1:2', geometry: 'paths', version: 'v123' });

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('depth=2');
      expect(url).toContain('ids=1%3A2');
      expect(url).toContain('geometry=paths');
      expect(url).toContain('version=v123');
    });

    it('truncates large document when depth is not set', async () => {
      const largeDoc = { data: 'x'.repeat(60_000) };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'T', lastModified: '', version: '1', document: largeDoc, schemaVersion: 0 }),
      });

      const c = await createClient();
      const result = await c.getFile('ABC123');

      expect((result.document as any)._truncated).toBe(true);
    });

    it('does not truncate small document', async () => {
      const smallDoc = { data: 'small' };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ name: 'T', lastModified: '', version: '1', document: smallDoc, schemaVersion: 0 }),
      });

      const c = await createClient();
      const result = await c.getFile('ABC123');

      expect((result.document as any)._truncated).toBeUndefined();
      expect(result.document).toEqual(smallDoc);
    });
  });

  describe('getNodes', () => {
    it('calls /v1/files/{key}/nodes with ids', async () => {
      const nodes = { nodes: { '1:2': { document: {}, schemaVersion: 0 } } };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(nodes),
      });

      const c = await createClient();
      const result = await c.getNodes('ABC123', '1:2,3:4');

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/v1/files/ABC123/nodes');
      expect(url).toContain('ids=1%3A2%2C3%3A4');
      expect(result).toEqual(nodes);
    });
  });

  describe('getImages', () => {
    it('calls /v1/images/{key} with ids, format, scale', async () => {
      const images = { images: { '1:2': 'https://example.com/img.png' } };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(images),
      });

      const c = await createClient();
      const result = await c.getImages('ABC123', '1:2', 'png', 2);

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).toContain('/v1/images/ABC123');
      expect(url).toContain('ids=1%3A2');
      expect(url).toContain('format=png');
      expect(url).toContain('scale=2');
      expect(result).toEqual(images);
    });

    it('omits optional format and scale when undefined', async () => {
      const images = { images: {} };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(images),
      });

      const c = await createClient();
      await c.getImages('ABC123', '1:2');

      const url = fetchMock.mock.calls[0][0] as string;
      expect(url).not.toContain('format=');
      expect(url).not.toContain('scale=');
    });
  });

  describe('getComments', () => {
    it('calls /v1/files/{key}/comments and returns array', async () => {
      const comments = [{ id: 'c1', message: 'Nice!', file_key: 'ABC123', user: { id: 'u1', handle: 'a', img_url: '' }, created_at: '2025-01-01T00:00:00Z' }];
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ comments }),
      });

      const c = await createClient();
      const result = await c.getComments('ABC123');

      expect(fetchMock).toHaveBeenCalledWith('https://api.figma.com/v1/files/ABC123/comments', expect.anything());
      expect(result).toEqual(comments);
    });
  });

  describe('getStyles', () => {
    it('calls /v1/files/{key}/styles and returns styles from meta', async () => {
      const styles = [{ key: 'sk1', name: 'Primary', style_type: 'FILL' as const, description: '' }];
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ error: false, status: 200, meta: { styles } }),
      });

      const c = await createClient();
      const result = await c.getStyles('ABC123');

      expect(fetchMock).toHaveBeenCalledWith('https://api.figma.com/v1/files/ABC123/styles', expect.anything());
      expect(result).toEqual(styles);
    });
  });

  describe('getVariables', () => {
    it('calls /v1/files/{key}/variables/local', async () => {
      const vars = { status: 200, meta: { variableCollections: {}, variables: {} } };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(vars),
      });

      const c = await createClient();
      const result = await c.getVariables('ABC123');

      expect(fetchMock).toHaveBeenCalledWith('https://api.figma.com/v1/files/ABC123/variables/local', expect.anything());
      expect(result).toEqual(vars);
    });
  });

  describe('getVersions', () => {
    it('calls /v1/files/{key}/versions and returns versions', async () => {
      const versions = [{ id: 'v1', created_at: '2025-01-01T00:00:00Z', user: { id: 'u1', handle: 'a' } }];
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ versions, pagination: {} }),
      });

      const c = await createClient();
      const result = await c.getVersions('ABC123');

      expect(fetchMock).toHaveBeenCalledWith('https://api.figma.com/v1/files/ABC123/versions', expect.anything());
      expect(result).toEqual(versions);
    });
  });

  describe('postComment', () => {
    it('POSTs to /v1/files/{key}/comments with message', async () => {
      const created = { id: 'c1', message: 'Great!', file_key: 'ABC123', user: { id: 'u1', handle: 'a', img_url: '' }, created_at: '' };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(created),
      });

      const c = await createClient();
      const result = await c.postComment('ABC123', 'Great!');

      expect(fetchMock).toHaveBeenCalledWith('https://api.figma.com/v1/files/ABC123/comments', {
        method: 'POST',
        headers: {
          'X-Figma-Token': 'figma_test_token_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message: 'Great!' }),
      });
      expect(result).toEqual(created);
    });

    it('includes parentId when provided', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'r1', message: 'Reply' } as any),
      });

      const c = await createClient();
      await c.postComment('ABC123', 'Reply', 'c1');

      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        message: 'Reply',
        parent_id: 'c1',
      });
    });
  });

  describe('error handling', () => {
    it('throws with truncated message on non-ok response', async () => {
      const longBody = 'x'.repeat(1000);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve(longBody),
      });

      const c = await createClient();
      await expect(c.getMe()).rejects.toThrow(
        'Figma API error (404): ' + 'x'.repeat(500) + '...',
      );
    });

    it('throws on non-ok with short body', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Forbidden'),
      });

      const c = await createClient();
      await expect(c.getMe()).rejects.toThrow('Figma API error (403): Forbidden');
    });

    it('retries on network error then re-throws', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));
      fetchMock.mockRejectedValueOnce(new Error('Network error'));
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      const c = await createClient();
      await expect(c.getMe()).rejects.toThrow('Network error');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry 4xx errors', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      });

      const c = await createClient();
      await expect(c.getMe()).rejects.toThrow('Figma API error (400)');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('postComment error handling', () => {
    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad message'),
      });

      const c = await createClient();
      await expect(c.postComment('ABC123', 'test')).rejects.toThrow('Figma API error (400)');
    });
  });
});
