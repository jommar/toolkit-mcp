import { vi, describe, it, expect, beforeEach } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../services/index.js', () => ({
  GitHubClient: class MockGitHubClient {},
}));

import {
  githubGetPrsHandler,
  githubCreatePrHandler,
  githubAddPrCommentHandler,
  githubGetPrCommentsHandler,
  githubUpdatePrCommentHandler,
  githubListBranchesHandler,
  githubGetPrDetailsHandler,
  githubGetPrReviewsHandler,
  githubGetPrChecksHandler,
  githubSearchPrsHandler,
  githubUpdatePrHandler,
  githubGetPrDetailsSchema,
  githubGetPrReviewsSchema,
  githubGetPrChecksSchema,
  githubSearchPrsSchema,
  githubUpdatePrSchema,
  githubCreatePrReviewCommentHandler,
  githubGetPrReviewCommentsHandler,
  githubUpdatePrReviewCommentHandler,
  githubDeletePrReviewCommentHandler,
  githubSubmitPrReviewHandler,
  githubCreatePrReviewCommentSchema,
  githubSubmitPrReviewSchema,
} from './module.js';

function makeMockGitHub() {
  return {
    searchPrs: vi.fn(),
    findPrsForIssueKeys: vi.fn(),
    searchPrsByBranchName: vi.fn(),
    createPullRequest: vi.fn(),
    addPrComment: vi.fn(),
    getPrComments: vi.fn(),
    updatePrComment: vi.fn(),
    listBranches: vi.fn(),
    getPullRequest: vi.fn(),
    getPullRequestReviews: vi.fn(),
    getPullRequestChecks: vi.fn(),
    searchPullRequestsByQuery: vi.fn(),
    updatePullRequest: vi.fn(),
    createPrReviewComment: vi.fn(),
    getPrReviewComments: vi.fn(),
    updatePrReviewComment: vi.fn(),
    deletePrReviewComment: vi.fn(),
    submitPrReview: vi.fn(),
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

describe('githubGetPrCommentsHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls getPrComments with correct args and returns paginated response', async () => {
    const comments = [
      { id: 1, htmlUrl: 'https://github.com/Org/Repo/pull/42#issuecomment-1', body: 'First!', user: 'alice', createdAt: '2025-01-01T00:00:00Z' },
      { id: 2, htmlUrl: 'https://github.com/Org/Repo/pull/42#issuecomment-2', body: 'Second', user: 'bob', createdAt: '2025-01-02T00:00:00Z' },
    ];
    mockGitHub.getPrComments.mockResolvedValue(comments);

    const handler = githubGetPrCommentsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    expect(mockGitHub.getPrComments).toHaveBeenCalledWith('Org/Repo', 42, {
      perPage: 20,
      page: 1,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(comments);
    expect(parsed.hasMore).toBe(false);
  });

  it('uses cursor as page number', async () => {
    mockGitHub.getPrComments.mockResolvedValue([]);

    const handler = githubGetPrCommentsHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', prNumber: 42, limit: 10, cursor: '2' });

    expect(mockGitHub.getPrComments).toHaveBeenCalledWith('Org/Repo', 42, {
      perPage: 10,
      page: 2,
    });
  });

  it('sets hasMore when result count equals limit', async () => {
    const comments = Array.from({ length: 20 }, (_, i) => ({
      id: i,
      htmlUrl: `https://github.com/Org/Repo/pull/42#issuecomment-${i}`,
      body: 'comment',
      user: 'user',
      createdAt: '2025-01-01T00:00:00Z',
    }));
    mockGitHub.getPrComments.mockResolvedValue(comments);

    const handler = githubGetPrCommentsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(20);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('2');
  });
});

describe('githubUpdatePrCommentHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls updatePrComment with correct args and returns updated comment', async () => {
    const updated = { id: 555, htmlUrl: 'https://github.com/Org/Repo/pull/42#issuecomment-555', body: 'Updated comment', user: 'alice', createdAt: '2025-01-01T00:00:00Z' };
    mockGitHub.updatePrComment.mockResolvedValue(updated);

    const handler = githubUpdatePrCommentHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', commentId: 555, body: 'Updated comment' });

    expect(mockGitHub.updatePrComment).toHaveBeenCalledWith('Org/Repo', 555, 'Updated comment');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(updated);
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

describe('githubUpdatePrHandler', () => {
  let mockGitHub: ReturnType<typeof makeMockGitHub>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls updatePullRequest with title update and returns result', async () => {
    const detail: Record<string, unknown> = {
      number: 42,
      title: 'Updated Title',
      body: 'Description',
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
      headBranch: 'feature',
      headSha: 'abc123',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
    };
    mockGitHub.updatePullRequest.mockResolvedValue(detail);

    const handler = githubUpdatePrHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      title: 'Updated Title',
    });

    expect(mockGitHub.updatePullRequest).toHaveBeenCalledWith('Org/Repo', 42, {
      title: 'Updated Title',
      body: undefined,
      state: undefined,
      base: undefined,
      maintainerCanModify: undefined,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(detail);
    expect(parsed.title).toBe('Updated Title');
  });

  it('calls updatePullRequest with state "closed"', async () => {
    const detail: Record<string, unknown> = {
      number: 42,
      title: 'Title',
      body: null,
      state: 'closed',
      htmlUrl: 'https://github.com/Org/Repo/pull/42',
      repo: 'Org/Repo',
      author: 'bob',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-02T00:00:00Z',
      closedAt: '2025-01-03T00:00:00Z',
      mergedAt: null,
      mergeable: null,
      mergedBy: null,
      baseBranch: 'main',
      headBranch: 'feature',
      headSha: 'abc123',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
    };
    mockGitHub.updatePullRequest.mockResolvedValue(detail);

    const handler = githubUpdatePrHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      state: 'closed',
    });

    expect(mockGitHub.updatePullRequest).toHaveBeenCalledWith('Org/Repo', 42, {
      title: undefined,
      body: undefined,
      state: 'closed',
      base: undefined,
      maintainerCanModify: undefined,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.state).toBe('closed');
  });

  it('calls updatePullRequest with maintainerCanModify and body', async () => {
    const detail: Record<string, unknown> = {
      number: 42,
      title: 'Title',
      body: 'Updated body',
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
      headBranch: 'feature',
      headSha: 'abc123',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
    };
    mockGitHub.updatePullRequest.mockResolvedValue(detail);

    const handler = githubUpdatePrHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      maintainerCanModify: true,
      body: 'Updated body',
    });

    expect(mockGitHub.updatePullRequest).toHaveBeenCalledWith('Org/Repo', 42, {
      title: undefined,
      body: 'Updated body',
      state: undefined,
      base: undefined,
      maintainerCanModify: true,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.body).toBe('Updated body');
  });

  it('rejects when no update fields are provided (schema validation)', () => {
    expect(() =>
      githubUpdatePrSchema.parse({ repo: 'Org/Repo', prNumber: 42 }),
    ).toThrow('At least one of title, body, state, base, or maintainerCanModify');
  });

  it('rejects invalid repo format (schema validation)', () => {
    expect(() =>
      githubUpdatePrSchema.parse({ repo: 'invalid', prNumber: 42, title: 'New Title' }),
    ).toThrow();
  });
});

describe('githubCreatePrReviewCommentHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls createPrReviewComment with correct args and returns comment', async () => {
    const comment = { id: 1, path: 'src/file.ts', line: 42, body: 'Nice', commitId: 'abc', side: 'RIGHT', startLine: null, startSide: null, author: 'alice', createdAt: '', updatedAt: '', htmlUrl: '', inReplyToId: null, originalLine: null, originalStartLine: null };
    mockGitHub.createPrReviewComment.mockResolvedValue(comment);

    const handler = githubCreatePrReviewCommentHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      path: 'src/file.ts',
      body: 'Nice',
      commitId: 'abc',
      line: 42,
      side: 'RIGHT',
    });

    expect(mockGitHub.createPrReviewComment).toHaveBeenCalledWith('Org/Repo', 42, {
      body: 'Nice',
      path: 'src/file.ts',
      commitId: 'abc',
      line: 42,
      side: 'RIGHT',
      startSide: undefined,
      startLine: undefined,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(comment);
  });

  it('wraps body with suggestion block when suggestedReplacement is provided', async () => {
    mockGitHub.createPrReviewComment.mockResolvedValue({} as any);

    const handler = githubCreatePrReviewCommentHandler({ github: mockGitHub as any });
    await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      path: 'src/file.ts',
      body: 'Use let instead of const',
      commitId: 'abc',
      line: 10,
      suggestedReplacement: 'let count = 0;',
    });

    const calledArg = mockGitHub.createPrReviewComment.mock.calls[0][2];
    expect(calledArg.body).toContain('```suggestion');
    expect(calledArg.body).toContain('let count = 0;');
    expect(calledArg.body).toContain('Use let instead of const');
  });

  it('uses only suggestion block when body is empty and suggestedReplacement is provided', async () => {
    mockGitHub.createPrReviewComment.mockResolvedValue({} as any);

    const handler = githubCreatePrReviewCommentHandler({ github: mockGitHub as any });
    await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      path: 'src/file.ts',
      body: '',
      commitId: 'abc',
      line: 10,
      suggestedReplacement: 'let count = 0;',
    });

    const calledArg = mockGitHub.createPrReviewComment.mock.calls[0][2];
    expect(calledArg.body).toBe('```suggestion\nlet count = 0;\n```');
  });

  it('passes startLine to the client', async () => {
    mockGitHub.createPrReviewComment.mockResolvedValue({} as any);

    const handler = githubCreatePrReviewCommentHandler({ github: mockGitHub as any });
    await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      path: 'src/file.ts',
      body: 'Multi-line comment',
      commitId: 'abc',
      line: 50,
      startLine: 45,
    });

    const calledArg = mockGitHub.createPrReviewComment.mock.calls[0][2];
    expect(calledArg.startLine).toBe(45);
  });

  it('rejects when startLine >= line (Zod validation)', () => {
    expect(() =>
      githubCreatePrReviewCommentSchema.parse({
        repo: 'Org/Repo',
        prNumber: 42,
        path: 'src/file.ts',
        body: 'Bad range',
        commitId: 'abc',
        line: 10,
        startLine: 20,
      }),
    ).toThrow('startLine must be less than line');
  });

  it('rejects when startSide is provided without startLine', () => {
    expect(() =>
      githubCreatePrReviewCommentSchema.parse({
        repo: 'Org/Repo',
        prNumber: 42,
        path: 'src/file.ts',
        body: 'No startLine',
        commitId: 'abc',
        line: 10,
        startSide: 'LEFT',
      }),
    ).toThrow('startSide requires startLine');
  });
});

describe('githubGetPrReviewCommentsHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns paginated PrReviewComment list', async () => {
    const comments = [
      { id: 1, path: 'a.ts', line: 10, body: 'Nice', commitId: 'a', side: 'RIGHT', startLine: null, startSide: null, author: 'alice', createdAt: '', updatedAt: '', htmlUrl: '', inReplyToId: null, originalLine: null, originalStartLine: null },
    ];
    mockGitHub.getPrReviewComments.mockResolvedValue(comments);

    const handler = githubGetPrReviewCommentsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    expect(mockGitHub.getPrReviewComments).toHaveBeenCalledWith('Org/Repo', 42, { perPage: 20, page: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(comments);
    expect(parsed.hasMore).toBe(false);
  });

  it('uses cursor as page number', async () => {
    mockGitHub.getPrReviewComments.mockResolvedValue([]);

    const handler = githubGetPrReviewCommentsHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', prNumber: 42, limit: 10, cursor: '3' });

    expect(mockGitHub.getPrReviewComments).toHaveBeenCalledWith('Org/Repo', 42, { perPage: 10, page: 3 });
  });

  it('sets hasMore when result count equals limit', async () => {
    const comments = Array.from({ length: 20 }, (_, i) => ({
      id: i, path: 'f.ts', line: i, body: 'c', commitId: 'a', side: 'RIGHT' as const,
      startLine: null, startSide: null, author: 'u', createdAt: '', updatedAt: '', htmlUrl: '',
      inReplyToId: null, originalLine: null, originalStartLine: null,
    }));
    mockGitHub.getPrReviewComments.mockResolvedValue(comments);

    const handler = githubGetPrReviewCommentsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('2');
  });
});

describe('githubUpdatePrReviewCommentHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls updatePrReviewComment and returns updated comment', async () => {
    const updated = { id: 1, path: 'f.ts', line: 10, body: 'Updated', commitId: 'a', side: 'RIGHT', startLine: null, startSide: null, author: 'alice', createdAt: '', updatedAt: '', htmlUrl: '', inReplyToId: null, originalLine: null, originalStartLine: null };
    mockGitHub.updatePrReviewComment.mockResolvedValue(updated);

    const handler = githubUpdatePrReviewCommentHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', commentId: 1, body: 'Updated' });

    expect(mockGitHub.updatePrReviewComment).toHaveBeenCalledWith('Org/Repo', 1, 'Updated');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(updated);
  });
});

describe('githubDeletePrReviewCommentHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls deletePrReviewComment and returns success message', async () => {
    mockGitHub.deletePrReviewComment.mockResolvedValue(undefined);

    const handler = githubDeletePrReviewCommentHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', commentId: 1 });

    expect(mockGitHub.deletePrReviewComment).toHaveBeenCalledWith('Org/Repo', 1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe('Review comment deleted');
  });
});

describe('githubSubmitPrReviewHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('calls submitPrReview with APPROVE and returns result', async () => {
    const submitted = { id: 100, state: 'APPROVED', body: 'LGTM', commitId: 'abc', htmlUrl: '' };
    mockGitHub.submitPrReview.mockResolvedValue(submitted);

    const handler = githubSubmitPrReviewHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      event: 'APPROVE',
      body: 'LGTM',
    });

    expect(mockGitHub.submitPrReview).toHaveBeenCalledWith('Org/Repo', 42, {
      body: 'LGTM',
      event: 'APPROVE',
      comments: undefined,
      commitId: undefined,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(submitted);
  });

  it('passes comments array through', async () => {
    mockGitHub.submitPrReview.mockResolvedValue({} as any);

    const handler = githubSubmitPrReviewHandler({ github: mockGitHub as any });
    await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', body: 'Fix this', line: 10 }],
    });

    expect(mockGitHub.submitPrReview).toHaveBeenCalledWith('Org/Repo', 42, {
      body: undefined,
      event: 'COMMENT',
      comments: [{ path: 'src/a.ts', body: 'Fix this', line: 10 }],
      commitId: undefined,
    });
  });

  it('rejects invalid event enum', () => {
    expect(() =>
      githubSubmitPrReviewSchema.parse({
        repo: 'Org/Repo',
        prNumber: 42,
        event: 'INVALID',
      }),
    ).toThrow();
  });
});
