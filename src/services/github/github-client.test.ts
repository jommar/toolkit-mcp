import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { GitHubClient, PrSearchResult } from './github-client.js';

// Mock only axios.create — keep real AxiosError and isAxiosError for other tests
const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock('axios', async () => {
  const real = await vi.importActual<typeof import('axios')>('axios');
  return {
    default: {
      create: createMock,
      AxiosError: real.AxiosError,
      isAxiosError: real.isAxiosError,
    },
    isAxiosError: real.isAxiosError,
  };
});

interface MockAxiosInstance {
  get: Mock;
  post: Mock;
  put: Mock;
  patch: Mock;
  delete: Mock;
  interceptors: {
    response: {
      use: Mock;
    };
  };
  defaults: { headers: { common: Record<string, string> } };
}

function mockAxiosInstance(): MockAxiosInstance {
  const interceptors = { response: { use: vi.fn() } };
  const instance: MockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    interceptors,
    defaults: { headers: { common: {} } },
  };
  createMock.mockReturnValue(instance);
  return instance;
}

describe('GitHubClient', () => {
  let http: MockAxiosInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    // Set a dummy token so constructor doesn't throw
    process.env.GH_TOKEN = 'ghp_testtoken123';
    http = mockAxiosInstance();
  });

  describe('constructor', () => {
    it('throws when GH_TOKEN is not set', () => {
      delete process.env.GH_TOKEN;
      expect(() => new GitHubClient()).toThrow('GH_TOKEN env var is required');
    });

    it('throws when GH_TOKEN is empty or whitespace', () => {
      process.env.GH_TOKEN = '   ';
      expect(() => new GitHubClient()).toThrow('GH_TOKEN env var is required');
    });

    it('creates axios instance with correct config', () => {
      new GitHubClient();
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://api.github.com',
          headers: expect.objectContaining({
            Authorization: 'Bearer ghp_testtoken123',
            Accept: 'application/vnd.github+json',
          }),
          timeout: 30_000,
        }),
      );
    });

    it('registers a response interceptor for retry', () => {
      new GitHubClient();
      expect(http.interceptors.response.use).toHaveBeenCalledWith(undefined, expect.any(Function));
    });
  });

  describe('searchPrs', () => {
    it('returns sorted, deduplicated PRs across all repos', async () => {
      http.get
        // Repo 1 — TravelTracker: one result
        .mockResolvedValueOnce({
          data: {
            total_count: 1,
            items: [
              {
                number: 101,
                title: 'Add login fix TRIPS-42',
                state: 'open',
                pull_request: {},
                repository_url: 'https://api.github.com/repos/TransActComm/TravelTracker',
                user: { login: 'alice' },
                created_at: '2025-01-01T00:00:00Z',
                html_url: 'https://github.com/TransActComm/TravelTracker/pull/101',
              },
            ],
          },
        })
        // Repo 2 — Portage-backend: one result
        .mockResolvedValueOnce({
          data: {
            total_count: 1,
            items: [
              {
                number: 42,
                title: 'Fix trips TRIPS-42',
                state: 'closed',
                pull_request: { merged_at: '2025-01-02T00:00:00Z' },
                repository_url: 'https://api.github.com/repos/TransActComm/Portage-backend',
                user: { login: 'bob' },
                created_at: '2025-01-01T00:00:00Z',
                html_url: 'https://github.com/TransActComm/Portage-backend/pull/42',
              },
            ],
          },
        })
        // Repo 3 — Portage-frontend: no results
        .mockResolvedValueOnce({
          data: { total_count: 0, items: [] },
        });

      // Mock review status for the two unique PRs
      http.get
        .mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] })
        .mockResolvedValueOnce({ data: [{ state: 'CHANGES_REQUESTED' }] });

      const client = new GitHubClient();
      const results = await client.searchPrs('TRIPS-42');

      // Sorted by repo then number
      expect(results).toHaveLength(2);
      expect(results[0].repo).toBe('TransActComm/Portage-backend');
      expect(results[0].number).toBe(42);
      expect(results[0].state).toBe('merged');
      expect(results[0].reviewStatus).toBe('APPROVED');
      expect(results[1].repo).toBe('TransActComm/TravelTracker');
      expect(results[1].number).toBe(101);
      expect(results[1].state).toBe('open');
      expect(results[1].reviewStatus).toBe('CHANGES_REQUESTED');

      // 3 search calls + 2 review calls
      expect(http.get).toHaveBeenCalledTimes(5);
      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('repo:TransActComm/TravelTracker'),
        }),
      });
    });

    it('deduplicates PRs with identical html_url', async () => {
      const prItem = {
        number: 42,
        title: 'Fix trips TRIPS-42',
        state: 'open',
        pull_request: {},
        repository_url: 'https://api.github.com/repos/TransActComm/Portage-backend',
        user: { login: 'bob' },
        created_at: '2025-01-01T00:00:00Z',
        html_url: 'https://github.com/TransActComm/Portage-backend/pull/42',
      };
      // Two repos return the same PR (shouldn't happen normally but guard against it)
      http.get
        .mockResolvedValueOnce({ data: { total_count: 1, items: [prItem] } })
        .mockResolvedValueOnce({ data: { total_count: 1, items: [prItem] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      http.get.mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });

      const client = new GitHubClient();
      const results = await client.searchPrs('TRIPS-42');
      expect(results).toHaveLength(1);
      expect(results[0].reviewStatus).toBe('APPROVED');
    });

    it('handles single-repo failure and continues with other repos', async () => {
      http.get
        // Repo 1 — TravelTracker: one result
        .mockResolvedValueOnce({
          data: {
            total_count: 1,
            items: [
              {
                number: 101,
                title: 'Add login fix TRIPS-42',
                state: 'open',
                pull_request: {},
                repository_url: 'https://api.github.com/repos/TransActComm/TravelTracker',
                user: { login: 'alice' },
                created_at: '2025-01-01T00:00:00Z',
                html_url: 'https://github.com/TransActComm/TravelTracker/pull/101',
              },
            ],
          },
        })
        // Repo 2 — Portage-backend: fails
        .mockRejectedValueOnce(new Error('Timeout'))
        // Repo 3 — Portage-frontend: no results
        .mockResolvedValueOnce({
          data: { total_count: 0, items: [] },
        });

      // Mock review status for the surviving PR
      http.get.mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });

      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const client = new GitHubClient();
      const results = await client.searchPrs('TRIPS-42');

      expect(results).toHaveLength(1);
      expect(results[0].repo).toBe('TransActComm/TravelTracker');
      expect(results[0].reviewStatus).toBe('APPROVED');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Warning: search failed for'));
      warnSpy.mockRestore();
    });

    it('returns empty array when no PRs match', async () => {
      http.get
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const client = new GitHubClient();
      const results = await client.searchPrs('TRIPS-9999');
      expect(results).toEqual([]);
    });
  });

  describe('findPrsForIssueKeys', () => {
    it('returns empty map for empty keys array', async () => {
      const client = new GitHubClient();
      const result = await client.findPrsForIssueKeys([]);
      expect(result.size).toBe(0);
      expect(http.get).not.toHaveBeenCalled();
    });

    it('searches org-wide and groups results by matching key in title', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          total_count: 2,
          items: [
            {
              number: 42,
              title: '[TRIPS-1267] Migration Enhancements',
              state: 'open',
              pull_request: {},
              repository_url: 'https://api.github.com/repos/TransActComm/Portage-backend',
              user: { login: 'bob' },
              created_at: '2025-01-01T00:00:00Z',
              html_url: 'https://github.com/TransActComm/Portage-backend/pull/42',
            },
            {
              number: 43,
              title: 'Fix cross-FY for TRIPS-1262',
              state: 'open',
              pull_request: {},
              repository_url: 'https://api.github.com/repos/TransActComm/TravelTracker',
              user: { login: 'alice' },
              created_at: '2025-01-02T00:00:00Z',
              html_url: 'https://github.com/TransActComm/TravelTracker/pull/43',
            },
          ],
        },
      });

      // Mock review status for the two PRs
      http.get
        .mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] })
        .mockResolvedValueOnce({ data: [{ state: 'COMMENTED' }] });

      const client = new GitHubClient();
      const result = await client.findPrsForIssueKeys(['TRIPS-1267', 'TRIPS-1262', 'TRIPS-9999']);

      expect(http.get).toHaveBeenCalledTimes(3);
      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('(TRIPS-1267 OR TRIPS-1262 OR TRIPS-9999)'),
        }),
      });

      expect(result.has('TRIPS-1267')).toBe(true);
      expect(result.get('TRIPS-1267')).toHaveLength(1);
      expect(result.get('TRIPS-1267')![0].number).toBe(42);
      expect(result.get('TRIPS-1267')![0].reviewStatus).toBe('APPROVED');

      expect(result.has('TRIPS-1262')).toBe(true);
      expect(result.get('TRIPS-1262')).toHaveLength(1);
      expect(result.get('TRIPS-1262')![0].number).toBe(43);
      expect(result.get('TRIPS-1262')![0].reviewStatus).toBe('COMMENTED');

      // No PR matched TRIPS-9999
      expect(result.has('TRIPS-9999')).toBe(false);
    });

    it('truncates keys beyond 20 and logs a warning', async () => {
      const manyKeys = Array.from({ length: 25 }, (_, i) => `TRIPS-${i}`);
      http.get.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const client = new GitHubClient();
      const result = await client.findPrsForIssueKeys(manyKeys);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('5 key(s) skipped'));
      // Warning no longer references CLI vocabulary
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('--with-prs'));
      // With 20 keys split into chunks of 4, we expect 5 parallel queries
      expect(http.get).toHaveBeenCalledTimes(5);
      const allQueries = http.get.mock.calls.map((call: any) => call[1].params.q as string).join(' ');
      expect(allQueries).toContain('TRIPS-0');
      expect(allQueries).toContain('TRIPS-19');
      expect(allQueries).not.toContain('TRIPS-20');
      expect(result.size).toBe(0);
      warnSpy.mockRestore();
    });

    it('matches issue keys case-insensitively', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          total_count: 1,
          items: [
            {
              number: 100,
              title: '[trips-1267] Lowercase key in title',
              state: 'open',
              pull_request: {},
              repository_url: 'https://api.github.com/repos/TransActComm/Portage-backend',
              user: { login: 'test' },
              created_at: '2025-01-01T00:00:00Z',
              html_url: 'https://github.com/TransActComm/Portage-backend/pull/100',
            },
          ],
        },
      });

      http.get.mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });

      const client = new GitHubClient();
      const result = await client.findPrsForIssueKeys(['TRIPS-1267']);
      expect(result.get('TRIPS-1267')).toHaveLength(1);
      expect(result.get('TRIPS-1267')![0].reviewStatus).toBe('APPROVED');
    });

    it('matches issue keys in PR body when title does not contain the key', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          total_count: 1,
          items: [
            {
              number: 200,
              title: 'Some unrelated feature work',
              body: 'Related to TRIPS-5678, see also...',
              state: 'open',
              pull_request: {},
              repository_url: 'https://api.github.com/repos/TransActComm/Portage-backend',
              user: { login: 'dev' },
              created_at: '2025-01-01T00:00:00Z',
              html_url: 'https://github.com/TransActComm/Portage-backend/pull/200',
            },
          ],
        },
      });

      http.get.mockResolvedValueOnce({ data: [{ state: 'REVIEW_REQUIRED' }] });

      const client = new GitHubClient();
      const result = await client.findPrsForIssueKeys(['TRIPS-5678']);
      expect(result.get('TRIPS-5678')).toHaveLength(1);
      expect(result.get('TRIPS-5678')![0].number).toBe(200);
      expect(result.get('TRIPS-5678')![0].reviewStatus).toBe('REVIEW_REQUIRED');
    });
  });

  describe('construct PR state mapping', () => {
    it('maps open state correctly', async () => {
      http.get
        .mockResolvedValueOnce({ data: { total_count: 1, items: [{ number: 1, title: 'PR', state: 'open', pull_request: {}, repository_url: 'https://api.github.com/repos/TransActComm/TravelTracker', user: { login: 'a' }, created_at: '', html_url: '' }] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      http.get.mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });

      const client = new GitHubClient();
      const results = await client.searchPrs('TRIPS-1');
      expect(results[0].state).toBe('open');
      expect(results[0].reviewStatus).toBe('APPROVED');
    });

    it('maps closed without merge to "closed"', async () => {
      http.get
        .mockResolvedValueOnce({ data: { total_count: 1, items: [{ number: 1, title: 'PR', state: 'closed', pull_request: {}, repository_url: 'https://api.github.com/repos/TransActComm/TravelTracker', user: { login: 'a' }, created_at: '', html_url: '' }] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      http.get.mockResolvedValueOnce({ data: [{ state: 'CHANGES_REQUESTED' }] });

      const client = new GitHubClient();
      const results = await client.searchPrs('TRIPS-1');
      expect(results[0].state).toBe('closed');
      expect(results[0].reviewStatus).toBe('CHANGES_REQUESTED');
    });

    it('maps closed with merge to "merged"', async () => {
      http.get
        .mockResolvedValueOnce({ data: { total_count: 1, items: [{ number: 1, title: 'PR', state: 'closed', pull_request: { merged_at: '2025-01-01T00:00:00Z' }, repository_url: 'https://api.github.com/repos/TransActComm/TravelTracker', user: { login: 'a' }, created_at: '', html_url: '' }] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      http.get.mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });

      const client = new GitHubClient();
      const results = await client.searchPrs('TRIPS-1');
      expect(results[0].state).toBe('merged');
      expect(results[0].reviewStatus).toBe('APPROVED');
    });

    it('handles missing user gracefully', async () => {
      http.get
        .mockResolvedValueOnce({ data: { total_count: 1, items: [{ number: 1, title: 'PR', state: 'open', pull_request: {}, repository_url: 'https://api.github.com/repos/TransActComm/TravelTracker', user: null, created_at: '', html_url: '' }] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } })
        .mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      http.get.mockResolvedValueOnce({ data: [{ state: 'COMMENTED' }] });

      const client = new GitHubClient();
      const results = await client.searchPrs('TRIPS-1');
      expect(results[0].author).toBe('unknown');
      expect(results[0].reviewStatus).toBe('COMMENTED');
    });
  });

  describe('PrSearchResult type shape — contract validation', () => {
    it('all fields present in a valid result', () => {
      const pr: PrSearchResult = {
        number: 42,
        title: 'Fix thing',
        state: 'open',
        repo: 'owner/name',
        author: 'dev',
        createdAt: '2025-01-01T00:00:00Z',
        htmlUrl: 'https://github.com/owner/name/pull/42',
        reviewStatus: 'APPROVED',
      };
      expect(pr.number).toBeTypeOf('number');
      expect(pr.title).toBeTypeOf('string');
      expect(['open', 'closed', 'merged']).toContain(pr.state);
      expect(pr.repo).toMatch(/^.+\/.+$/);
      expect(pr.author).toBeTypeOf('string');
      expect(pr.createdAt).toBeTypeOf('string');
      expect(pr.htmlUrl).toMatch(/^https:\/\/github\.com\//);
      expect(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'COMMENTED']).toContain(pr.reviewStatus);
    });
  });

  describe('GH_REPOS config', () => {
    beforeEach(() => {
      delete process.env.GH_REPOS;
    });

    it('type export works correctly with PrCreated', () => {
      const pr: import('./github-client.js').PrCreated = { number: 1, htmlUrl: '', state: 'open' };
      expect(pr.number).toBe(1);
    });

    it('type export works correctly with BranchInfo', () => {
      const branch: import('./github-client.js').BranchInfo = { name: 'main', sha: 'abc', protected: true };
      expect(branch.name).toBe('main');
    });
  });

  describe('parseNextLink', () => {
    it('returns undefined for missing header', () => {
      // Access private method through instance
      process.env.GH_TOKEN = 'ghp_testtoken123';
      http = mockAxiosInstance();
      const client = new GitHubClient();
      const result = (client as any).parseNextLink(undefined);
      expect(result).toBeUndefined();
    });

    it('returns undefined for header without next rel', () => {
      const client = new GitHubClient();
      const result = (client as any).parseNextLink(
        '<https://api.github.com/search/issues?page=2>; rel="last"',
      );
      expect(result).toBeUndefined();
    });

    it('extracts next page URL from valid Link header', () => {
      const client = new GitHubClient();
      const result = (client as any).parseNextLink(
        '<https://api.github.com/search/issues?page=2>; rel="next", <https://api.github.com/search/issues?page=5>; rel="last"',
      );
      expect(result).toBe('https://api.github.com/search/issues?page=2');
    });

    it('handles malformed header gracefully', () => {
      const client = new GitHubClient();
      const result = (client as any).parseNextLink('not-a-valid-link-header');
      expect(result).toBeUndefined();
    });
  });

  describe('fetchAllPages', () => {
    it('returns hasMore=false when fewer pages than maxPages', async () => {
      // Single page, no Link header → no next page
      http.get.mockResolvedValueOnce({
        data: { total_count: 2, items: [{ number: 1 }, { number: 2 }] },
        headers: {},
      });

      const client = new GitHubClient();
      const result = await (client as any).fetchAllPages('/test', { per_page: 100 }, 5);
      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(false);
      expect(result.linkHeader).toBeUndefined();
    });

    it('returns hasMore=true when more pages remain but capped by maxPages', async () => {
      // Mock a response with a next Link header
      http.get.mockResolvedValueOnce({
        data: { total_count: 200, items: Array.from({ length: 100 }, (_, i) => ({ number: i })) },
        headers: { link: '<https://api.github.com/test?page=2>; rel="next"' },
      });

      const client = new GitHubClient();
      const result = await (client as any).fetchAllPages('/test', { per_page: 100 }, 1);
      expect(result.items).toHaveLength(100);
      expect(result.hasMore).toBe(true);
      expect(result.linkHeader).toBe('<https://api.github.com/test?page=2>; rel="next"');
    });
  });

  describe('createPullRequest', () => {
    it('calls POST /repos/{repo}/pulls and returns created PR', async () => {
      http.get.mockResolvedValue({ data: { total_count: 0, items: [] } });
      http.post.mockResolvedValue({
        data: {
          number: 42,
          html_url: 'https://github.com/Org/Repo/pull/42',
          state: 'open',
        },
      });

      const client = new GitHubClient();
      const result = await client.createPullRequest({
        repo: 'Org/Repo',
        title: 'My PR',
        head: 'feature',
        base: 'main',
        body: 'Description',
        draft: false,
      });

      expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls', {
        title: 'My PR',
        head: 'feature',
        base: 'main',
        body: 'Description',
        draft: false,
        maintainer_can_modify: true,
      });
      expect(result).toEqual({
        number: 42,
        htmlUrl: 'https://github.com/Org/Repo/pull/42',
        state: 'open',
      });
    });
  });

  describe('addPrComment', () => {
    it('calls POST /repos/{repo}/issues/{prNumber}/comments and returns the comment', async () => {
      http.post.mockResolvedValue({
        data: {
          id: 555,
          html_url: 'https://github.com/Org/Repo/pull/42#issuecomment-555',
          body: 'Looks good',
          user: { login: 'alice' },
          created_at: '2025-01-01T00:00:00Z',
        },
      });

      const client = new GitHubClient();
      const result = await client.addPrComment({ repo: 'Org/Repo', prNumber: 42, body: 'Looks good' });

      expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/issues/42/comments', { body: 'Looks good' });
      expect(result).toEqual({
        id: 555,
        htmlUrl: 'https://github.com/Org/Repo/pull/42#issuecomment-555',
        body: 'Looks good',
        user: 'alice',
        createdAt: '2025-01-01T00:00:00Z',
      });
    });

    it('rejects an invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.addPrComment({ repo: 'bad-repo', prNumber: 1, body: 'x' })).rejects.toThrow(
        'Invalid repo format',
      );
      expect(http.post).not.toHaveBeenCalled();
    });
  });

  describe('getPrComments', () => {
    it('calls GET /repos/{repo}/issues/{prNumber}/comments and returns mapped comments', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          {
            id: 555,
            html_url: 'https://github.com/Org/Repo/pull/42#issuecomment-555',
            body: 'Looks good',
            user: { login: 'alice' },
            created_at: '2025-01-01T00:00:00Z',
          },
          {
            id: 556,
            html_url: 'https://github.com/Org/Repo/pull/42#issuecomment-556',
            body: 'Needs fix',
            user: { login: 'bob' },
            created_at: '2025-01-02T00:00:00Z',
          },
        ],
      });

      const client = new GitHubClient();
      const result = await client.getPrComments('Org/Repo', 42);

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/issues/42/comments', {
        params: { per_page: 100, page: 1 },
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        id: 555,
        htmlUrl: 'https://github.com/Org/Repo/pull/42#issuecomment-555',
        body: 'Looks good',
        user: 'alice',
        createdAt: '2025-01-01T00:00:00Z',
      });
      expect(result[1]).toEqual({
        id: 556,
        htmlUrl: 'https://github.com/Org/Repo/pull/42#issuecomment-556',
        body: 'Needs fix',
        user: 'bob',
        createdAt: '2025-01-02T00:00:00Z',
      });
    });

    it('returns empty array when no comments', async () => {
      http.get.mockResolvedValueOnce({ data: [] });

      const client = new GitHubClient();
      const result = await client.getPrComments('Org/Repo', 42);

      expect(result).toEqual([]);
    });

    it('passes pagination options', async () => {
      http.get.mockResolvedValueOnce({ data: [] });

      const client = new GitHubClient();
      await client.getPrComments('Org/Repo', 42, { perPage: 50, page: 2 });

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/issues/42/comments', {
        params: { per_page: 50, page: 2 },
      });
    });

    it('maps null user to "unknown"', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          { id: 1, html_url: '', body: '', user: null, created_at: '' },
        ],
      });

      const client = new GitHubClient();
      const result = await client.getPrComments('Org/Repo', 42);

      expect(result[0].user).toBe('unknown');
    });

    it('throws for invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.getPrComments('invalid', 1)).rejects.toThrow('Invalid repo format');
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  describe('updatePrComment', () => {
    it('calls PATCH /repos/{repo}/issues/comments/{id} and returns updated comment', async () => {
      http.patch.mockResolvedValueOnce({
        data: {
          id: 555,
          html_url: 'https://github.com/Org/Repo/pull/42#issuecomment-555',
          body: 'Updated body',
          user: { login: 'alice' },
          created_at: '2025-01-01T00:00:00Z',
        },
      });

      const client = new GitHubClient();
      const result = await client.updatePrComment('Org/Repo', 555, 'Updated body');

      expect(http.patch).toHaveBeenCalledWith('/repos/Org/Repo/issues/comments/555', {
        body: 'Updated body',
      });
      expect(result).toEqual({
        id: 555,
        htmlUrl: 'https://github.com/Org/Repo/pull/42#issuecomment-555',
        body: 'Updated body',
        user: 'alice',
        createdAt: '2025-01-01T00:00:00Z',
      });
    });

    it('throws for invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.updatePrComment('invalid', 1, 'x')).rejects.toThrow('Invalid repo format');
      expect(http.patch).not.toHaveBeenCalled();
    });
  });

  describe('listBranches', () => {
    it('calls GET /repos/{repo}/branches and returns parsed branches', async () => {
      http.get.mockResolvedValue({
        data: [
          { name: 'main', commit: { sha: 'abc123' }, protected: true },
          { name: 'develop', commit: { sha: 'def456' }, protected: false },
        ],
      });

      const client = new GitHubClient();
      const result = await client.listBranches('Org/Repo', { perPage: 50, page: 1 });

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/branches', {
        params: { per_page: 50, page: 1 },
      });
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ name: 'main', sha: 'abc123', protected: true });
      expect(result[1]).toEqual({ name: 'develop', sha: 'def456', protected: false });
    });
  });

  describe('searchPrsByBranchName', () => {
    beforeEach(() => {
      process.env.GH_TOKEN = 'ghp_testtoken123';
      http = mockAxiosInstance();
    });

    it('calls git refs endpoint and /pulls endpoint', async () => {
      // Mock git refs response — page 1 returns branches, page 2 is empty (stops pagination)
      http.get.mockResolvedValueOnce({
        data: [
          { ref: 'refs/heads/feature/TRIPS-42-something' },
          { ref: 'refs/heads/main' },
        ],
      });
      http.get.mockResolvedValueOnce({ data: [] });
      // Mock pulls response for matching branch
      // Note: /pulls endpoint has merged_at at the top level, not inside pull_request
      http.get.mockResolvedValueOnce({
        data: [
          {
            number: 101,
            title: 'Feature for TRIPS-42',
            state: 'open',
            user: { login: 'dev' },
            created_at: '2025-01-01T00:00:00Z',
            html_url: 'https://github.com/TransActComm/TravelTracker/pull/101',
          },
        ],
      });
      // Other two repos return empty branches (page 1 empty stops pagination immediately)
      http.get.mockResolvedValueOnce({ data: [] });
      http.get.mockResolvedValueOnce({ data: [] });

      // Mock review status
      http.get.mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });

      const client = new GitHubClient();
      const result = await client.searchPrsByBranchName('TRIPS-42');

      expect(http.get).toHaveBeenCalledWith(
        '/repos/TransActComm/TravelTracker/git/refs/heads',
        expect.objectContaining({ params: { per_page: 100, page: 1 } }),
      );
      expect(http.get).toHaveBeenCalledWith('/repos/TransActComm/TravelTracker/pulls', {
        params: { head: 'TransActComm:feature/TRIPS-42-something', state: 'open' },
      });
      expect(result.has('TRIPS-42')).toBe(true);
      expect(result.get('TRIPS-42')).toHaveLength(1);
      expect(result.get('TRIPS-42')![0].number).toBe(101);
      expect(result.get('TRIPS-42')![0].reviewStatus).toBe('APPROVED');
    });

    it('handles empty branches gracefully', async () => {
      http.get.mockResolvedValueOnce({ data: [] });
      http.get.mockResolvedValueOnce({ data: [] });
      http.get.mockResolvedValueOnce({ data: [] });

      const client = new GitHubClient();
      const result = await client.searchPrsByBranchName('TRIPS-999');
      expect(result.size).toBe(0);
    });

    it('maps state to "merged" when /pulls response has top-level merged_at', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          { ref: 'refs/heads/feature/TRIPS-77-merged' },
        ],
      });
      http.get.mockResolvedValueOnce({ data: [] });
      // /pulls response with merged_at at top level (not inside pull_request)
      http.get.mockResolvedValueOnce({
        data: [
          {
            number: 77,
            title: 'Merged PR for TRIPS-77',
            state: 'closed',
            merged_at: '2025-06-01T12:00:00Z',
            user: { login: 'merger' },
            created_at: '2025-05-01T00:00:00Z',
            html_url: 'https://github.com/TransActComm/TravelTracker/pull/77',
          },
        ],
      });
      http.get.mockResolvedValueOnce({ data: [] });
      http.get.mockResolvedValueOnce({ data: [] });
      http.get.mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });

      const client = new GitHubClient();
      const result = await client.searchPrsByBranchName('TRIPS-77');
      expect(result.has('TRIPS-77')).toBe(true);
      expect(result.get('TRIPS-77')).toHaveLength(1);
      expect(result.get('TRIPS-77')![0].state).toBe('merged');
      expect(result.get('TRIPS-77')![0].reviewStatus).toBe('APPROVED');
    });
  });

  describe('getPullRequest', () => {
    it('returns full PullRequestDetail for an open PR', async () => {
      const prDetail = {
        number: 42,
        title: 'Fix the thing',
        body: 'This is a PR description',
        state: 'open',
        html_url: 'https://github.com/Org/Repo/pull/42',
        user: { login: 'alice' },
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-02T00:00:00Z',
        closed_at: null,
        merged_at: null,
        mergeable: true,
        merged_by: null,
        base: { ref: 'main' },
        head: { ref: 'feature-branch', sha: 'abc123def456' },
        changed_files: 5,
        additions: 100,
        deletions: 20,
      };
      http.get.mockResolvedValueOnce({ data: prDetail });

      const client = new GitHubClient();
      const result = await client.getPullRequest('Org/Repo', 42);

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42');
      // All PullRequestDetail fields
      expect(result.number).toBe(42);
      expect(result.title).toBe('Fix the thing');
      expect(result.body).toBe('This is a PR description');
      expect(result.state).toBe('open');
      expect(result.htmlUrl).toBe('https://github.com/Org/Repo/pull/42');
      expect(result.repo).toBe('Org/Repo');
      expect(result.author).toBe('alice');
      expect(result.createdAt).toBe('2025-01-01T00:00:00Z');
      expect(result.updatedAt).toBe('2025-01-02T00:00:00Z');
      expect(result.closedAt).toBeNull();
      expect(result.mergedAt).toBeNull();
      expect(result.mergeable).toBe(true);
      expect(result.mergedBy).toBeNull();
      expect(result.baseBranch).toBe('main');
      expect(result.headBranch).toBe('feature-branch');
      expect(result.headSha).toBe('abc123def456');
      expect(result.changedFiles).toBe(5);
      expect(result.additions).toBe(100);
      expect(result.deletions).toBe(20);
      // New read-side fields
      expect(result.requestedReviewers).toEqual([]);
      expect(result.requestedTeams).toEqual([]);
      expect(result.labels).toEqual([]);
      expect(result.assignees).toEqual([]);
    });

    it('maps new PullRequestDetail read-side fields', async () => {
      const prDetail = {
        number: 42,
        title: 'Fix the thing',
        body: null,
        state: 'open',
        html_url: 'https://github.com/Org/Repo/pull/42',
        user: { login: 'alice' },
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-02T00:00:00Z',
        closed_at: null,
        merged_at: null,
        mergeable: true,
        merged_by: null,
        base: { ref: 'main' },
        head: { ref: 'feature', sha: 'abc' },
        changed_files: 1,
        additions: 10,
        deletions: 1,
        requested_reviewers: [{ login: 'alice' }, { login: 'bob' }],
        requested_teams: [{ slug: 'team-a' }],
        labels: [{ name: 'bug' }, { name: 'frontend' }],
        assignees: [{ login: 'alice' }],
      };
      http.get.mockResolvedValueOnce({ data: prDetail });

      const client = new GitHubClient();
      const result = await client.getPullRequest('Org/Repo', 42);

      expect(result.requestedReviewers).toEqual(['alice', 'bob']);
      expect(result.requestedTeams).toEqual(['team-a']);
      expect(result.labels).toEqual(['bug', 'frontend']);
      expect(result.assignees).toEqual(['alice']);
    });

    it('maps state to "merged" when closed with merged_at', async () => {
      const prDetail = {
        number: 1,
        title: 'Merged PR',
        body: null,
        state: 'closed',
        html_url: 'https://github.com/Org/Repo/pull/1',
        user: { login: 'bob' },
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-03T00:00:00Z',
        closed_at: '2025-01-03T00:00:00Z',
        merged_at: '2025-01-03T12:00:00Z',
        mergeable: null,
        merged_by: { login: 'bob' },
        base: { ref: 'main' },
        head: { ref: 'feature', sha: 'def' },
        changed_files: 3,
        additions: 50,
        deletions: 10,
      };
      http.get.mockResolvedValueOnce({ data: prDetail });

      const client = new GitHubClient();
      const result = await client.getPullRequest('Org/Repo', 1);

      expect(result.state).toBe('merged');
      expect(result.mergedAt).toBe('2025-01-03T12:00:00Z');
      expect(result.closedAt).toBe('2025-01-03T00:00:00Z');
      expect(result.mergedBy).toBe('bob');
    });

    it('passes through null mergeable', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          number: 1, title: 'PR', body: null, state: 'open',
          html_url: '', user: { login: 'a' },
          created_at: '', updated_at: '', closed_at: null, merged_at: null,
          mergeable: null, merged_by: null,
          base: { ref: 'main' }, head: { ref: 'f', sha: 's' },
          changed_files: 0, additions: 0, deletions: 0,
        },
      });

      const client = new GitHubClient();
      const result = await client.getPullRequest('Org/Repo', 1);
      expect(result.mergeable).toBeNull();
    });

    it('maps null user to "unknown" (deleted account)', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          number: 1, title: 'PR', body: null, state: 'open',
          html_url: '', user: null,
          created_at: '', updated_at: '', closed_at: null, merged_at: null,
          mergeable: true, merged_by: null,
          base: { ref: 'main' }, head: { ref: 'f', sha: 's' },
          changed_files: 0, additions: 0, deletions: 0,
        },
      });

      const client = new GitHubClient();
      const result = await client.getPullRequest('Org/Repo', 1);
      expect(result.author).toBe('unknown');
    });

    it('passes through null merged_by', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          number: 1, title: 'PR', body: null, state: 'closed',
          html_url: '', user: { login: 'a' },
          created_at: '', updated_at: '',
          closed_at: '2025-01-03T00:00:00Z', merged_at: '2025-01-03T12:00:00Z',
          mergeable: null, merged_by: null,
          base: { ref: 'main' }, head: { ref: 'f', sha: 's' },
          changed_files: 0, additions: 0, deletions: 0,
        },
      });

      const client = new GitHubClient();
      const result = await client.getPullRequest('Org/Repo', 1);
      expect(result.mergedBy).toBeNull();
    });

    it('throws for invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.getPullRequest('invalid', 1)).rejects.toThrow('Invalid repo format');
    });
  });

  describe('getPrFiles', () => {
    it('returns files for a pull request', async () => {
      const apiFiles = [
        { filename: 'src/a.ts', status: 'modified', additions: 10, deletions: 5, changes: 15, patch: '@@ -1 +1 @@\n- old code\n+ new code', previous_filename: null },
        { filename: 'src/b.ts', status: 'added', additions: 20, deletions: 0, changes: 20, patch: '@@ -0,0 +1 @@\n+ new file', previous_filename: null },
      ];
      http.get.mockResolvedValueOnce({ data: apiFiles });

      const client = new GitHubClient();
      const result = await client.getPrFiles('Org/Repo', 42);

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/files', {
        params: { per_page: 100, page: 1 },
      });
      expect(result).toHaveLength(2);
      expect(result[0].filename).toBe('src/a.ts');
      expect(result[0].status).toBe('modified');
      expect(result[0].additions).toBe(10);
      expect(result[0].deletions).toBe(5);
      expect(result[0].changes).toBe(15);
      expect(result[0].patch).toBe('@@ -1 +1 @@\n- old code\n+ new code');
      expect(result[1].filename).toBe('src/b.ts');
      expect(result[1].status).toBe('added');
    });

    it('returns previous_filename when present', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          { filename: 'src/moved.ts', status: 'renamed', additions: 0, deletions: 0, changes: 0, patch: null, previous_filename: 'src/old.ts' },
        ],
      });

      const client = new GitHubClient();
      const result = await client.getPrFiles('Org/Repo', 42);

      expect(result[0].previous_filename).toBe('src/old.ts');
    });

    it('truncates patch when it exceeds 2000 characters', async () => {
      const longPatch = 'x'.repeat(2500);
      http.get.mockResolvedValueOnce({
        data: [
          { filename: 'f.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: longPatch },
        ],
      });

      const client = new GitHubClient();
      const result = await client.getPrFiles('Org/Repo', 42);

      expect(result[0].patch).toHaveLength(2000);
      expect(result[0].truncated).toBe(true);
    });

    it('does not truncate short patches', async () => {
      const shortPatch = 'x'.repeat(100);
      http.get.mockResolvedValueOnce({
        data: [
          { filename: 'f.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: shortPatch },
        ],
      });

      const client = new GitHubClient();
      const result = await client.getPrFiles('Org/Repo', 42);

      expect(result[0].patch).toHaveLength(100);
      expect(result[0].truncated).toBeUndefined();
    });

    it('handles missing patch', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          { filename: 'f.ts', status: 'modified', additions: 1, deletions: 1, changes: 2 },
        ],
      });

      const client = new GitHubClient();
      const result = await client.getPrFiles('Org/Repo', 42);

      expect(result[0].patch).toBeUndefined();
      expect(result[0].truncated).toBeUndefined();
    });

    it('accepts pagination options', async () => {
      http.get.mockResolvedValueOnce({ data: [] });

      const client = new GitHubClient();
      await client.getPrFiles('Org/Repo', 42, { perPage: 50, page: 2 });

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/files', {
        params: { per_page: 50, page: 2 },
      });
    });

    it('throws for invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.getPrFiles('invalid', 1)).rejects.toThrow('Invalid repo format');
    });
  });

  describe('getPrCommits', () => {
    it('returns commits for a pull request', async () => {
      const apiCommits = [
        {
          sha: 'abc123',
          commit: { message: 'Fix the bug', author: { name: 'Alice', email: 'alice@example.com', date: '2025-01-01T00:00:00Z' } },
          author: { login: 'alice' },
        },
        {
          sha: 'def456',
          commit: { message: 'Add feature', author: { name: 'Bob', email: 'bob@example.com', date: '2025-01-02T00:00:00Z' } },
          author: { login: 'bob' },
        },
      ];
      http.get.mockResolvedValueOnce({ data: apiCommits });

      const client = new GitHubClient();
      const result = await client.getPrCommits('Org/Repo', 42);

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/commits', {
        params: { per_page: 100, page: 1 },
      });
      expect(result).toHaveLength(2);
      expect(result[0].sha).toBe('abc123');
      expect(result[0].commit.message).toBe('Fix the bug');
      expect(result[0].commit.author.name).toBe('Alice');
      expect(result[0].commit.author.email).toBe('alice@example.com');
      expect(result[0].commit.author.date).toBe('2025-01-01T00:00:00Z');
      expect(result[0].author.login).toBe('alice');
    });

    it('handles empty commit list', async () => {
      http.get.mockResolvedValueOnce({ data: [] });

      const client = new GitHubClient();
      const result = await client.getPrCommits('Org/Repo', 42);

      expect(result).toEqual([]);
    });

    it('handles null author gracefully', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          {
            sha: 'abc',
            commit: { message: 'Fix', author: null },
            author: null,
          },
        ],
      });

      const client = new GitHubClient();
      const result = await client.getPrCommits('Org/Repo', 42);

      expect(result[0].sha).toBe('abc');
      expect(result[0].commit.author.name).toBe('');
      expect(result[0].author.login).toBe('');
    });

    it('accepts pagination options', async () => {
      http.get.mockResolvedValueOnce({ data: [] });

      const client = new GitHubClient();
      await client.getPrCommits('Org/Repo', 42, { perPage: 10, page: 3 });

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/commits', {
        params: { per_page: 10, page: 3 },
      });
    });

    it('throws for invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.getPrCommits('invalid', 1)).rejects.toThrow('Invalid repo format');
    });
  });

  describe('getFileContents', () => {
    it('returns decoded file contents', async () => {
      const rawContent = Buffer.from('console.log("hello");').toString('base64');
      http.get.mockResolvedValueOnce({
        data: {
          path: 'src/file.ts',
          content: rawContent,
          encoding: 'base64',
          size: 24,
          sha: 'abc123def',
        },
      });

      const client = new GitHubClient();
      const result = await client.getFileContents('Org/Repo', 'src/file.ts');

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/contents/src/file.ts', {
        params: {},
      });
      expect(result.path).toBe('src/file.ts');
      expect(result.content).toBe('console.log("hello");');
      expect(result.encoding).toBe('base64');
      expect(result.size).toBe(24);
      expect(result.sha).toBe('abc123def');
      expect(result.truncated).toBe(false);
    });

    it('passes ref when provided', async () => {
      http.get.mockResolvedValueOnce({
        data: { path: 'f.ts', content: 'Y29uc29sZS5sb2coImhlbGxvIik7', encoding: 'base64', size: 24, sha: 'abc' },
      });

      const client = new GitHubClient();
      await client.getFileContents('Org/Repo', 'f.ts', 'main');

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/contents/f.ts', {
        params: { ref: 'main' },
      });
    });

    it('returns truncated when file exceeds 100KB', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          path: 'big-file.ts',
          content: '',
          encoding: 'base64',
          size: 200_000,
          sha: 'abc123',
        },
      });

      const client = new GitHubClient();
      const result = await client.getFileContents('Org/Repo', 'big-file.ts');

      expect(result.truncated).toBe(true);
      expect(result.content).toBe('');
      expect(result.message).toContain('100KB');
    });

    it('throws for invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.getFileContents('invalid', 'f.ts')).rejects.toThrow('Invalid repo format');
    });
  });

  describe('getPullRequestReviews', () => {
    it('returns reviews with correct field mapping', async () => {
      const reviews = [
        { id: 1, user: { login: 'alice' }, state: 'APPROVED', body: 'LGTM', submitted_at: '2025-01-02T00:00:00Z', commit_id: 'abc' },
        { id: 2, user: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'Fix this', submitted_at: '2025-01-02T01:00:00Z', commit_id: 'abc' },
        { id: 3, user: { login: 'carol' }, state: 'COMMENTED', body: null, submitted_at: '2025-01-02T02:00:00Z', commit_id: 'def' },
      ];
      http.get.mockResolvedValueOnce({ data: reviews });

      const client = new GitHubClient();
      const result = await client.getPullRequestReviews('Org/Repo', 42);

      expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/reviews');
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe(1);
      expect(result[0].user).toBe('alice');
      expect(result[0].state).toBe('APPROVED');
      expect(result[0].body).toBe('LGTM');
      expect(result[0].submittedAt).toBe('2025-01-02T00:00:00Z');
      expect(result[0].commitId).toBe('abc');
      expect(result[1].state).toBe('CHANGES_REQUESTED');
      expect(result[1].body).toBe('Fix this');
      expect(result[2].state).toBe('COMMENTED');
      expect(result[2].body).toBeNull();
    });

    it('returns empty array when there are no reviews', async () => {
      http.get.mockResolvedValueOnce({ data: [] });

      const client = new GitHubClient();
      const result = await client.getPullRequestReviews('Org/Repo', 42);
      expect(result).toEqual([]);
    });

    it('maps null user to "unknown"', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          { id: 1, user: null, state: 'APPROVED', body: null, submitted_at: '', commit_id: '' },
        ],
      });

      const client = new GitHubClient();
      const result = await client.getPullRequestReviews('Org/Repo', 42);
      expect(result[0].user).toBe('unknown');
    });

    it('throws for invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.getPullRequestReviews('invalid', 42)).rejects.toThrow('Invalid repo format');
    });
  });

  describe('getPullRequestChecks', () => {
    it('returns full PullRequestChecks structure with headSha from PR detail', async () => {
      // First http.get call: getPullRequest returns PR detail with head.sha
      http.get.mockResolvedValueOnce({
        data: {
          number: 1, title: 'PR', body: null, state: 'open',
          html_url: '', user: { login: 'a' },
          created_at: '', updated_at: '', closed_at: null, merged_at: null,
          mergeable: null, merged_by: null,
          base: { ref: 'main' },
          head: { ref: 'feature', sha: 'abc123headsha' },
          changed_files: 0, additions: 0, deletions: 0,
        },
      });
      // Second http.get call: check-runs endpoint
      http.get.mockResolvedValueOnce({
        data: {
          check_runs: [
            { name: 'CI / Build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/Org/Repo/actions/runs/1', started_at: '2025-01-01T00:00:00Z', completed_at: '2025-01-01T01:00:00Z' },
            { name: 'Lint', status: 'completed', conclusion: 'success', html_url: null, started_at: '2025-01-01T00:00:00Z', completed_at: '2025-01-01T00:30:00Z' },
          ],
        },
      });

      const client = new GitHubClient();
      const result = await client.getPullRequestChecks('Org/Repo', 42);

      // First call was PR detail, second should be check-runs with headSha
      expect(http.get).toHaveBeenNthCalledWith(1, '/repos/Org/Repo/pulls/42');
      expect(http.get).toHaveBeenNthCalledWith(
        2,
        '/repos/Org/Repo/commits/abc123headsha/check-runs',
        expect.objectContaining({ params: { per_page: 100 } }),
      );
      expect(result.totalCount).toBe(2);
      expect(result.checkRuns).toHaveLength(2);
      expect(result.checkRuns[0].name).toBe('CI / Build');
      expect(result.checkRuns[0].status).toBe('completed');
      expect(result.checkRuns[0].conclusion).toBe('success');
      expect(result.checkRuns[0].htmlUrl).toBe('https://github.com/Org/Repo/actions/runs/1');
      expect(result.checkRuns[0].startedAt).toBe('2025-01-01T00:00:00Z');
      expect(result.checkRuns[0].completedAt).toBe('2025-01-01T01:00:00Z');
      expect(result.checkRuns[1].name).toBe('Lint');
      expect(result.checkRuns[1].htmlUrl).toBeNull();
    });

    it('returns empty checks when check_runs is empty', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          number: 1, title: 'PR', body: null, state: 'open',
          html_url: '', user: { login: 'a' },
          created_at: '', updated_at: '', closed_at: null, merged_at: null,
          mergeable: null, merged_by: null,
          base: { ref: 'main' },
          head: { ref: 'feature', sha: 'emptysha' },
          changed_files: 0, additions: 0, deletions: 0,
        },
      });
      http.get.mockResolvedValueOnce({
        data: { check_runs: [] },
      });

      const client = new GitHubClient();
      const result = await client.getPullRequestChecks('Org/Repo', 42);
      expect(result.totalCount).toBe(0);
      expect(result.checkRuns).toEqual([]);
    });

    it('maps check runs with mixed conclusions', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          number: 1, title: 'PR', body: null, state: 'open',
          html_url: '', user: { login: 'a' },
          created_at: '', updated_at: '', closed_at: null, merged_at: null,
          mergeable: null, merged_by: null,
          base: { ref: 'main' },
          head: { ref: 'feature', sha: 'mixedsha' },
          changed_files: 0, additions: 0, deletions: 0,
        },
      });
      http.get.mockResolvedValueOnce({
        data: {
          check_runs: [
            { name: 'Build', status: 'completed', conclusion: 'success', html_url: null, started_at: null, completed_at: null },
            { name: 'Test', status: 'completed', conclusion: 'failure', html_url: null, started_at: null, completed_at: null },
            { name: 'Lint', status: 'completed', conclusion: 'neutral', html_url: null, started_at: null, completed_at: null },
          ],
        },
      });

      const client = new GitHubClient();
      const result = await client.getPullRequestChecks('Org/Repo', 42);
      expect(result.totalCount).toBe(3);
      expect(result.checkRuns[0].conclusion).toBe('success');
      expect(result.checkRuns[1].conclusion).toBe('failure');
      expect(result.checkRuns[2].conclusion).toBe('neutral');
    });
  });

  describe('searchPullRequestsByQuery', () => {
    const searchItem = {
      number: 42,
      title: 'My PR Title',
      body: 'Description',
      state: 'open',
      pull_request: {},
      repository_url: 'https://api.github.com/repos/Org/Repo',
      user: { login: 'alice' },
      created_at: '2025-01-01T00:00:00Z',
      html_url: 'https://github.com/Org/Repo/pull/42',
    };

    it('sends author filter in query', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 1, items: [searchItem] } });

      const client = new GitHubClient();
      const result = await client.searchPullRequestsByQuery({ author: 'alice' });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('author:alice'),
        }),
      });
      expect(result).toHaveLength(1);
    });

    it('sends repo filter in query', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 1, items: [searchItem] } });

      const client = new GitHubClient();
      await client.searchPullRequestsByQuery({ repo: 'Org/Repo' });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('repo:Org/Repo'),
        }),
      });
    });

    it('sends free-text query in query string', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 1, items: [searchItem] } });

      const client = new GitHubClient();
      await client.searchPullRequestsByQuery({ query: 'bugfix' });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('bugfix'),
        }),
      });
    });

    it('includes state filter when not "all"', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const client = new GitHubClient();
      await client.searchPullRequestsByQuery({ query: 'test', state: 'closed' });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('state:closed'),
        }),
      });
    });

    it('omits state filter when state is "all"', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const client = new GitHubClient();
      await client.searchPullRequestsByQuery({ query: 'test', state: 'all' });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.not.stringContaining('state:'),
        }),
      });
    });

    it('passes per_page and page params', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const client = new GitHubClient();
      await client.searchPullRequestsByQuery({ query: 'test', perPage: 50, page: 2 });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.any(String),
          per_page: 50,
          page: 2,
        }),
      });
    });

    it('sends label filter in query', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const client = new GitHubClient();
      await client.searchPullRequestsByQuery({ label: 'bug' });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('label:bug'),
        }),
      });
    });

    it('sends reviewRequested filter in query', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const client = new GitHubClient();
      await client.searchPullRequestsByQuery({ reviewRequested: 'alice' });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('review-requested:alice'),
        }),
      });
    });

    it('sends base filter in query', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const client = new GitHubClient();
      await client.searchPullRequestsByQuery({ base: 'main' });

      expect(http.get).toHaveBeenCalledWith('/search/issues', {
        params: expect.objectContaining({
          q: expect.stringContaining('base:main'),
        }),
      });
    });

    it('throws when no filter is provided', async () => {
      const client = new GitHubClient();
      await expect(client.searchPullRequestsByQuery({})).rejects.toThrow('At least one');
    });

    it('accepts label as the only filter', async () => {
      http.get.mockResolvedValueOnce({ data: { total_count: 0, items: [] } });

      const client = new GitHubClient();
      await expect(client.searchPullRequestsByQuery({ label: 'bug' })).resolves.toEqual([]);
    });
  });

  describe('updatePullRequest', () => {
    const prDetail = {
      number: 42,
      title: 'Updated Title',
      body: 'Updated body',
      state: 'open',
      html_url: 'https://github.com/Org/Repo/pull/42',
      user: { login: 'alice' },
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-02T00:00:00Z',
      closed_at: null,
      merged_at: null,
      mergeable: true,
      merged_by: null,
      base: { ref: 'main' },
      head: { ref: 'feature-branch', sha: 'abc123def456' },
      changed_files: 5,
      additions: 100,
      deletions: 20,
    };

    it('calls PATCH /repos/{repo}/pulls/{prNumber} and returns updated PR', async () => {
      http.patch.mockResolvedValueOnce({ data: prDetail });

      const client = new GitHubClient();
      const result = await client.updatePullRequest('Org/Repo', 42, { title: 'Updated Title' });

      expect(http.patch).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42', { title: 'Updated Title' });
      expect(result.number).toBe(42);
      expect(result.title).toBe('Updated Title');
      expect(result.body).toBe('Updated body');
      expect(result.state).toBe('open');
      expect(result.htmlUrl).toBe('https://github.com/Org/Repo/pull/42');
      expect(result.repo).toBe('Org/Repo');
      expect(result.author).toBe('alice');
      expect(result.createdAt).toBe('2025-01-01T00:00:00Z');
      expect(result.updatedAt).toBe('2025-01-02T00:00:00Z');
      expect(result.closedAt).toBeNull();
      expect(result.mergedAt).toBeNull();
      expect(result.mergeable).toBe(true);
      expect(result.mergedBy).toBeNull();
      expect(result.baseBranch).toBe('main');
      expect(result.headBranch).toBe('feature-branch');
      expect(result.headSha).toBe('abc123def456');
      expect(result.changedFiles).toBe(5);
      expect(result.additions).toBe(100);
      expect(result.deletions).toBe(20);
    });

    it('closes a PR by setting state to "closed"', async () => {
      const closedPr = {
        ...prDetail,
        state: 'closed',
        title: 'Original Title',
        body: 'Original body',
        closed_at: '2025-01-03T00:00:00Z',
      };
      http.patch.mockResolvedValueOnce({ data: closedPr });

      const client = new GitHubClient();
      const result = await client.updatePullRequest('Org/Repo', 42, { state: 'closed' });

      expect(http.patch).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42', { state: 'closed' });
      expect(result.state).toBe('closed');
      expect(result.closedAt).toBe('2025-01-03T00:00:00Z');
    });

    it('maps state to "merged" when closed with merged_at', async () => {
      const mergedPr = {
        ...prDetail,
        state: 'closed',
        merged_at: '2025-01-03T12:00:00Z',
        merged_by: { login: 'bob' },
      };
      http.patch.mockResolvedValueOnce({ data: mergedPr });

      const client = new GitHubClient();
      const result = await client.updatePullRequest('Org/Repo', 42, { state: 'closed' });

      expect(result.state).toBe('merged');
      expect(result.mergedAt).toBe('2025-01-03T12:00:00Z');
      expect(result.mergedBy).toBe('bob');
    });

    it('updates base branch', async () => {
      const baseUpdated = {
        ...prDetail,
        base: { ref: 'develop' },
      };
      http.patch.mockResolvedValueOnce({ data: baseUpdated });

      const client = new GitHubClient();
      const result = await client.updatePullRequest('Org/Repo', 42, { base: 'develop' });

      expect(http.patch).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42', { base: 'develop' });
      expect(result.baseBranch).toBe('develop');
    });

    it('updates maintainerCanModify false', async () => {
      http.patch.mockResolvedValueOnce({ data: prDetail });

      const client = new GitHubClient();
      await client.updatePullRequest('Org/Repo', 42, { maintainerCanModify: false });

      expect(http.patch).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42', { maintainer_can_modify: false });
    });

    it('sends multiple fields at once', async () => {
      http.patch.mockResolvedValueOnce({ data: prDetail });

      const client = new GitHubClient();
      await client.updatePullRequest('Org/Repo', 42, {
        title: 'New Title',
        body: 'New Body',
        base: 'develop',
      });

      expect(http.patch).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42', {
        title: 'New Title',
        body: 'New Body',
        base: 'develop',
      });
    });

    it('throws for invalid repo format', async () => {
      const client = new GitHubClient();
      await expect(client.updatePullRequest('invalid', 1, { title: 'x' })).rejects.toThrow(
        'Invalid repo format',
      );
      expect(http.patch).not.toHaveBeenCalled();
    });

    it('throws when no update fields are provided', async () => {
      const client = new GitHubClient();
      await expect(client.updatePullRequest('Org/Repo', 42, {})).rejects.toThrow(
        'At least one of title, body, state, base, or maintainerCanModify must be provided',
      );
      expect(http.patch).not.toHaveBeenCalled();
    });

    it('handles API error gracefully', async () => {
      http.patch.mockRejectedValueOnce(new Error('Not Found'));

      const client = new GitHubClient();
      await expect(client.updatePullRequest('Org/Repo', 999, { title: 'x' })).rejects.toThrow('Not Found');
    });

    it('maps null user to "unknown" (deleted account)', async () => {
      const ghostUser = { ...prDetail, user: null };
      http.patch.mockResolvedValueOnce({ data: ghostUser });

      const client = new GitHubClient();
      const result = await client.updatePullRequest('Org/Repo', 42, { title: 'x' });

      expect(result.author).toBe('unknown');
    });
  });

  describe('createPrReviewComment', () => {
  it('calls POST /repos/{repo}/pulls/{number}/comments and returns mapped comment', async () => {
    http.post.mockResolvedValue({
      data: {
        id: 1,
        path: 'src/file.ts',
        line: 42,
        body: 'Great comment',
        commit_id: 'abc123',
        side: 'RIGHT',
        start_line: null,
        start_side: null,
        user: { login: 'alice' },
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:01:00Z',
        html_url: 'https://github.com/Org/Repo/pull/42#discussion_r1',
        in_reply_to_id: null,
        original_line: null,
        original_start_line: null,
      },
    });

    const client = new GitHubClient();
    const result = await client.createPrReviewComment('Org/Repo', 42, {
      body: 'Great comment',
      path: 'src/file.ts',
      commitId: 'abc123',
      line: 42,
    });

    expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/comments', {
      body: 'Great comment',
      commit_id: 'abc123',
      path: 'src/file.ts',
      line: 42,
    });
    expect(result.id).toBe(1);
    expect(result.path).toBe('src/file.ts');
    expect(result.line).toBe(42);
    expect(result.body).toBe('Great comment');
    expect(result.commitId).toBe('abc123');
    expect(result.side).toBe('RIGHT');
    expect(result.author).toBe('alice');
  });

  it('includes start_line and start_side when provided', async () => {
    http.post.mockResolvedValue({
      data: {
        id: 2, path: 'src/file.ts', line: 50, body: 'Multi-line', commit_id: 'def456',
        side: 'RIGHT', start_line: 45, start_side: 'RIGHT',
        user: { login: 'bob' }, created_at: '', updated_at: '',
        html_url: '', in_reply_to_id: null, original_line: null, original_start_line: null,
      },
    });

    const client = new GitHubClient();
    await client.createPrReviewComment('Org/Repo', 42, {
      body: 'Multi-line',
      path: 'src/file.ts',
      commitId: 'def456',
      line: 50,
      startLine: 45,
    });

    expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/comments', {
      body: 'Multi-line',
      commit_id: 'def456',
      path: 'src/file.ts',
      line: 50,
      start_line: 45,
    });
  });

  it('includes side: LEFT when specified', async () => {
    http.post.mockResolvedValue({
      data: {
        id: 3, path: 'src/file.ts', line: 10, body: 'Left side', commit_id: 'abc',
        side: 'LEFT', start_line: null, start_side: null,
        user: { login: 'carol' }, created_at: '', updated_at: '',
        html_url: '', in_reply_to_id: null, original_line: null, original_start_line: null,
      },
    });

    const client = new GitHubClient();
    await client.createPrReviewComment('Org/Repo', 42, {
      body: 'Left side',
      path: 'src/file.ts',
      commitId: 'abc',
      line: 10,
      side: 'LEFT',
    });

    expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/comments', {
      body: 'Left side',
      commit_id: 'abc',
      path: 'src/file.ts',
      line: 10,
      side: 'LEFT',
    });
  });

  it('throws for invalid repo format', async () => {
    const client = new GitHubClient();
    await expect(
      client.createPrReviewComment('invalid', 1, { body: 'x', path: 'f', commitId: 'a', line: 1 }),
    ).rejects.toThrow('Invalid repo format');
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe('replyToPrReviewComment', () => {
  it('posts to the replies endpoint with only a body', async () => {
    http.post.mockResolvedValue({
      data: {
        id: 9, path: 'src/file.ts', line: 42, body: 'Agreed', commit_id: 'abc',
        side: 'RIGHT', start_line: null, start_side: null,
        user: { login: 'bob' }, created_at: '', updated_at: '',
        html_url: 'https://github.com/Org/Repo/pull/42#discussion_r9',
        in_reply_to_id: 5, original_line: null, original_start_line: null,
      },
    });

    const client = new GitHubClient();
    const result = await client.replyToPrReviewComment('Org/Repo', 42, 5, 'Agreed');

    expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/comments/5/replies', {
      body: 'Agreed',
    });
    expect(result.id).toBe(9);
    expect(result.inReplyToId).toBe(5);
  });

  it('throws for invalid repo format', async () => {
    const client = new GitHubClient();
    await expect(
      client.replyToPrReviewComment('invalid', 1, 5, 'x'),
    ).rejects.toThrow('Invalid repo format');
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe('setPullRequestDraft', () => {
  const prDetail = {
    number: 42,
    node_id: 'PR_node123',
    title: 'Title',
    body: null,
    state: 'open',
    draft: false,
    html_url: 'https://github.com/Org/Repo/pull/42',
    user: { login: 'alice' },
    created_at: '', updated_at: '', closed_at: null, merged_at: null,
    mergeable: true, merged_by: null,
    base: { ref: 'main' }, head: { ref: 'feature', sha: 'abc' },
    changed_files: 1, additions: 1, deletions: 0,
  };

  it('converts to draft via the GraphQL mutation and returns refreshed details', async () => {
    http.get
      .mockResolvedValueOnce({ data: prDetail })
      .mockResolvedValueOnce({ data: { ...prDetail, draft: true } });
    http.post.mockResolvedValue({ data: { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } } });

    const client = new GitHubClient();
    const result = await client.setPullRequestDraft('Org/Repo', 42, true);

    expect(http.post).toHaveBeenCalledWith('/graphql', {
      query: expect.stringContaining('convertPullRequestToDraft'),
      variables: { id: 'PR_node123' },
    });
    expect(result.draft).toBe(true);
  });

  it('marks ready for review when draft is false', async () => {
    http.get
      .mockResolvedValueOnce({ data: { ...prDetail, draft: true } })
      .mockResolvedValueOnce({ data: prDetail });
    http.post.mockResolvedValue({ data: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } });

    const client = new GitHubClient();
    const result = await client.setPullRequestDraft('Org/Repo', 42, false);

    expect(http.post).toHaveBeenCalledWith('/graphql', {
      query: expect.stringContaining('markPullRequestReadyForReview'),
      variables: { id: 'PR_node123' },
    });
    expect(result.draft).toBe(false);
  });

  it('throws when GraphQL returns errors', async () => {
    http.get.mockResolvedValueOnce({ data: prDetail });
    http.post.mockResolvedValue({ data: { errors: [{ message: 'Resource not accessible' }] } });

    const client = new GitHubClient();
    await expect(client.setPullRequestDraft('Org/Repo', 42, true)).rejects.toThrow(
      'GitHub GraphQL error: Resource not accessible',
    );
  });

  it('throws when the PR has no node id', async () => {
    http.get.mockResolvedValueOnce({ data: { ...prDetail, node_id: undefined } });

    const client = new GitHubClient();
    await expect(client.setPullRequestDraft('Org/Repo', 42, true)).rejects.toThrow(
      'Could not resolve node id for Org/Repo#42',
    );
    expect(http.post).not.toHaveBeenCalled();
  });

  it('throws for invalid repo format', async () => {
    const client = new GitHubClient();
    await expect(client.setPullRequestDraft('invalid', 42, true)).rejects.toThrow('Invalid repo format');
    expect(http.get).not.toHaveBeenCalled();
  });
});

describe('getPrReviewComments', () => {
  it('returns mapped review comments from GET /repos/{repo}/pulls/{number}/comments', async () => {
    http.get.mockResolvedValue({
      data: [
        {
          id: 1, path: 'src/a.ts', line: 10, body: 'Nice', commit_id: 'abc',
          side: 'RIGHT', start_line: null, start_side: null,
          user: { login: 'alice' },
          created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:01:00Z',
          html_url: 'https://github.com/Org/Repo/pull/42#discussion_r1',
          in_reply_to_id: null, original_line: null, original_start_line: null,
        },
        {
          id: 2, path: 'src/b.ts', line: 20, body: 'Fix this', commit_id: 'def',
          side: 'LEFT', start_line: 15, start_side: 'LEFT',
          user: { login: 'bob' },
          created_at: '2025-01-02T00:00:00Z', updated_at: '2025-01-02T00:01:00Z',
          html_url: 'https://github.com/Org/Repo/pull/42#discussion_r2',
          in_reply_to_id: 1, original_line: 10, original_start_line: null,
        },
      ],
    });

    const client = new GitHubClient();
    const result = await client.getPrReviewComments('Org/Repo', 42);

    expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/comments', {
      params: { per_page: 100, page: 1 },
    });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(1);
    expect(result[0].author).toBe('alice');
    expect(result[0].side).toBe('RIGHT');
    expect(result[1].id).toBe(2);
    expect(result[1].author).toBe('bob');
    expect(result[1].side).toBe('LEFT');
    expect(result[1].startLine).toBe(15);
    expect(result[1].startSide).toBe('LEFT');
    expect(result[1].inReplyToId).toBe(1);
    expect(result[1].originalLine).toBe(10);
  });

  it('passes perPage and page params', async () => {
    http.get.mockResolvedValue({ data: [] });

    const client = new GitHubClient();
    await client.getPrReviewComments('Org/Repo', 42, { perPage: 50, page: 2 });

    expect(http.get).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/comments', {
      params: { per_page: 50, page: 2 },
    });
  });

  it('returns empty array for no comments', async () => {
    http.get.mockResolvedValue({ data: [] });

    const client = new GitHubClient();
    const result = await client.getPrReviewComments('Org/Repo', 42);
    expect(result).toEqual([]);
  });

  it('throws for invalid repo format', async () => {
    const client = new GitHubClient();
    await expect(client.getPrReviewComments('invalid', 1)).rejects.toThrow('Invalid repo format');
  });

  it('maps null user to "unknown"', async () => {
    http.get.mockResolvedValue({
      data: [
        {
          id: 1, path: 'f.ts', line: 1, body: '', commit_id: 'a',
          side: 'RIGHT', start_line: null, start_side: null,
          user: null,
          created_at: '', updated_at: '',
          html_url: '', in_reply_to_id: null, original_line: null, original_start_line: null,
        },
      ],
    });

    const client = new GitHubClient();
    const result = await client.getPrReviewComments('Org/Repo', 42);
    expect(result[0].author).toBe('unknown');
  });
});

describe('updatePrReviewComment', () => {
  it('calls PATCH /repos/{repo}/pulls/comments/{id} and returns mapped comment', async () => {
    http.patch.mockResolvedValue({
      data: {
        id: 1, path: 'src/file.ts', line: 42, body: 'Updated comment', commit_id: 'abc',
        side: 'RIGHT', start_line: null, start_side: null,
        user: { login: 'alice' },
        created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-02T00:00:00Z',
        html_url: 'https://github.com/Org/Repo/pull/42#discussion_r1',
        in_reply_to_id: null, original_line: null, original_start_line: null,
      },
    });

    const client = new GitHubClient();
    const result = await client.updatePrReviewComment('Org/Repo', 1, 'Updated comment');

    expect(http.patch).toHaveBeenCalledWith('/repos/Org/Repo/pulls/comments/1', { body: 'Updated comment' });
    expect(result.body).toBe('Updated comment');
    expect(result.id).toBe(1);
    expect(result.updatedAt).toBe('2025-01-02T00:00:00Z');
  });

  it('throws for invalid repo format', async () => {
    const client = new GitHubClient();
    await expect(client.updatePrReviewComment('invalid', 1, 'x')).rejects.toThrow('Invalid repo format');
    expect(http.patch).not.toHaveBeenCalled();
  });
});

describe('deletePrReviewComment', () => {
  it('calls DELETE /repos/{repo}/pulls/comments/{id} and returns void', async () => {
    http.delete.mockResolvedValue({ status: 204 });

    const client = new GitHubClient();
    await client.deletePrReviewComment('Org/Repo', 1);

    expect(http.delete).toHaveBeenCalledWith('/repos/Org/Repo/pulls/comments/1');
  });

  it('throws for invalid repo format', async () => {
    const client = new GitHubClient();
    await expect(client.deletePrReviewComment('invalid', 1)).rejects.toThrow('Invalid repo format');
    expect(http.delete).not.toHaveBeenCalled();
  });
});

describe('submitPrReview', () => {
  it('posts to /repos/{repo}/pulls/{number}/reviews and returns submitted review', async () => {
    http.post.mockResolvedValue({
      data: {
        id: 100,
        state: 'APPROVED',
        body: 'Looks good!',
        commit_id: 'abc123',
        html_url: 'https://github.com/Org/Repo/pull/42#pullrequestreview-100',
      },
    });

    const client = new GitHubClient();
    const result = await client.submitPrReview('Org/Repo', 42, {
      event: 'APPROVE',
      body: 'Looks good!',
    });

    expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/reviews', {
      event: 'APPROVE',
      body: 'Looks good!',
    });
    expect(result.id).toBe(100);
    expect(result.state).toBe('APPROVED');
    expect(result.body).toBe('Looks good!');
    expect(result.commitId).toBe('abc123');
  });

  it('includes comments array when provided', async () => {
    http.post.mockResolvedValue({
      data: {
        id: 101, state: 'COMMENT', body: 'Review with comments', commit_id: 'def456',
        html_url: '',
      },
    });

    const client = new GitHubClient();
    await client.submitPrReview('Org/Repo', 42, {
      event: 'COMMENT',
      body: 'Review with comments',
      comments: [
        { path: 'src/a.ts', body: 'Fix this', line: 10, commitId: 'def456' },
        { path: 'src/b.ts', body: 'And this', line: 20, commitId: 'def456', startLine: 18, side: 'LEFT' },
      ],
    });

    expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/reviews', {
      event: 'COMMENT',
      body: 'Review with comments',
      comments: [
        { path: 'src/a.ts', body: 'Fix this', line: 10, commit_id: 'def456' },
        { path: 'src/b.ts', body: 'And this', line: 20, commit_id: 'def456', start_line: 18, side: 'LEFT' },
      ],
    });
  });

  it('includes commitId when provided', async () => {
    http.post.mockResolvedValue({
      data: { id: 102, state: 'APPROVED', body: null, commit_id: 'fixed123', html_url: '' },
    });

    const client = new GitHubClient();
    await client.submitPrReview('Org/Repo', 42, {
      event: 'APPROVE',
      commitId: 'fixed123',
    });

    expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/reviews', {
      event: 'APPROVE',
      commit_id: 'fixed123',
    });
  });

  it('sends minimal valid body (event only)', async () => {
    http.post.mockResolvedValue({
      data: { id: 103, state: 'COMMENT', body: null, commit_id: '', html_url: '' },
    });

    const client = new GitHubClient();
    await client.submitPrReview('Org/Repo', 42, { event: 'COMMENT' });

    expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/reviews', {
      event: 'COMMENT',
    });
  });

  it('throws for invalid repo format', async () => {
    const client = new GitHubClient();
    await expect(client.submitPrReview('invalid', 1, { event: 'COMMENT' })).rejects.toThrow('Invalid repo format');
    expect(http.post).not.toHaveBeenCalled();
  });
});

describe('getReviewStatus regression', () => {
    it('returns APPROVED when a review is approved', async () => {
      http.get.mockResolvedValueOnce({ data: [{ state: 'APPROVED' }] });

      const client = new GitHubClient();
      const result = await (client as any).getReviewStatus('Org/Repo', 42);
      expect(result).toBe('APPROVED');
    });

    it('returns CHANGES_REQUESTED', async () => {
      http.get.mockResolvedValueOnce({ data: [{ state: 'CHANGES_REQUESTED' }] });

      const client = new GitHubClient();
      const result = await (client as any).getReviewStatus('Org/Repo', 42);
      expect(result).toBe('CHANGES_REQUESTED');
    });

    it('returns COMMENTED', async () => {
      http.get.mockResolvedValueOnce({ data: [{ state: 'COMMENTED' }] });

      const client = new GitHubClient();
      const result = await (client as any).getReviewStatus('Org/Repo', 42);
      expect(result).toBe('COMMENTED');
    });

    it('returns REVIEW_REQUIRED when only DISMISSED reviews exist', async () => {
      http.get.mockResolvedValueOnce({ data: [{ state: 'DISMISSED' }] });

      const client = new GitHubClient();
      const result = await (client as any).getReviewStatus('Org/Repo', 42);
      expect(result).toBe('REVIEW_REQUIRED');
    });

    it('returns APPROVED despite CHANGES_REQUESTED (APPROVED beats all)', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          { state: 'CHANGES_REQUESTED' },
          { state: 'APPROVED' },
        ],
      });

      const client = new GitHubClient();
      const result = await (client as any).getReviewStatus('Org/Repo', 42);
      expect(result).toBe('APPROVED');
    });

    it('returns CHANGES_REQUESTED over COMMENTED', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          { state: 'COMMENTED' },
          { state: 'CHANGES_REQUESTED' },
        ],
      });

      const client = new GitHubClient();
      const result = await (client as any).getReviewStatus('Org/Repo', 42);
      expect(result).toBe('CHANGES_REQUESTED');
    });
  });

  describe('graphql helper', () => {
    it('setPullRequestDraft succeeds via graphql (regression)', async () => {
      // Mock the REST call for node_id resolution
      http.get.mockResolvedValueOnce({ data: { node_id: 'PR_node1' } });
      // Mock the GraphQL POST
      http.post.mockResolvedValueOnce({ data: { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } } });
      // Mock the follow-up getPullRequest call
      http.get.mockResolvedValueOnce({ data: {
        number: 42, title: 'PR', body: null, state: 'open',
        html_url: '', user: { login: 'u' },
        created_at: '', updated_at: '', closed_at: null, merged_at: null,
        mergeable: null, merged_by: null,
        base: { ref: 'main' }, head: { ref: 'f', sha: 's' },
        changed_files: 1, additions: 1, deletions: 0,
      } });

      const client = new GitHubClient();
      const result = await client.setPullRequestDraft('Org/Repo', 42, true);

      expect(http.post).toHaveBeenCalledWith('/graphql', {
        query: expect.stringContaining('convertPullRequestToDraft'),
        variables: { id: 'PR_node1' },
      });
      expect(result.number).toBe(42);
    });

    it('throws on graphql errors array', async () => {
      http.get.mockResolvedValueOnce({ data: { node_id: 'PR_node1' } });
      http.post.mockResolvedValueOnce({ data: { errors: [{ message: 'Resource not accessible' }] } });

      const client = new GitHubClient();
      await expect(client.setPullRequestDraft('Org/Repo', 42, true)).rejects.toThrow('GitHub GraphQL error');
    });
  });

  describe('deletePrComment', () => {
    it('sends DELETE to the issues comments endpoint', async () => {
      http.delete.mockResolvedValueOnce({ data: {} });

      const client = new GitHubClient();
      await client.deletePrComment('Org/Repo', 123);

      expect(http.delete).toHaveBeenCalledWith('/repos/Org/Repo/issues/comments/123');
    });

    it('throws for invalid repo', async () => {
      const client = new GitHubClient();
      await expect(client.deletePrComment('invalid', 1)).rejects.toThrow('Invalid repo format');
    });
  });

  describe('mergePr', () => {
    it('sends PUT to the merge endpoint with default method', async () => {
      http.put.mockResolvedValueOnce({ data: { merged: true, message: 'Pull Request successfully merged', sha: 'abc' } });

      const client = new GitHubClient();
      const result = await client.mergePr('Org/Repo', 42);

      expect(http.put).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/merge', { merge_method: 'merge' });
      expect(result.merged).toBe(true);
      expect(result.sha).toBe('abc');
    });

    it('passes mergeMethod and sha', async () => {
      http.put.mockResolvedValueOnce({ data: { merged: true, message: 'Squashed', sha: 'def' } });

      const client = new GitHubClient();
      await client.mergePr('Org/Repo', 42, { mergeMethod: 'squash', sha: 'def' });

      expect(http.put).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/merge', { merge_method: 'squash', sha: 'def' });
    });

    it('throws 405 clearly', async () => {
      const axiosError = new Error('Request failed');
      (axiosError as any).isAxiosError = true;
      (axiosError as any).response = { status: 405, data: { message: 'Pull request is not mergeable' } };

      http.put.mockRejectedValueOnce(axiosError);

      const client = new GitHubClient();
      await expect(client.mergePr('Org/Repo', 42)).rejects.toThrow('not mergeable');
    });

    it('throws 409 clearly', async () => {
      const axiosError = new Error('Conflict');
      (axiosError as any).isAxiosError = true;
      (axiosError as any).response = { status: 409, data: { message: 'SHA does not match' } };

      http.put.mockRejectedValueOnce(axiosError);

      const client = new GitHubClient();
      await expect(client.mergePr('Org/Repo', 42)).rejects.toThrow('SHA mismatch');
    });
  });

  describe('requestReviewers / removeReviewers', () => {
    it('sends POST to requested_reviewers', async () => {
      http.post.mockResolvedValueOnce({ data: { requested_reviewers: [{ login: 'alice' }], requested_teams: [] } });

      const client = new GitHubClient();
      const result = await client.requestReviewers('Org/Repo', 42, ['alice']);

      expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/requested_reviewers', { reviewers: ['alice'] });
      expect(result.requestedReviewers).toEqual(['alice']);
    });

    it('sends DELETE to requested_reviewers', async () => {
      http.delete.mockResolvedValueOnce({ data: { requested_reviewers: [], requested_teams: [] } });

      const client = new GitHubClient();
      const result = await client.removeReviewers('Org/Repo', 42, ['alice']);

      expect(http.delete).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/requested_reviewers', {
        data: { reviewers: ['alice'] },
      });
      expect(result.requestedReviewers).toEqual([]);
    });
  });

  describe('updateLabels', () => {
    it('sends PUT to issues labels endpoint', async () => {
      http.put.mockResolvedValueOnce({ data: [{ name: 'bug' }, { name: 'frontend' }] });

      const client = new GitHubClient();
      const result = await client.updateLabels('Org/Repo', 42, ['bug', 'frontend']);

      expect(http.put).toHaveBeenCalledWith('/repos/Org/Repo/issues/42/labels', { labels: ['bug', 'frontend'] });
      expect(result).toEqual(['bug', 'frontend']);
    });
  });

  describe('updateAssignees', () => {
    it('sends POST to issues assignees endpoint', async () => {
      http.post.mockResolvedValueOnce({ data: { assignees: [{ login: 'alice' }] } });

      const client = new GitHubClient();
      const result = await client.updateAssignees('Org/Repo', 42, ['alice']);

      expect(http.post).toHaveBeenCalledWith('/repos/Org/Repo/issues/42/assignees', { assignees: ['alice'] });
      expect(result).toEqual(['alice']);
    });
  });

  describe('dismissPrReview', () => {
    it('sends PUT to dismissals endpoint', async () => {
      http.put.mockResolvedValueOnce({ data: {} });

      const client = new GitHubClient();
      const result = await client.dismissPrReview('Org/Repo', 42, 123, 'Addressed in follow-up');

      expect(http.put).toHaveBeenCalledWith('/repos/Org/Repo/pulls/42/reviews/123/dismissals', {
        message: 'Addressed in follow-up',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('getReviewThreads', () => {
    it('paginates through GraphQL review threads', async () => {
      http.post.mockResolvedValueOnce({
        data: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    { id: 't1', isResolved: false, isOutdated: false, path: 'a.ts', line: 10, originalLine: null },
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          },
        },
      });

      const client = new GitHubClient();
      const threads = await client.getReviewThreads('Org/Repo', 42);

      expect(http.post).toHaveBeenCalledWith('/graphql', {
        query: expect.stringContaining('reviewThreads'),
        variables: { owner: 'Org', name: 'Repo', prNumber: 42, cursor: null },
      });
      expect(threads).toHaveLength(1);
      expect(threads[0].id).toBe('t1');
      expect(threads[0].isResolved).toBe(false);
    });
  });

  describe('resolveReviewThread / unresolveReviewThread', () => {
    it('resolves a thread via GraphQL mutation', async () => {
      http.post.mockResolvedValueOnce({
        data: {
          data: {
            resolveReviewThread: { thread: { isResolved: true } },
          },
        },
      });

      const client = new GitHubClient();
      const result = await client.resolveReviewThread('Org/Repo', 'thread1');

      expect(http.post).toHaveBeenCalledWith('/graphql', {
        query: expect.stringContaining('resolveReviewThread'),
        variables: { threadId: 'thread1' },
      });
      expect(result.isResolved).toBe(true);
    });

    it('unresolves a thread via GraphQL mutation', async () => {
      http.post.mockResolvedValueOnce({
        data: {
          data: {
            unresolveReviewThread: { thread: { isResolved: false } },
          },
        },
      });

      const client = new GitHubClient();
      const result = await client.unresolveReviewThread('Org/Repo', 'thread1');

      expect(result.isResolved).toBe(false);
    });
  });
});
