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
  };
});

interface MockAxiosInstance {
  get: Mock;
  post: Mock;
  put: Mock;
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
      http.get.mockResolvedValueOnce({
        data: [
          {
            number: 101,
            title: 'Feature for TRIPS-42',
            state: 'open',
            pull_request: {},
            repository_url: 'https://api.github.com/repos/TransActComm/TravelTracker',
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

    it('throws when no filter is provided', async () => {
      const client = new GitHubClient();
      await expect(client.searchPullRequestsByQuery({})).rejects.toThrow('At least one');
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
});
