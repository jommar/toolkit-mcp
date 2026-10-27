import { vi, describe, it, expect, beforeEach } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../../services/index.js', () => ({
  GitHubClient: class MockGitHubClient {},
  ISSUE_KEY_PATTERN: /^[A-Z][A-Z0-9]{0,10}-\d{1,6}$/i,
}));

import {
  githubGetCopilotUnresolvedPrsHandler,
  githubGetCopilotUnresolvedPrsSchema,
  githubGetPrsSchema,
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
  githubGetPrFilesHandler,
  githubGetPrFilesSchema,
  githubGetPrCommitsHandler,
  githubGetPrCommitsSchema,
  githubGetFileContentsHandler,
  githubGetFileContentsSchema,
  githubGetPrReviewThreadsHandler,
  githubGetPrReviewThreadsSchema,
  githubResolveReviewThreadHandler,
  githubResolveReviewThreadSchema,
  githubUnresolveReviewThreadHandler,
  githubUnresolveReviewThreadSchema,
  githubDeletePrIssueCommentHandler,
  githubDeletePrIssueCommentSchema,
  githubMergePrHandler,
  githubMergePrSchema,
  githubRequestPrReviewersHandler,
  githubRequestPrReviewersSchema,
  githubUpdatePrLabelsHandler,
  githubUpdatePrLabelsSchema,
  githubUpdatePrAssigneesHandler,
  githubUpdatePrAssigneesSchema,
  githubDismissPrReviewHandler,
  githubDismissPrReviewSchema,
  githubGetCodeReviewReadyHandler,
  githubGetCodeReviewReadySchema,
} from './module.js';

function makeMockGitHub() {
  return {
    getCopilotUnresolvedPrs: vi.fn(),
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
    isPrApprovedByHuman: vi.fn(),
    getPullRequestChecks: vi.fn(),
    searchPullRequestsByQuery: vi.fn(),
    updatePullRequest: vi.fn(),
    setPullRequestDraft: vi.fn(),
    createPrReviewComment: vi.fn(),
    replyToPrReviewComment: vi.fn(),
    getPrReviewComments: vi.fn(),
    updatePrReviewComment: vi.fn(),
    deletePrReviewComment: vi.fn(),
    submitPrReview: vi.fn(),
    getPrFiles: vi.fn(),
    getPrCommits: vi.fn(),
    getFileContents: vi.fn(),
    getReviewThreads: vi.fn(),
    resolveReviewThread: vi.fn(),
    unresolveReviewThread: vi.fn(),
    deletePrComment: vi.fn(),
    mergePr: vi.fn(),
    requestReviewers: vi.fn(),
    updateLabels: vi.fn(),
    updateAssignees: vi.fn(),
    dismissPrReview: vi.fn(),
  };
}

type MockGitHub = ReturnType<typeof makeMockGitHub>;

describe('githubGetCopilotUnresolvedPrsHandler', () => {
  it.each([
    { prNumbers: [] },
    { prNumbers: [42, 7, 42] },
  ])('forwards selection and continuation unchanged: %j', async ({ prNumbers }) => {
    const mockGitHub = makeMockGitHub();
    mockGitHub.getCopilotUnresolvedPrs.mockResolvedValue({
      items: [], hasMore: true, nextPageToken: 'next_opaque-token',
    });
    const args = githubGetCopilotUnresolvedPrsSchema.parse({
      repo: 'Org/Repo', prNumbers, state: 'all', limit: 2, cursor: 'previous_opaque-token',
    });

    const result = await githubGetCopilotUnresolvedPrsHandler({ github: mockGitHub as any })(args);

    expect(mockGitHub.getCopilotUnresolvedPrs).toHaveBeenCalledExactlyOnceWith({
      repo: 'Org/Repo', prNumbers, state: 'all', limit: 2, cursor: 'previous_opaque-token',
    });
    expect(result).toEqual({ content: [{
      type: 'text', text: '{"items":[],"hasMore":true,"nextPageToken":"next_opaque-token"}',
    }] });
  });

  it('preserves successful PR comments and compact per-PR errors', async () => {
    const mockGitHub = makeMockGitHub();
    mockGitHub.getCopilotUnresolvedPrs.mockResolvedValue({
      items: [{ repo: 'Org/Repo', prNumber: 42, comments: ['Handle the empty response.'] }], hasMore: false, nextPageToken: undefined,
      errors: [{ repo: 'Org/Repo', prNumber: 7, error: 'Unable to inspect review threads.' }],
    });

    const result = await githubGetCopilotUnresolvedPrsHandler({ github: mockGitHub as any })({ repo: 'Org/Repo' });

    expect(result).toEqual({ content: [{
      type: 'text',
      text: '{"items":[{"repo":"Org/Repo","prNumber":42,"comments":["Handle the empty response."]}],"hasMore":false,"errors":[{"repo":"Org/Repo","prNumber":7,"error":"Unable to inspect review threads."}]}',
    }] });
  });

  it('propagates call-level discovery and cursor failures', async () => {
    const mockGitHub = makeMockGitHub();
    const handler = githubGetCopilotUnresolvedPrsHandler({ github: mockGitHub as any });
    mockGitHub.getCopilotUnresolvedPrs.mockRejectedValueOnce(new Error('Unable to identify authenticated viewer.'));
    await expect(handler({ repo: 'Org/Repo' })).rejects.toThrow('Unable to identify authenticated viewer.');
    mockGitHub.getCopilotUnresolvedPrs.mockRejectedValueOnce(new Error('Invalid cursor.'));
    await expect(handler(githubGetCopilotUnresolvedPrsSchema.parse({
      repo: 'Org/Repo', cursor: 'invalid_scope',
    }))).rejects.toThrow('Invalid cursor.');
  });

  it('delegates omitted selection and retains every unresolved Copilot comment body', async () => {
    const mockGitHub = makeMockGitHub();
    mockGitHub.getCopilotUnresolvedPrs.mockResolvedValue({
      items: [{ repo: 'Org/Repo', prNumber: 42, comments: [
        'Handle the empty response before reading its first item.',
        'Use a bounded retry:\n```suggestion\nretry({ attempts: 3 });\n```',
      ] }], hasMore: false,
    });

    const result = await githubGetCopilotUnresolvedPrsHandler({ github: mockGitHub as any })({ repo: 'Org/Repo' });

    expect(mockGitHub.getCopilotUnresolvedPrs).toHaveBeenCalledExactlyOnceWith({ repo: 'Org/Repo' });
    expect(result).toEqual({ content: [{
      type: 'text', text: '{"items":[{"repo":"Org/Repo","prNumber":42,"comments":["Handle the empty response before reading its first item.","Use a bounded retry:\\n```suggestion\\nretry({ attempts: 3 });\\n```"]}],"hasMore":false}',
    }] });
  });
});

describe('githubGetCopilotUnresolvedPrsSchema', () => {
  it('accepts numeric boundaries and service envelope cursors longer than legacy page tokens', () => {
    const cursor = Buffer.from(JSON.stringify({
      scope: 'a'.repeat(64), position: 'Y3Vyc29yOnYyOpHOAA==', viewer: 'octocat',
    })).toString('base64url');
    expect(cursor.length).toBeGreaterThan(50);
    expect(githubGetCopilotUnresolvedPrsSchema.parse({
      repo: 'Org/Repo', prNumbers: [1, 2147483647], state: 'all', limit: 100, cursor,
    })).toEqual({ repo: 'Org/Repo', prNumbers: [1, 2147483647], state: 'all', limit: 100, cursor });
  });

  it.each([
    {}, { repo: 'Repo' }, { repo: 'Org/Repo/Extra' },
    { repo: 'Org/Repo', prNumbers: [0] }, { repo: 'Org/Repo', prNumbers: [-1] },
    { repo: 'Org/Repo', prNumbers: [1.5] }, { repo: 'Org/Repo', prNumbers: [2147483648] },
    { repo: 'Org/Repo', prNumbers: ['42'] }, { repo: 'Org/Repo', prNumbers: null },
    { repo: 'Org/Repo', limit: 0 }, { repo: 'Org/Repo', limit: 101 },
    { repo: 'Org/Repo', limit: 1.5 }, { repo: 'Org/Repo', limit: '20' },
    { repo: 'Org/Repo', state: 'merged' }, { repo: 'Org/Repo', state: null },
    { repo: 'Org/Repo', cursor: '' }, { repo: 'Org/Repo', cursor: 'a b' },
    { repo: 'Org/Repo', cursor: 'abc=' }, { repo: 'Org/Repo', cursor: 1 },
  ])('rejects invalid input %j', (args) => {
    expect(githubGetCopilotUnresolvedPrsSchema.safeParse(args).success).toBe(false);
  });

  it('preserves omitted, empty and explicit selections with discovery defaults', () => {
    expect(githubGetCopilotUnresolvedPrsSchema.parse({ repo: 'Org/Repo' })).toEqual({
      repo: 'Org/Repo', state: 'open', limit: 20,
    });
    expect(githubGetCopilotUnresolvedPrsSchema.parse({ repo: 'Org/Repo', prNumbers: [] })).toEqual({
      repo: 'Org/Repo', prNumbers: [], state: 'open', limit: 20,
    });
    expect(githubGetCopilotUnresolvedPrsSchema.parse({
      repo: 'Org/Repo', prNumbers: [42, 7, 42], state: 'closed', limit: 1, cursor: 'eyJzY29wZSI6InRlc3QifQ',
    })).toEqual({
      repo: 'Org/Repo', prNumbers: [42, 7, 42], state: 'closed', limit: 1, cursor: 'eyJzY29wZSI6InRlc3QifQ',
    });
  });
});

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
    const result = await handler({ issueKey: 'TAP-1267' });

    expect(mockGitHub.searchPrs).toHaveBeenCalledWith('TAP-1267', 20, 'open');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(prs);
    expect(parsed.hasMore).toBe(false);
  });

  it('returns PRs for multiple keys', async () => {
    const grouped = new Map<string, any[]>();
    grouped.set('TAP-1', [
      { number: 1, title: 'PR 1', repo: 'Org/A', state: 'open' as const },
    ]);
    grouped.set('TAP-2', [
      { number: 2, title: 'PR 2', repo: 'Org/B', state: 'open' as const },
    ]);
    mockGitHub.findPrsForIssueKeys.mockResolvedValue(grouped);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ keys: ['TAP-1', 'TAP-2'] });

    expect(mockGitHub.findPrsForIssueKeys).toHaveBeenCalledWith(
      ['TAP-1', 'TAP-2'],
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
    const result = await handler({ issueKey: 'TAP-1', limit: 3 });

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

  it('rejects more than 20 keys via schema validation (M3)', () => {
    const manyKeys = Array.from({ length: 21 }, (_, i) => `TAP-${i}`);
    expect(() => githubGetPrsSchema.parse({ keys: manyKeys })).toThrow();
    // 20 keys should pass
    const twentyKeys = Array.from({ length: 20 }, (_, i) => `TAP-${i}`);
    expect(() => githubGetPrsSchema.parse({ keys: twentyKeys })).not.toThrow();
  });

  it('merges branch-name results when searchBranches is true', async () => {
    mockGitHub.searchPrs.mockResolvedValue([
      { number: 1, title: 'PR 1', repo: 'Org/A', state: 'open' as const, htmlUrl: 'url1' },
    ]);
    const branchMap = new Map<string, any[]>();
    branchMap.set('TAP-1', [
      { number: 2, title: 'PR 2', repo: 'Org/B', state: 'open' as const, htmlUrl: 'url2' },
    ]);
    mockGitHub.searchPrsByBranchName.mockResolvedValue(branchMap);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ issueKey: 'TAP-1', searchBranches: true });

    expect(mockGitHub.searchPrsByBranchName).toHaveBeenCalledWith('TAP-1', 'open');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(2);
  });

  it('deduplicates when searchBranches returns overlapping results', async () => {
    mockGitHub.searchPrs.mockResolvedValue([
      { number: 1, title: 'PR 1', repo: 'Org/A', state: 'open' as const, htmlUrl: 'url1' },
    ]);
    const branchMap = new Map<string, any[]>();
    branchMap.set('TAP-1', [
      { number: 1, title: 'PR 1', repo: 'Org/A', state: 'open' as const, htmlUrl: 'url1' },
    ]);
    mockGitHub.searchPrsByBranchName.mockResolvedValue(branchMap);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ issueKey: 'TAP-1', searchBranches: true });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(1);
  });

  it('passes limit as maxResults to searchPrs (H3)', async () => {
    mockGitHub.searchPrs.mockResolvedValue([]);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    await handler({ issueKey: 'TAP-1', limit: 10 });

    expect(mockGitHub.searchPrs).toHaveBeenCalledWith('TAP-1', 10, 'open');
  });

  it('uses cursor as offset (C3)', async () => {
    const allPrs = Array.from({ length: 50 }, (_, i) => ({
      number: i, title: `PR ${i}`, repo: 'Org/Repo', state: 'open' as const,
      htmlUrl: `url${i}`,
    }));
    mockGitHub.searchPrs.mockResolvedValue(allPrs);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ issueKey: 'TAP-1', limit: 10, cursor: '20' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(10);
    expect(parsed.items[0].number).toBe(20);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('30');
  });

  it('returns hasMore false when cursor offset exceeds results', async () => {
    mockGitHub.searchPrs.mockResolvedValue([]);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ issueKey: 'TAP-1', limit: 10, cursor: '0' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(0);
    expect(parsed.hasMore).toBe(false);
  });

  it('rejects invalid cursor (M9)', async () => {
    const handler = githubGetPrsHandler({ github: mockGitHub as any });

    await expect(handler({ issueKey: 'TAP-1', cursor: 'abc' })).rejects.toThrow(McpError);
    await expect(handler({ issueKey: 'TAP-1', cursor: '-1' })).rejects.toThrow(McpError);
    await expect(handler({ issueKey: 'TAP-1', cursor: '1.5' })).rejects.toThrow(McpError);
  });

  it('uses cursor as offset for keys path (C3)', async () => {
    const grouped = new Map<string, any[]>();
    const allPrs = Array.from({ length: 30 }, (_, i) => ({
      number: i, title: `PR ${i}`, repo: 'Org/Repo', state: 'open' as const,
      htmlUrl: `url${i}`,
    }));
    grouped.set('TAP-1', allPrs);
    mockGitHub.findPrsForIssueKeys.mockResolvedValue(grouped);

    const handler = githubGetPrsHandler({ github: mockGitHub as any });
    const result = await handler({ keys: ['TAP-1'], limit: 5, cursor: '10' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(5);
    expect(parsed.items[0].number).toBe(10);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('15');
  });
});

describe('githubGetCodeReviewReadyHandler', () => {
  let mockGitHub: MockGitHub;
  let mockJira: { searchAllSlim: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
    mockJira = { searchAllSlim: vi.fn() };
  });

  function makeIssue(key: string, summary: string) {
    return {
      key,
      summary,
      status: 'Ready For Code Review',
      type: 'Story',
      assignee: 'Jommar Ilagan',
      reporter: null,
      priority: null,
      labels: [],
      created: null,
      updated: null,
      parent: null,
      subtasks: [],
      comments: [],
      attachments: [],
      description: null,
    };
  }

  function makePr(number: number, repo: string, author = 'jommar') {
    return {
      number,
      title: `PR ${number}`,
      state: 'open' as const,
      repo,
      author,
      createdAt: '2026-08-05T00:00:00Z',
      htmlUrl: `https://github.com/${repo}/pull/${number}`,
      reviewStatus: 'REVIEW_REQUIRED' as const,
    };
  }

  it('reports tickets where every PR is approved by a human', async () => {
    mockJira.searchAllSlim.mockResolvedValue([makeIssue('TAP-100', 'One PR')]);
    const grouped = new Map([['TAP-100', [makePr(1, 'Org/Repo')]]]);
    mockGitHub.findPrsForIssueKeys.mockResolvedValue(grouped);
    mockGitHub.isPrApprovedByHuman.mockResolvedValue(true);

    const handler = githubGetCodeReviewReadyHandler({ github: mockGitHub as any, jira: mockJira as any });
    const result = await handler({});

    expect(mockJira.searchAllSlim).toHaveBeenCalledWith(
      "project = TAP AND assignee = currentUser() AND status = 'Ready For Code Review'",
    );
    expect(mockGitHub.findPrsForIssueKeys).toHaveBeenCalledWith(['TAP-100'], 'open');
    expect(mockGitHub.isPrApprovedByHuman).toHaveBeenCalledWith('Org/Repo', 1, 'jommar');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.tickets[0].key).toBe('TAP-100');
    expect(parsed.tickets[0].allApproved).toBe(true);
    expect(parsed.tickets[0].prs[0].approved).toBe(true);
    expect(parsed.summary).toBe('1 of 1 tickets with PRs have every PR approved by a human.');
  });

  it('marks a ticket pending when any PR lacks a human approval', async () => {
    mockJira.searchAllSlim.mockResolvedValue([makeIssue('TAP-200', 'Two PRs')]);
    const grouped = new Map([
      ['TAP-200', [makePr(2, 'Org/Repo'), makePr(3, 'Org/Other')]],
    ]);
    mockGitHub.findPrsForIssueKeys.mockResolvedValue(grouped);
    mockGitHub.isPrApprovedByHuman
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const handler = githubGetCodeReviewReadyHandler({ github: mockGitHub as any, jira: mockJira as any });
    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.tickets[0].allApproved).toBe(false);
    expect(parsed.tickets[0].prs[0].approved).toBe(true);
    expect(parsed.tickets[0].prs[1].approved).toBe(false);
    expect(parsed.summary).toBe('0 of 1 tickets with PRs have every PR approved by a human.');
  });

  it('does not mark a ticket with no PRs as approved', async () => {
    mockJira.searchAllSlim.mockResolvedValue([makeIssue('TAP-300', 'No PRs')]);
    mockGitHub.findPrsForIssueKeys.mockResolvedValue(new Map([['TAP-300', []]]));

    const handler = githubGetCodeReviewReadyHandler({ github: mockGitHub as any, jira: mockJira as any });
    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.tickets[0].prs).toEqual([]);
    expect(parsed.tickets[0].allApproved).toBe(false);
    expect(parsed.summary).toBe('0 of 0 tickets with PRs have every PR approved by a human.');
  });

  it('flags a PR with a failed approval check instead of failing the whole call', async () => {
    mockJira.searchAllSlim.mockResolvedValue([makeIssue('TAP-400', 'Flaky')]);
    const grouped = new Map([['TAP-400', [makePr(4, 'Org/Repo')]]]);
    mockGitHub.findPrsForIssueKeys.mockResolvedValue(grouped);
    mockGitHub.isPrApprovedByHuman.mockRejectedValue(new Error('rate limited'));

    const handler = githubGetCodeReviewReadyHandler({ github: mockGitHub as any, jira: mockJira as any });
    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.tickets[0].prs[0].approved).toBe(false);
    expect(parsed.tickets[0].prs[0].approvalCheckFailed).toBe(true);
    expect(parsed.tickets[0].allApproved).toBe(false);
  });

  it('returns an empty report when no tickets match', async () => {
    mockJira.searchAllSlim.mockResolvedValue([]);

    const handler = githubGetCodeReviewReadyHandler({ github: mockGitHub as any, jira: mockJira as any });
    const parsed = JSON.parse((await handler({})).content[0].text);

    expect(parsed.tickets).toEqual([]);
    expect(mockGitHub.findPrsForIssueKeys).not.toHaveBeenCalled();
  });

  it('honors custom status, project, assignee, and prState params', async () => {
    mockJira.searchAllSlim.mockResolvedValue([]);

    const handler = githubGetCodeReviewReadyHandler({ github: mockGitHub as any, jira: mockJira as any });
    await handler({ status: 'In Review', project: 'TEST', assignee: 'alice', prState: 'all' });

    expect(mockJira.searchAllSlim).toHaveBeenCalledWith(
      "project = TEST AND assignee = alice AND status = 'In Review'",
    );
  });

  it('throws when the Jira client is not configured', async () => {
    const handler = githubGetCodeReviewReadyHandler({ github: mockGitHub as any });
    await expect(handler({})).rejects.toThrow(/Jira integration not configured/);
  });

  it('validates the prState param and applies defaults via the schema', async () => {
    expect(() => githubGetCodeReviewReadySchema.parse({ prState: 'bogus' })).toThrow();
    expect(githubGetCodeReviewReadySchema.parse({})).toMatchObject({
      status: 'Ready For Code Review',
      project: 'TAP',
      assignee: 'currentUser()',
      prState: 'open',
    });
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
      perPage: 21,
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
      perPage: 11,
      page: 2,
    });
  });

  it('sets hasMore using limit+1 probe', async () => {
    // Return limit+1 items to signal another page
    const comments = Array.from({ length: 21 }, (_, i) => ({
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

  it('hasMore is false when fewer results than limit+1', async () => {
    const comments = Array.from({ length: 15 }, (_, i) => ({
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
    expect(parsed.items).toHaveLength(15);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPageToken).toBeUndefined();
  });

  it('rejects invalid cursor (M9)', async () => {
    const handler = githubGetPrCommentsHandler({ github: mockGitHub as any });

    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: 'abc' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: '0' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: '-5' })).rejects.toThrow(McpError);
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
      perPage: 21,
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
      perPage: 11,
      page: 2,
    });
  });

  it('sets hasMore using limit+1 probe', async () => {
    const branches = Array.from({ length: 21 }, (_, i) => ({
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

  it('hasMore is false when fewer results than limit+1', async () => {
    const branches = Array.from({ length: 10 }, (_, i) => ({
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
    expect(parsed.items).toHaveLength(10);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPageToken).toBeUndefined();
  });

  it('rejects invalid cursor (M9)', async () => {
    const handler = githubListBranchesHandler({ github: mockGitHub as any });

    await expect(handler({ repo: 'Org/Repo', cursor: 'abc' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', cursor: '0' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', cursor: '-5' })).rejects.toThrow(McpError);
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
      perPage: 21,
      page: 1,
      label: undefined,
      reviewRequested: undefined,
      base: undefined,
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
      perPage: 21,
      page: 1,
      label: undefined,
      reviewRequested: undefined,
      base: undefined,
    });
  });

  it('filters by label', async () => {
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue([]);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    await handler({ label: 'bug', state: 'open', limit: 20 });

    expect(mockGitHub.searchPullRequestsByQuery).toHaveBeenCalledWith({
      query: undefined,
      author: undefined,
      repo: undefined,
      state: 'open',
      perPage: 21,
      page: 1,
      label: 'bug',
      reviewRequested: undefined,
      base: undefined,
    });
  });

  it('filters by reviewRequested', async () => {
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue([]);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    await handler({ reviewRequested: 'alice', state: 'open', limit: 20 });

    expect(mockGitHub.searchPullRequestsByQuery).toHaveBeenCalledWith({
      query: undefined,
      author: undefined,
      repo: undefined,
      state: 'open',
      perPage: 21,
      page: 1,
      label: undefined,
      reviewRequested: 'alice',
      base: undefined,
    });
  });

  it('filters by base branch', async () => {
    mockGitHub.searchPullRequestsByQuery.mockResolvedValue([]);

    const handler = githubSearchPrsHandler({ github: mockGitHub as any });
    await handler({ base: 'main', state: 'open', limit: 20 });

    expect(mockGitHub.searchPullRequestsByQuery).toHaveBeenCalledWith({
      query: undefined,
      author: undefined,
      repo: undefined,
      state: 'open',
      perPage: 21,
      page: 1,
      label: undefined,
      reviewRequested: undefined,
      base: 'main',
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
      perPage: 21,
      page: 1,
      label: undefined,
      reviewRequested: undefined,
      base: undefined,
    });
  });

  it('returns paginated response using limit+1 probe', async () => {
    // Return limit+1 items to signal another page
    const prs = Array.from({ length: 21 }, (_, i) => ({
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
      perPage: 11,
      page: 2,
      label: undefined,
      reviewRequested: undefined,
      base: undefined,
    });
  });

  it('rejects invalid cursor (M9)', async () => {
    const handler = githubSearchPrsHandler({ github: mockGitHub as any });

    await expect(handler({ author: 'alice', cursor: 'abc' })).rejects.toThrow(McpError);
    await expect(handler({ author: 'alice', cursor: '0' })).rejects.toThrow(McpError);
    await expect(handler({ author: 'alice', cursor: '-5' })).rejects.toThrow(McpError);
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
    ).toThrow('At least one of title, body, state, base, maintainerCanModify, or draft');
  });

  it('accepts draft alone as the only update field (schema validation)', () => {
    expect(() =>
      githubUpdatePrSchema.parse({ repo: 'Org/Repo', prNumber: 42, draft: true }),
    ).not.toThrow();
  });

  it('converts the PR to a draft without calling updatePullRequest', async () => {
    mockGitHub.setPullRequestDraft.mockResolvedValue({ number: 42, draft: true } as any);

    const handler = githubUpdatePrHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, draft: true });

    expect(mockGitHub.setPullRequestDraft).toHaveBeenCalledWith('Org/Repo', 42, true);
    expect(mockGitHub.updatePullRequest).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).draft).toBe(true);
  });

  it('marks the PR ready for review when draft is false', async () => {
    mockGitHub.setPullRequestDraft.mockResolvedValue({ number: 42, draft: false } as any);

    const handler = githubUpdatePrHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', prNumber: 42, draft: false });

    expect(mockGitHub.setPullRequestDraft).toHaveBeenCalledWith('Org/Repo', 42, false);
  });

  it('applies field updates before the draft toggle and returns the draft result', async () => {
    mockGitHub.updatePullRequest.mockResolvedValue({ number: 42, title: 'New', draft: false } as any);
    mockGitHub.setPullRequestDraft.mockResolvedValue({ number: 42, title: 'New', draft: true } as any);

    const handler = githubUpdatePrHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, title: 'New', draft: true });

    expect(mockGitHub.updatePullRequest).toHaveBeenCalled();
    expect(mockGitHub.setPullRequestDraft).toHaveBeenCalledWith('Org/Repo', 42, true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.draft).toBe(true);
    expect(parsed.title).toBe('New');
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

  it('replies in the existing thread when inReplyTo is provided', async () => {
    const reply = { id: 9, inReplyToId: 5, body: 'Agreed' };
    mockGitHub.replyToPrReviewComment.mockResolvedValue(reply as any);

    const handler = githubCreatePrReviewCommentHandler({ github: mockGitHub as any });
    const result = await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      body: 'Agreed',
      inReplyTo: 5,
    });

    expect(mockGitHub.replyToPrReviewComment).toHaveBeenCalledWith('Org/Repo', 42, 5, 'Agreed');
    expect(mockGitHub.createPrReviewComment).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).inReplyToId).toBe(5);
  });

  it('appends a suggestion block to a reply', async () => {
    mockGitHub.replyToPrReviewComment.mockResolvedValue({} as any);

    const handler = githubCreatePrReviewCommentHandler({ github: mockGitHub as any });
    await handler({
      repo: 'Org/Repo',
      prNumber: 42,
      body: 'Try this',
      inReplyTo: 5,
      suggestedReplacement: 'const x = 1;',
    });

    const body = mockGitHub.replyToPrReviewComment.mock.calls[0][3];
    expect(body).toBe('Try this\n\n```suggestion\nconst x = 1;\n```');
  });

  it('accepts inReplyTo without path, commitId, or line (schema validation)', () => {
    expect(() =>
      githubCreatePrReviewCommentSchema.parse({
        repo: 'Org/Repo',
        prNumber: 42,
        body: 'Agreed',
        inReplyTo: 5,
      }),
    ).not.toThrow();
  });

  it('rejects a non-reply comment missing path, commitId, or line (schema validation)', () => {
    expect(() =>
      githubCreatePrReviewCommentSchema.parse({
        repo: 'Org/Repo',
        prNumber: 42,
        body: 'Where?',
      }),
    ).toThrow('path, commitId, and line are required unless inReplyTo is provided');
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

    expect(mockGitHub.getPrReviewComments).toHaveBeenCalledWith('Org/Repo', 42, { perPage: 21, page: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(comments);
    expect(parsed.hasMore).toBe(false);
  });

  it('uses cursor as page number', async () => {
    mockGitHub.getPrReviewComments.mockResolvedValue([]);

    const handler = githubGetPrReviewCommentsHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', prNumber: 42, limit: 10, cursor: '3' });

    expect(mockGitHub.getPrReviewComments).toHaveBeenCalledWith('Org/Repo', 42, { perPage: 11, page: 3 });
  });

  it('sets hasMore using limit+1 probe', async () => {
    const comments = Array.from({ length: 21 }, (_, i) => ({
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

  it('hasMore is false when fewer results than limit+1', async () => {
    const comments = Array.from({ length: 10 }, (_, i) => ({
      id: i, path: 'f.ts', line: i, body: 'c', commitId: 'a', side: 'RIGHT' as const,
      startLine: null, startSide: null, author: 'u', createdAt: '', updatedAt: '', htmlUrl: '',
      inReplyToId: null, originalLine: null, originalStartLine: null,
    }));
    mockGitHub.getPrReviewComments.mockResolvedValue(comments);

    const handler = githubGetPrReviewCommentsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPageToken).toBeUndefined();
  });

  it('rejects invalid cursor (M9)', async () => {
    const handler = githubGetPrReviewCommentsHandler({ github: mockGitHub as any });

    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: 'abc' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: '0' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: '-5' })).rejects.toThrow(McpError);
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

describe('githubGetPrReviewThreadsHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns review threads from the client', async () => {
    const threads = [
      { id: 'thread1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 10 },
      { id: 'thread2', isResolved: true, isOutdated: false, path: 'src/b.ts', line: 20 },
    ];
    mockGitHub.getReviewThreads.mockResolvedValue(threads);

    const handler = githubGetPrReviewThreadsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42 });

    expect(mockGitHub.getReviewThreads).toHaveBeenCalledWith('Org/Repo', 42);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(threads);
  });
});

describe('githubResolveReviewThreadHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('resolves a thread and returns the result', async () => {
    mockGitHub.resolveReviewThread.mockResolvedValue({ isResolved: true });

    const handler = githubResolveReviewThreadHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', threadId: 'thread1' });

    expect(mockGitHub.resolveReviewThread).toHaveBeenCalledWith('Org/Repo', 'thread1');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.isResolved).toBe(true);
  });

  it('rejects with schema error when threadId is missing', () => {
    expect(() =>
      githubResolveReviewThreadSchema.parse({ repo: 'Org/Repo' }),
    ).toThrow();
  });
});

describe('githubUnresolveReviewThreadHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('unresolves a thread and returns the result', async () => {
    mockGitHub.unresolveReviewThread.mockResolvedValue({ isResolved: false });

    const handler = githubUnresolveReviewThreadHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', threadId: 'thread1' });

    expect(mockGitHub.unresolveReviewThread).toHaveBeenCalledWith('Org/Repo', 'thread1');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.isResolved).toBe(false);
  });
});

describe('githubDeletePrIssueCommentHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('deletes an issue comment and returns success', async () => {
    mockGitHub.deletePrComment.mockResolvedValue(undefined);

    const handler = githubDeletePrIssueCommentHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', commentId: 123 });

    expect(mockGitHub.deletePrComment).toHaveBeenCalledWith('Org/Repo', 123);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.message).toBe('Issue comment deleted');
  });
});

describe('githubMergePrHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('merges a PR and returns the result', async () => {
    mockGitHub.mergePr.mockResolvedValue({ merged: true, message: 'Pull Request successfully merged', sha: 'abc123' });

    const handler = githubMergePrHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42 });

    expect(mockGitHub.mergePr).toHaveBeenCalledWith('Org/Repo', 42, {
      mergeMethod: 'merge',
      sha: undefined,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.merged).toBe(true);
  });

  it('passes mergeMethod and sha when provided', async () => {
    mockGitHub.mergePr.mockResolvedValue({ merged: true, message: 'Squashed', sha: 'def456' });

    const handler = githubMergePrHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', prNumber: 42, mergeMethod: 'squash', sha: 'def456' });

    expect(mockGitHub.mergePr).toHaveBeenCalledWith('Org/Repo', 42, {
      mergeMethod: 'squash',
      sha: 'def456',
    });
  });

  it('rejects invalid mergeMethod enum', () => {
    expect(() =>
      githubMergePrSchema.parse({ repo: 'Org/Repo', prNumber: 42, mergeMethod: 'invalid' }),
    ).toThrow();
  });
});

describe('githubRequestPrReviewersHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('requests reviewers and returns the result', async () => {
    mockGitHub.requestReviewers.mockResolvedValue({
      requestedReviewers: ['alice', 'bob'],
      requestedTeams: [],
    });

    const handler = githubRequestPrReviewersHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, reviewers: ['alice', 'bob'] });

    expect(mockGitHub.requestReviewers).toHaveBeenCalledWith('Org/Repo', 42, ['alice', 'bob'], undefined);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.requestedReviewers).toEqual(['alice', 'bob']);
  });

  it('accepts optional teamReviewers', async () => {
    mockGitHub.requestReviewers.mockResolvedValue({
      requestedReviewers: [],
      requestedTeams: ['team-a'],
    });

    const handler = githubRequestPrReviewersHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', prNumber: 42, reviewers: ['alice'], teamReviewers: ['team-a'] });

    expect(mockGitHub.requestReviewers).toHaveBeenCalledWith('Org/Repo', 42, ['alice'], ['team-a']);
  });

  it('rejects empty reviewers array', () => {
    expect(() =>
      githubRequestPrReviewersSchema.parse({ repo: 'Org/Repo', prNumber: 42, reviewers: [] }),
    ).toThrow();
  });
});

describe('githubUpdatePrLabelsHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('updates labels and returns the result', async () => {
    mockGitHub.updateLabels.mockResolvedValue(['bug', 'frontend']);

    const handler = githubUpdatePrLabelsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, labels: ['bug', 'frontend'] });

    expect(mockGitHub.updateLabels).toHaveBeenCalledWith('Org/Repo', 42, ['bug', 'frontend']);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(['bug', 'frontend']);
  });
});

describe('githubUpdatePrAssigneesHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('updates assignees and returns the result', async () => {
    mockGitHub.updateAssignees.mockResolvedValue(['alice', 'bob']);

    const handler = githubUpdatePrAssigneesHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, assignees: ['alice', 'bob'] });

    expect(mockGitHub.updateAssignees).toHaveBeenCalledWith('Org/Repo', 42, ['alice', 'bob']);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(['alice', 'bob']);
  });
});

describe('githubDismissPrReviewHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('dismisses a review and returns success', async () => {
    mockGitHub.dismissPrReview.mockResolvedValue({ success: true, message: 'Review dismissed' });

    const handler = githubDismissPrReviewHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, reviewId: 123, message: 'Addressed in follow-up' });

    expect(mockGitHub.dismissPrReview).toHaveBeenCalledWith('Org/Repo', 42, 123, 'Addressed in follow-up');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
  });
});

describe('githubGetPrFilesHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns paginated file list', async () => {
    const files = [
      { filename: 'src/a.ts', status: 'modified', additions: 5, deletions: 2, changes: 7, patch: '@@ -1 +1 @@' },
    ];
    mockGitHub.getPrFiles.mockResolvedValue(files);

    const handler = githubGetPrFilesHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    expect(mockGitHub.getPrFiles).toHaveBeenCalledWith('Org/Repo', 42, { perPage: 21, page: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(files);
    expect(parsed.hasMore).toBe(false);
  });

  it('uses cursor as page number', async () => {
    mockGitHub.getPrFiles.mockResolvedValue([]);

    const handler = githubGetPrFilesHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', prNumber: 42, limit: 10, cursor: '2' });

    expect(mockGitHub.getPrFiles).toHaveBeenCalledWith('Org/Repo', 42, { perPage: 11, page: 2 });
  });

  it('sets hasMore using limit+1 probe', async () => {
    const files = Array.from({ length: 21 }, (_, i) => ({
      filename: `file-${i}.ts`, status: 'modified', additions: 1, deletions: 0, changes: 1,
      patch: '@@ -1 +1 @@',
    }));
    mockGitHub.getPrFiles.mockResolvedValue(files);

    const handler = githubGetPrFilesHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(20);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('2');
  });

  it('hasMore is false when fewer results than limit+1', async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      filename: `file-${i}.ts`, status: 'modified', additions: 1, deletions: 0, changes: 1,
    }));
    mockGitHub.getPrFiles.mockResolvedValue(files);

    const handler = githubGetPrFilesHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(10);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPageToken).toBeUndefined();
  });

  it('rejects invalid cursor (M9)', async () => {
    const handler = githubGetPrFilesHandler({ github: mockGitHub as any });

    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: 'abc' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: '0' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: '-5' })).rejects.toThrow(McpError);
  });

  it('rejects invalid repo format (schema validation)', () => {
    expect(() => githubGetPrFilesSchema.parse({ repo: 'invalid', prNumber: 42 })).toThrow();
  });
});

describe('githubGetPrCommitsHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns paginated commit list', async () => {
    const commits = [
      { sha: 'abc123', commit: { message: 'Fix bug', author: { name: 'Alice', email: 'alice@example.com', date: '2025-01-01T00:00:00Z' } }, author: { login: 'alice' } },
    ];
    mockGitHub.getPrCommits.mockResolvedValue(commits);

    const handler = githubGetPrCommitsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    expect(mockGitHub.getPrCommits).toHaveBeenCalledWith('Org/Repo', 42, { perPage: 21, page: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual(commits);
    expect(parsed.hasMore).toBe(false);
  });

  it('uses cursor as page number', async () => {
    mockGitHub.getPrCommits.mockResolvedValue([]);

    const handler = githubGetPrCommitsHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', prNumber: 42, limit: 10, cursor: '2' });

    expect(mockGitHub.getPrCommits).toHaveBeenCalledWith('Org/Repo', 42, { perPage: 11, page: 2 });
  });

  it('sets hasMore using limit+1 probe', async () => {
    const commits = Array.from({ length: 21 }, (_, i) => ({
      sha: `sha${i}`, commit: { message: `Commit ${i}`, author: { name: 'A', email: 'a@b.com', date: '2025-01-01T00:00:00Z' } }, author: { login: 'user' },
    }));
    mockGitHub.getPrCommits.mockResolvedValue(commits);

    const handler = githubGetPrCommitsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(20);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('2');
  });

  it('hasMore is false when fewer results than limit+1', async () => {
    const commits = Array.from({ length: 10 }, (_, i) => ({
      sha: `sha${i}`, commit: { message: `Commit ${i}`, author: { name: 'A', email: 'a@b.com', date: '2025-01-01T00:00:00Z' } }, author: { login: 'user' },
    }));
    mockGitHub.getPrCommits.mockResolvedValue(commits);

    const handler = githubGetPrCommitsHandler({ github: mockGitHub as any });
    const result = await handler({ repo: 'Org/Repo', prNumber: 42, limit: 20 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(10);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPageToken).toBeUndefined();
  });

  it('rejects invalid cursor (M9)', async () => {
    const handler = githubGetPrCommitsHandler({ github: mockGitHub as any });

    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: 'abc' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: '0' })).rejects.toThrow(McpError);
    await expect(handler({ repo: 'Org/Repo', prNumber: 42, cursor: '-5' })).rejects.toThrow(McpError);
  });

  it('rejects invalid repo format (schema validation)', () => {
    expect(() => githubGetPrCommitsSchema.parse({ repo: 'invalid', prNumber: 42 })).toThrow();
  });
});

describe('githubGetFileContentsHandler', () => {
  let mockGitHub: MockGitHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGitHub = makeMockGitHub();
  });

  it('returns decoded file contents', async () => {
    const result = { path: 'src/file.ts', content: 'console.log("hello");', encoding: 'base64', size: 24, sha: 'abc', truncated: false };
    mockGitHub.getFileContents.mockResolvedValue(result);

    const handler = githubGetFileContentsHandler({ github: mockGitHub as any });
    const response = await handler({ repo: 'Org/Repo', path: 'src/file.ts' });

    expect(mockGitHub.getFileContents).toHaveBeenCalledWith('Org/Repo', 'src/file.ts', undefined);
    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.content).toBe('console.log("hello");');
    expect(parsed.truncated).toBe(false);
  });

  it('passes ref when provided', async () => {
    mockGitHub.getFileContents.mockResolvedValue({ path: 'f.ts', content: '', encoding: 'base64', size: 0, truncated: false });

    const handler = githubGetFileContentsHandler({ github: mockGitHub as any });
    await handler({ repo: 'Org/Repo', path: 'f.ts', ref: 'main' });

    expect(mockGitHub.getFileContents).toHaveBeenCalledWith('Org/Repo', 'f.ts', 'main');
  });

  it('rejects invalid repo format (schema validation)', () => {
    expect(() => githubGetFileContentsSchema.parse({ repo: 'invalid', path: 'f.ts' })).toThrow();
  });

  it('rejects empty path (schema validation)', () => {
    expect(() => githubGetFileContentsSchema.parse({ repo: 'Org/Repo', path: '' })).toThrow();
  });
});
