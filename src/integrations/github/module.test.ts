import { vi, describe, it, expect, beforeEach } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../services/index.js', () => ({
  GitHubClient: class MockGitHubClient {},
}));

import {
  githubGetPrsHandler,
  githubCreatePrHandler,
  githubAddPrCommentHandler,
  githubListBranchesHandler,
  githubGetPrDetailsHandler,
  githubGetPrReviewsHandler,
  githubGetPrChecksHandler,
  githubSearchPrsHandler,
  githubGetPrDetailsSchema,
  githubGetPrReviewsSchema,
  githubGetPrChecksSchema,
  githubSearchPrsSchema,
} from './module.js';

function makeMockGitHub() {
  return {
    searchPrs: vi.fn(),
    findPrsForIssueKeys: vi.fn(),
    searchPrsByBranchName: vi.fn(),
    createPullRequest: vi.fn(),
    addPrComment: vi.fn(),
    listBranches: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestReviews: vi.fn(),
    getPullRequestChecks: vi.fn(),
    searchPullRequestsByQuery: vi.fn(),
  };
}

type MockGitHub = ReturnType<typeof makeMockGitHub>;

describe('githubGetPrsHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns PRs for a single issueKey', async () => {
    const prs = [
      { number: 42, title: 'Fix bug', repo: 'Org/Repo', state: 'open' as const },
    ];
    mockGitHub.searchPrs.mockResolvedValue(prs);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ issueKey: 'TRIPS-1267' });

    expect(mockGitHub.searchPrs).toHaveBeenCalledWith('TRIPS-1267', undefined, 'open');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(prs);
    expect(parsed.hasMore).toBe(false);
  });

  it('returns PRs for multiple keys', async () => {
    const grouped = new Map<string, any[]>();
    grouped.set('TRIPS-1', [
      { number: 1, title: 'PR 1', repo: 'Org/A', state: 'open' as const },
    ]);
    grouped.set('TRIPS-2', [
      { number: 2, title: 'PR 2', repo: 'Org/B', state: 'open' as const },
    ]);
    mockGitHub.findPrsForIssueKeys.mockResolvedValue(grouped);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ keys: ['TRIPS-1', 'TRIPS-2'] });

    expect(mockGitHub.findPrsForIssueKeys).toHaveBeenCalledWith(
      ['TRIPS-1', 'TRIPS-2'],
      'open',
    );
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0].title).toBe('PR 1');
    expect(parsed.items[1].title).toBe('PR 2');
  });

  it('respects limit parameter', async () => {
    const prs = Array.from({ length: 10 }, (_, i) => ({
      number: i,
      title: `PR ${i}`,
      repo: 'Org/Repo',
      state: 'open' as const,
    }));
    mockGitHub.searchPrs.mockResolvedValue(prs);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ issueKey: 'TRIPS-1', limit: 3 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(3);
  });

  it('throws when neither issueKey nor keys provided', async () => {
    const handler = githubGetPrsHandler({ github: mockGitHub as any });

    await expect(handler({})).rejects.toThrow(McpError);
    await expect(handler({})).rejects.toThrow(
      'Provide either issueKey or keys',
    );
  });

  it('throws when keys is an empty array', async () => {
    const handler = githubGetPrsHandler({ github: mockGitHub as any });

    await expect(handler({ keys: [] })).rejects.toThrow(McpError);
    await expect(handler({ keys: [] })).rejects.toThrow(
      'Provide either issueKey or keys',
    );
  });

  it('merges branch-name results when searchBranches is true', async () => {
    mockGitHub.searchPrs.mockResolvedValue([
      { number: 1, title: 'PR 1', repo: 'Org/A', state: 'open' as const, htmlUrl: 'url1' },
    ]);
    const branchMap = new Map<string, any[]>();
    branchMap.set('TRIPS-1', [
      { number: 2, title: 'PR 2', repo: 'Org/B', state: 'open' as const, htmlUrl: 'url2' },
    ]);
    mockGitHub.searchPrsByBranchName.mockResolvedValue(branchMap);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ issueKey: 'TRIPS-1', searchBranches: true });

    expect(mockGitHub.searchPrsByBranchName).toHaveBeenCalledWith('TRIPS-1', 'open');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(2);
  });

  it('deduplicates when searchBranches returns overlapping results', async () => {
    mockGitHub.searchPrs.mockResolvedValue([
      { number: 1, title: 'PR 1', repo: 'Org/A', state: 'open' as const, htmlUrl: 'url1' },
    ]);
    const branchMap = new Map<string, any[]>();
    branchMap.set('TRIPS-1', [
      { number: 1, title: 'PR 1', repo: 'Org/A', state: 'open' as const, htmlUrl: 'url1' },
    ]);
    mockGitHub.searchPrsByBranchName.mockResolvedValue(branchMap);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ issueKey: 'TRIPS-1', searchBranches: true });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(1);
  });
});

describe('githubCreatePrHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls createPullRequest with correct args and returns created PR', async () => {
    const created = { number: 42, htmlUrl: 'https://github.com/Org/Repo/pull/42', state: 'open' };
    mockGitHub.createPullRequest.mockResolvedValue(created);

    const handler = githubCreatePrHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      title: 'My PR',
      head: 'feature-branch',
      base: 'main',
      body: 'Description',
      draft: false,
    });

    expect(mockGitHub.createPullRequest).toHaveBeenCalledWith({
      repo: 'Org/Repo',
      title: 'My PR',
      head: 'feature-branch',
      base: 'main',
      body: 'Description',
      draft: false,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(created);
  });
});

describe('githubAddPrCommentHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls addPrComment with correct args and returns the created comment', async () => {
    const comment = { id: 555, htmlUrl: 'https://github.com/Org/Repo/pull/42#issuecomment-555', body: 'Looks good' };
    mockGitHub.addPrComment.mockResolvedValue(comment);

    const handler = githubAddPrCommentHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, body: 'Looks good' });

    expect(mockGitHub.addPrComment).toHaveBeenCalledWith({ repo: 'Org/Repo', prNumber: 42, body: 'Looks good' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(comment);
  });
});

describe('githubListBranchesHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls listBranches and returns paginated response', async () => {
    const branches = [
      { name: 'main', sha: 'abc123', protected: true },
      { name: 'develop', sha: 'def456', protected: false },
    ];
    mockGitHub.listBranches.mockResolvedValue(branches);

    const handler = githubListBranchesHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      limit: 20,
    });

    expect(mockGitHub.listBranches).toHaveBeenCalledWith('Org/Repo', {
      perPage: 20,
      page: 1,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(branches);
    expect(parsed.hasMore).toBe(false);
  });

  it('uses cursor as page number', async () => {
    mockGitHub.listBranches.mockResolvedValue([]);

    const handler = githubListBranchesHandler({ github: mockGitHub as any });
    await handler({
      repo: 'Org/Repo',
      limit: 10,
      cursor: '2',
    });

    expect(mockGitHub.listBranches).toHaveBeenCalledWith('Org/Repo', {
      perPage: 10,
      page: 2,
    });
  });

  it('sets hasMore when result count equals limit', async () => {
    const branches = Array.from({ length: 20 }, (_, i) => ({
      name: `branch-${i}`,
      sha: 'sha',
      protected: false,
    }));
    mockGitHub.listBranches.mockResolvedValue(branches);

    const handler = githubListBranchesHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      limit: 20,
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(20);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('2');
  });
});

describe('githubGetPrDetailsHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns PR detail for a given repo and prNumber', async () => {
    const detail: Record<string, unknown> = {
      number: 42,
      title: 'Fix the thing',
      body: 'This PR fixes the thing',
      state: 'open',
      htmlUrl: 'https://github.com/Org/Repo/pull/42',
      repo: 'Org/Repo',
      author: 'alice',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-02T00:00:00Z',
      closedAt: null,
      mergedAt: null,
      mergeable: true,
      mergedBy: null,
      baseBranch: 'main',
      headBranch: 'fix-thing',
      headSha: 'abc123',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
    };
    mockGitHub.getPullRequest.mockResolvedValue(detail);

    const handler = githubGetPrDetailsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42 });

    expect(mockGitHub.getPullRequest).toHaveBeenCalledWith('Org/Repo', 42);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(detail);
    expect(parsed.number).toBe(42);
    expect(parsed.title).toBe('Fix the thing');
  });

  it('rejects invalid repo format (schema validation)', async () => {
    expect(() => githubGetPrDetailsSchema.parse({ repo: 'invalid', prNumber: 42 })).toThrow();
  });
});

describe('githubGetPrReviewsHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns reviews array for a given repo and prNumber', async () => {
    const reviews: Record<string, unknown>[] = [
      { id: 1, user: 'bob', state: 'APPROVED', body: 'LGTM', submittedAt: '2025-01-01T12:00:00Z', commitId: 'abc' },
      { id: 2, user: 'carol', state: 'COMMENTED', body: 'Looks good', submittedAt: '2025-01-01T13:00:00Z', commitId: 'def' },
    ];
    mockGitHub.getPullRequestReviews.mockResolvedValue(reviews);

    const handler = githubGetPrReviewsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42 });

    expect(mockGitHub.getPullRequestReviews).toHaveBeenCalledWith('Org/Repo', 42);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(reviews);
    expect(parsed).toHaveLength(2);
  });

  it('returns empty array when there are no reviews', async () => {
    mockGitHub.getPullRequestReviews.mockResolvedValue([]);

    const handler = githubGetPrReviewsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual([]);
  });
});

describe('githubGetPrChecksHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns checks object with totalCount and checkRuns', async () => {
    const checks: Record<string, unknown> = {
      totalCount: 3,
      checkRuns: [
        { name: 'CI / Build', status: 'completed', conclusion: 'success', htmlUrl: 'https://github.com/Org/Repo/actions/runs/1', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:05:00Z' },
        { name: 'Lint', status: 'completed', conclusion: 'success', htmlUrl: 'https://github.com/Org/Repo/actions/runs/2', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:03:00Z' },
        { name: 'Test', status: 'completed', conclusion: 'failure', htmlUrl: 'https://github.com/Org/Repo/actions/runs/3', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:06:00Z' },
      ],
    };
    mockGitHub.getPullRequestChecks.mockResolvedValue(checks);

    const handler = githubGetPrChecksHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42 });

    expect(mockGitHub.getPullRequestChecks).toHaveBeenCalledWith('Org/Repo', 42);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalCount).toBe(3);
    expect(parsed.checkRuns).toHaveLength(3);
    expect(parsed.checkRuns[0].name).toBe('CI / Build');
  });

  it('returns empty checks when there are no check runs', async () => {
    const emptyChecks: Record<string, unknown> = { totalCount: 0, checkRuns: [] };
    mockGitHub.getPullRequestChecks.mockResolvedValue(emptyChecks);

    const handler = githubGetPrChecksHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.totalCount).toBe(0);
    expect(parsed.checkRuns).toEqual([]);
  });
});

describe('githubSearchPrsHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('searches by author', async () => {
    const prs: Record<string, unknown>[] = [
      { number: 1, title: 'PR 1', state: 'open', repo: 'Org/Repo', author: 'alice', createdAt: '2025-01-01T00:00:00Z', htmlUrl: 'https://github.com/Org/Repo/pull/1', reviewStatus: 'APPROVED' },
    ];
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue(prs);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    const result = await handler({ author: 'alice', state: 'open', limit: 20 });

    expect(mockGitHub.searchPullRequestsByQuery).toHaveBeenCalledWith({
      query: undefined,
      author: 'alice',
      repo: undefined,
      state: 'open',
      perPage: 20,
      page: 1,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(prs);
  });

  it('searches by repo', async () => {
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue([]);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', state: 'open', limit: 20 });

    expect(mockGitHub.searchPullRequestsByQuery).toHaveBeenCalledWith({
      query: undefined,
      author: undefined,
      repo: 'Org/Repo',
      state: 'open',
      perPage: 20,
      page: 1,
    });
  });

  it('searches by free-text query', async () => {
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue([]);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    await handler({ query: 'bugfix', state: 'open', limit: 20 });

    expect(mockGitHub.searchPullRequestsByQuery).toHaveBeenCalledWith({
      query: 'bugfix',
      author: undefined,
      repo: undefined,
      state: 'open',
      perPage: 20,
      page: 1,
    });
  });

  it('returns paginated response when result count equals limit', async () => {
    const prs = Array.from({ length: 20 }, (_, i) => ({
      number: i,
      title: `PR ${i}`,
      state: 'open' as const,
      repo: 'Org/Repo',
      author: 'alice',
      createdAt: '2025-01-01T00:00:00Z',
      htmlUrl: `https://github.com/Org/Repo/pull/${i}`,
      reviewStatus: 'APPROVED' as const,
    }));
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue(prs);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    const result = await handler({ author: 'alice', state: 'open', limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(20);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('2');
  });

  it('returns non-paginated response when result count is below limit', async () => {
    const prs = Array.from({ length: 3 }, (_, i) => ({
      number: i,
      title: `PR ${i}`,
      state: 'open' as const,
      repo: 'Org/Repo',
      author: 'alice',
      createdAt: '2025-01-01T00:00:00Z',
      htmlUrl: `https://github.com/Org/Repo/pull/${i}`,
      reviewStatus: 'APPROVED' as const,
    }));
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue(prs);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    const result = await handler({ author: 'alice', state: 'open', limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(3);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPageToken).toBeUndefined();
  });

  it('uses cursor as page number', async () => {
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue([]);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    await handler({ author: 'alice', state: 'open', limit: 10, cursor: '2' });

    expect(mockGitHub.searchPullRequestsByQuery).toHaveBeenCalledWith({
      query: undefined,
      author: 'alice',
      repo: undefined,
      state: 'open',
      perPage: 10,
      page: 2,
    });
  });
});
