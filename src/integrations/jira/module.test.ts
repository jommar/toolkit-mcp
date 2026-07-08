import { vi, describe, it, expect, beforeEach } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

// Mock jira-cli so toSlimIssue is available (JiraClient constructor unused by these tests)
vi.mock('../../services/index.js', () => ({
  JiraClient: class MockJiraClient {},
  toSlimIssue: vi.fn((issue: any) => issue),
}));

import {
  jiraWhoamiHandler,
  jiraGetIssuesHandler,
  jiraCreateIssueHandler,
  jiraUpdateIssueHandler,
  jiraTransitionIssueHandler,
  jiraAssignIssueHandler,
  jiraAddCommentHandler,
  jiraUpdateCommentHandler,
  jiraLinkIssuesHandler,
  jiraGetAttachmentHandler,
} from './module.js';

function makeMockJira() {
  return {
    whoami: vi.fn(),
    getIssueSlim: vi.fn(),
    search: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    listTransitions: vi.fn(),
    transitionIssue: vi.fn(),
    assignIssue: vi.fn(),
    assignToMe: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    listIssueLinkTypes: vi.fn(),
    linkIssues: vi.fn(),
    getAttachmentContent: vi.fn(),
  };
}

type MockJira = ReturnType<typeof makeMockJira>;

describe('jiraWhoamiHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('returns the authenticated user', async () => {
    const user = { accountId: 'abc', displayName: 'Test User', emailAddress: 'test@example.com' };
    mockJira.whoami.mockResolvedValue(user);

    const handler = jiraWhoamiHandler({ jira: mockJira as any });
    const result = await handler({});

    expect(mockJira.whoami).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual(user);
  });
});

describe('jiraGetIssuesHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('fetches a single issue by key', async () => {
    const slimIssue = { key: 'TRIPS-1', summary: 'Test' };
    mockJira.getIssueSlim.mockResolvedValue(slimIssue);

    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TRIPS-1' });

    expect(mockJira.getIssueSlim).toHaveBeenCalledWith('TRIPS-1');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual([slimIssue]);
    expect(parsed.hasMore).toBe(false);
  });

  it('searches issues by JQL', async () => {
    const rawIssues = [
      { id: '1', key: 'TRIPS-1', fields: { summary: 'Issue 1' } },
      { id: '2', key: 'TRIPS-2', fields: { summary: 'Issue 2' } },
    ];
    mockJira.search.mockResolvedValue({
      issues: rawIssues,
      nextPageToken: undefined,
    });

    // Note: limit is passed explicitly because handler receives raw args (Zod defaults not applied)
    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({ jql: 'project = TRIPS', limit: 20 });

    expect(mockJira.search).toHaveBeenCalledWith('project = TRIPS', {
      maxResults: 20,
      nextPageToken: undefined,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.hasMore).toBe(false);
  });

  it('passes limit and cursor in JQL mode', async () => {
    mockJira.search.mockResolvedValue({ issues: [], nextPageToken: 'page2' });

    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({
      jql: 'project = TRIPS',
      limit: 5,
      cursor: 'abc123',
    });

    expect(mockJira.search).toHaveBeenCalledWith('project = TRIPS', {
      maxResults: 5,
      nextPageToken: 'abc123',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('page2');
  });

  it('gives key priority over jql when both provided', async () => {
    mockJira.getIssueSlim.mockResolvedValue({ key: 'TRIPS-1', summary: 'Priority' });

    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TRIPS-1', jql: 'project = OTHER' });

    expect(mockJira.getIssueSlim).toHaveBeenCalledWith('TRIPS-1');
    expect(mockJira.search).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(1);
  });

  it('throws when neither key nor jql provided', async () => {
    const handler = jiraGetIssuesHandler({ jira: mockJira as any });

    await expect(handler({})).rejects.toThrow(McpError);
    await expect(handler({})).rejects.toThrow('Provide either key or jql');
  });
});

describe('jiraCreateIssueHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('creates an issue with minimal fields', async () => {
    const created = { id: '100', key: 'TRIPS-42' };
    mockJira.createIssue.mockResolvedValue(created);

    const handler = jiraCreateIssueHandler({ jira: mockJira as any });
    const result = await handler({
      projectKey: 'TRIPS',
      issueType: 'Task',
      summary: 'My task',
    });

    expect(mockJira.createIssue).toHaveBeenCalledWith({
      projectKey: 'TRIPS',
      issueType: 'Task',
      summary: 'My task',
      description: undefined,
      fields: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(created);
  });

  it('creates an issue with description', async () => {
    mockJira.createIssue.mockResolvedValue({ key: 'TRIPS-43' });

    const handler = jiraCreateIssueHandler({ jira: mockJira as any });
    await handler({
      projectKey: 'TRIPS',
      issueType: 'Bug',
      summary: 'A bug',
      description: 'Something broke',
    });

    expect(mockJira.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Something broke' }),
    );
  });

  it('creates an issue with extra fields', async () => {
    mockJira.createIssue.mockResolvedValue({ key: 'TRIPS-44' });

    const handler = jiraCreateIssueHandler({ jira: mockJira as any });
    await handler({
      projectKey: 'TRIPS',
      issueType: 'Story',
      summary: 'A story',
      fields: { customfield_123: 'value', priority: { name: 'High' } },
    });

    expect(mockJira.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: { customfield_123: 'value', priority: { name: 'High' } },
      }),
    );
  });
});

describe('jiraUpdateIssueHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('updates an issue and returns success', async () => {
    mockJira.updateIssue.mockResolvedValue(undefined);

    const handler = jiraUpdateIssueHandler({ jira: mockJira as any });
    const result = await handler({
      key: 'TRIPS-1',
      fields: { summary: 'Updated title' },
    });

    expect(mockJira.updateIssue).toHaveBeenCalledWith('TRIPS-1', {
      summary: 'Updated title',
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TRIPS-1',
    });
  });
});

describe('jiraTransitionIssueHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('transitions by transitionId', async () => {
    mockJira.transitionIssue.mockResolvedValue(undefined);

    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });
    const result = await handler({
      key: 'TRIPS-1',
      transitionId: '41',
    });

    expect(mockJira.transitionIssue).toHaveBeenCalledWith('TRIPS-1', '41', {
      comment: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TRIPS-1',
      transitionId: '41',
    });
  });

  it('looks up transition by name', async () => {
    mockJira.listTransitions.mockResolvedValue([
      { id: '41', name: 'In Progress', to: { id: '3' } },
      { id: '31', name: 'Done', to: { id: '4' } },
    ]);
    mockJira.transitionIssue.mockResolvedValue(undefined);

    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });
    const result = await handler({
      key: 'TRIPS-1',
      transitionName: 'In Progress',
    });

    expect(mockJira.listTransitions).toHaveBeenCalledWith('TRIPS-1');
    expect(mockJira.transitionIssue).toHaveBeenCalledWith('TRIPS-1', '41', {
      comment: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TRIPS-1',
      transitionId: '41',
    });
  });

  it('looks up transition case-insensitively by name', async () => {
    mockJira.listTransitions.mockResolvedValue([
      { id: '31', name: 'In Progress', to: { id: '3' } },
    ]);
    mockJira.transitionIssue.mockResolvedValue(undefined);

    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });
    const result = await handler({
      key: 'TRIPS-1',
      transitionName: 'in progress',
    });

    expect(mockJira.transitionIssue).toHaveBeenCalledWith('TRIPS-1', '31', {
      comment: undefined,
    });
    expect(JSON.parse(result.content[0].text).transitionId).toBe('31');
  });

  it('passes comment during transition', async () => {
    mockJira.transitionIssue.mockResolvedValue(undefined);

    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });
    await handler({
      key: 'TRIPS-1',
      transitionId: '41',
      comment: 'Moving along',
    });

    expect(mockJira.transitionIssue).toHaveBeenCalledWith('TRIPS-1', '41', {
      comment: 'Moving along',
    });
  });

  it('throws when transition name not found', async () => {
    mockJira.listTransitions.mockResolvedValue([
      { id: '41', name: 'In Progress', to: { id: '3' } },
    ]);

    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });

    await expect(
      handler({ key: 'TRIPS-1', transitionName: 'Unknown' }),
    ).rejects.toThrow(McpError);
    await expect(
      handler({ key: 'TRIPS-1', transitionName: 'Unknown' }),
    ).rejects.toThrow(
      'Transition "Unknown" not found. Available: In Progress',
    );
  });

  it('throws when neither transitionId nor transitionName provided', async () => {
    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });

    await expect(handler({ key: 'TRIPS-1' })).rejects.toThrow(McpError);
    await expect(handler({ key: 'TRIPS-1' })).rejects.toThrow(
      'Provide either transitionId or transitionName',
    );
  });
});

describe('jiraAssignIssueHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('assigns to me', async () => {
    mockJira.assignToMe.mockResolvedValue({ displayName: 'Current User' });

    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TRIPS-1', assignee: 'me' });

    expect(mockJira.assignToMe).toHaveBeenCalledWith('TRIPS-1');
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TRIPS-1',
      assignee: 'Current User',
    });
  });

  it('uses "me" assignee when passed explicitly', async () => {
    mockJira.assignToMe.mockResolvedValue({ displayName: 'Default User' });

    // Note: handler receives raw args (Zod defaults not applied), so 'me' must be explicit
    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TRIPS-1', assignee: 'me' });

    expect(mockJira.assignToMe).toHaveBeenCalledWith('TRIPS-1');
    expect(JSON.parse(result.content[0].text).assignee).toBe('Default User');
  });

  it('unassigns (none)', async () => {
    mockJira.assignIssue.mockResolvedValue(undefined);

    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TRIPS-1', assignee: 'none' });

    expect(mockJira.assignIssue).toHaveBeenCalledWith('TRIPS-1', null);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TRIPS-1',
      assignee: null,
    });
  });

  it('assigns to a specific accountId', async () => {
    mockJira.assignIssue.mockResolvedValue(undefined);

    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    const result = await handler({
      key: 'TRIPS-1',
      assignee: 'abc-123-def',
    });

    expect(mockJira.assignIssue).toHaveBeenCalledWith('TRIPS-1', 'abc-123-def');
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TRIPS-1',
      assignee: 'abc-123-def',
    });
  });
});

describe('jiraAddCommentHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('adds a comment and returns it', async () => {
    const comment = { id: '12345', body: 'Thanks!' };
    mockJira.addComment.mockResolvedValue(comment);

    const handler = jiraAddCommentHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TRIPS-1', body: 'Thanks!' });

    expect(mockJira.addComment).toHaveBeenCalledWith('TRIPS-1', 'Thanks!');
    expect(JSON.parse(result.content[0].text)).toEqual(comment);
  });
});

describe('jiraUpdateCommentHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('updates a comment and returns it', async () => {
    const comment = { id: '38560', body: 'Revised.' };
    mockJira.updateComment.mockResolvedValue(comment);

    const handler = jiraUpdateCommentHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TRIPS-799', commentId: '38560', body: 'Revised.' });

    expect(mockJira.updateComment).toHaveBeenCalledWith('TRIPS-799', '38560', 'Revised.');
    expect(JSON.parse(result.content[0].text)).toEqual(comment);
  });
});

describe('jiraLinkIssuesHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('links two issues with a valid type', async () => {
    mockJira.listIssueLinkTypes.mockResolvedValue([
      { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      { name: 'Relates', inward: 'relates to', outward: 'relates to' },
    ]);
    mockJira.linkIssues.mockResolvedValue(undefined);

    const handler = jiraLinkIssuesHandler({ jira: mockJira as any });
    const result = await handler({
      inwardKey: 'TRIPS-1',
      outwardKey: 'TRIPS-2',
      type: 'Blocks',
    });

    expect(mockJira.listIssueLinkTypes).toHaveBeenCalled();
    expect(mockJira.linkIssues).toHaveBeenCalledWith({
      type: 'Blocks',
      inwardKey: 'TRIPS-1',
      outwardKey: 'TRIPS-2',
      comment: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      type: 'Blocks',
      inwardKey: 'TRIPS-1',
      outwardKey: 'TRIPS-2',
    });
  });

  it('matches link type case-insensitively', async () => {
    mockJira.listIssueLinkTypes.mockResolvedValue([
      { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    ]);
    mockJira.linkIssues.mockResolvedValue(undefined);

    const handler = jiraLinkIssuesHandler({ jira: mockJira as any });
    const result = await handler({
      inwardKey: 'TRIPS-1',
      outwardKey: 'TRIPS-2',
      type: 'blocks',
    });

    expect(mockJira.linkIssues).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Blocks' }),
    );
    expect(JSON.parse(result.content[0].text).type).toBe('Blocks');
  });

  it('passes optional comment when linking', async () => {
    mockJira.listIssueLinkTypes.mockResolvedValue([
      { name: 'Relates', inward: 'relates to', outward: 'relates to' },
    ]);
    mockJira.linkIssues.mockResolvedValue(undefined);

    const handler = jiraLinkIssuesHandler({ jira: mockJira as any });
    await handler({
      inwardKey: 'TRIPS-1',
      outwardKey: 'TRIPS-2',
      type: 'Relates',
      comment: 'Related feature work',
    });

    expect(mockJira.linkIssues).toHaveBeenCalledWith(
      expect.objectContaining({ comment: 'Related feature work' }),
    );
  });

  it('throws when link type not found', async () => {
    mockJira.listIssueLinkTypes.mockResolvedValue([
      { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    ]);

    const handler = jiraLinkIssuesHandler({ jira: mockJira as any });

    await expect(
      handler({
        inwardKey: 'TRIPS-1',
        outwardKey: 'TRIPS-2',
        type: 'InvalidType',
      }),
    ).rejects.toThrow(McpError);
    await expect(
      handler({
        inwardKey: 'TRIPS-1',
        outwardKey: 'TRIPS-2',
        type: 'InvalidType',
      }),
    ).rejects.toThrow('Link type "InvalidType" not found. Available: Blocks');
  });
});

describe('jiraGetAttachmentHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('returns native image content for image mime types', async () => {
    mockJira.getAttachmentContent.mockResolvedValue({
      id: '39824',
      filename: 'screenshot.png',
      mimeType: 'image/png',
      size: 107133,
      contentBase64: 'iVBORw0KGgo=',
    });

    const handler = jiraGetAttachmentHandler({ jira: mockJira as any });
    const result = await handler({ attachmentId: '39824', issueKey: 'TRIPS-1260' });

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({
      type: 'image',
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
    });
    // metadata text follows
    const meta = JSON.parse((result.content[1] as { type: 'text'; text: string }).text);
    expect(meta).toMatchObject({
      id: '39824',
      filename: 'screenshot.png',
      mimeType: 'image/png',
      size: 107133,
      issueKey: 'TRIPS-1260',
    });
  });

  it('returns text content with base64 for non-image mime types', async () => {
    mockJira.getAttachmentContent.mockResolvedValue({
      id: '50001',
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
      size: 524288,
      contentBase64: 'JVBERi0xLjQK',
    });

    const handler = jiraGetAttachmentHandler({ jira: mockJira as any });
    const result = await handler({ attachmentId: '50001' });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const body = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
    expect(body).toMatchObject({
      id: '50001',
      filename: 'spec.pdf',
      mimeType: 'application/pdf',
      size: 524288,
      issueKey: null,
      contentBase64: 'JVBERi0xLjQK',
    });
  });
});
