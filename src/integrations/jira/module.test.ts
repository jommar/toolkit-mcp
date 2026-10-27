import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

// Mock jira-cli so toSlimIssue is available (JiraClient constructor unused by these tests)
vi.mock('../../services/index.js', () => ({
  JiraClient: class MockJiraClient {},
  toSlimIssue: vi.fn((issue: any) => issue),
  DEV_FIELDS: ['summary', 'status', 'issuetype', 'assignee', 'reporter', 'priority', 'labels', 'created', 'updated', 'parent', 'subtasks', 'description', 'comment', 'attachment'],
}));

import {
  jiraWhoamiHandler,
  jiraGetIssuesHandler,
  jiraGetIssuesSchema,
  jiraCreateIssueHandler,
  jiraUpdateIssueHandler,
  jiraTransitionIssueHandler,
  jiraAssignIssueHandler,
  jiraAddCommentHandler,
  jiraUpdateCommentHandler,
  jiraLinkIssuesHandler,
  jiraGetAttachmentHandler,
  jiraGetCommentsHandler,
  jiraListTransitionsHandler,
  jiraListIssueLinkTypesHandler,
  jiraSearchUsersHandler,
  jiraListFieldsHandler,
  jiraDeleteCommentHandler,
  jiraAddCommentSchema,
  jiraUpdateCommentSchema,
  jiraToolDescriptors,
} from './module.js';
import { toSlimIssue, DEV_FIELDS } from '../../services/index.js';

function makeMockJira() {
  return {
    whoami: vi.fn(),
    getIssue: vi.fn(),
    getIssueSlim: vi.fn(),
    search: vi.fn(),
    searchUsers: vi.fn(),
    getFields: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    listTransitions: vi.fn(),
    transitionIssue: vi.fn(),
    assignIssue: vi.fn(),
    assignToMe: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    getComments: vi.fn(),
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

  it('fetches a single issue by key, always slimmed', async () => {
    const rawIssue = { id: '1', key: 'TAP-1', fields: { summary: 'Test' } };
    mockJira.getIssue.mockResolvedValue(rawIssue);

    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1' });

    // Now calls getIssue + toSlimIssue rather than getIssueSlim
    expect(mockJira.getIssue).toHaveBeenCalledWith('TAP-1', expect.any(Array));
    expect(mockJira.getIssueSlim).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toEqual([rawIssue]);
    expect(parsed.hasMore).toBe(false);
  });

  it('searches issues by JQL', async () => {
    const rawIssues = [
      { id: '1', key: 'TAP-1', fields: { summary: 'Issue 1' } },
      { id: '2', key: 'TAP-2', fields: { summary: 'Issue 2' } },
    ];
    mockJira.search.mockResolvedValue({
      issues: rawIssues,
      nextPageToken: undefined,
    });

    // Note: limit is passed explicitly because handler receives raw args (Zod defaults not applied)
    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({ jql: 'project = TAP', limit: 20 });

    // Handler does not pass fields by default in JQL path (Jira default fields suffice)
    expect(mockJira.search).toHaveBeenCalledWith('project = TAP', {
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
      jql: 'project = TAP',
      limit: 5,
      cursor: 'abc123',
    });

    expect(mockJira.search).toHaveBeenCalledWith('project = TAP', {
      maxResults: 5,
      nextPageToken: 'abc123',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('page2');
  });

  it('gives key priority over jql when both provided', async () => {
    const rawIssue = { id: '1', key: 'TAP-1', fields: { summary: 'Priority' } };
    mockJira.getIssue.mockResolvedValue(rawIssue);

    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', jql: 'project = OTHER' });

    expect(mockJira.getIssue).toHaveBeenCalledWith('TAP-1', expect.any(Array));
    expect(mockJira.search).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(1);
  });

  it('requests and passes through custom fields (key mode), excluding DEV_FIELDS', async () => {
    const rawIssue = { id: '1', key: 'TAP-1', fields: { summary: 'Test', customfield_10058: 5 } };
    mockJira.getIssue.mockResolvedValue(rawIssue);

    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', fields: ['summary', 'customfield_10058'] });

    expect(mockJira.getIssue).toHaveBeenCalledWith(
      'TAP-1',
      expect.arrayContaining([...DEV_FIELDS, 'customfield_10058']),
    );
    expect(toSlimIssue).toHaveBeenCalledWith(rawIssue, ['customfield_10058']);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items[0].fields.customfield_10058).toBe(5);
  });

  it('requests and passes through custom fields (JQL mode)', async () => {
    const rawIssues = [{ id: '1', key: 'TAP-1', fields: { summary: 'A', customfield_10058: 5 } }];
    mockJira.search.mockResolvedValue({ issues: rawIssues, nextPageToken: undefined });

    const handler = jiraGetIssuesHandler({ jira: mockJira as any });
    const result = await handler({ jql: 'project = TAP', limit: 20, fields: ['customfield_10058'] });

    expect(mockJira.search).toHaveBeenCalledWith('project = TAP', {
      maxResults: 20,
      nextPageToken: undefined,
      fields: expect.arrayContaining([...DEV_FIELDS, 'customfield_10058']),
    });
    expect(toSlimIssue).toHaveBeenCalledWith(rawIssues[0], ['customfield_10058']);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items[0].fields.customfield_10058).toBe(5);
  });

  it('throws when neither key nor jql provided', async () => {
    const handler = jiraGetIssuesHandler({ jira: mockJira as any });

    await expect(handler({})).rejects.toThrow(McpError);
    await expect(handler({})).rejects.toThrow('Provide either key or jql');
  });

  describe('raw ADF description', () => {
    const adfDescription = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Problem' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Details', marks: [{ type: 'em' }] }] },
      ],
    };
    const expectedAdf = {
      version: 1,
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Problem' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Details', marks: [{ type: 'em' }] }] },
      ],
    };

    beforeEach(async () => {
      const { toSlimIssue: realToSlimIssue } = await vi.importActual<typeof import('../../services/slim.js')>(
        '../../services/slim.js',
      );
      vi.mocked(toSlimIssue).mockImplementation(realToSlimIssue);
    });

    afterEach(() => {
      vi.mocked(toSlimIssue).mockImplementation((issue: any) => issue);
    });

    it('returns descriptionAdf for a single issue by key when adf is true', async () => {
      mockJira.getIssue.mockResolvedValue({ id: '1', key: 'TAP-1', fields: { summary: 'Test', description: adfDescription } });

      const handler = jiraGetIssuesHandler({ jira: mockJira as any });
      const result = await handler({ key: 'TAP-1', adf: true });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.items[0].descriptionAdf).toEqual(expectedAdf);
      expect(parsed.items[0].description).toBe('Problem\nDetails');
    });

    it('returns descriptionAdf on every issue of a JQL search when adf is true', async () => {
      mockJira.search.mockResolvedValue({
        issues: [
          { id: '1', key: 'TAP-1', fields: { summary: 'One', description: adfDescription } },
          { id: '2', key: 'TAP-2', fields: { summary: 'Two', description: null } },
        ],
        isLast: true,
      });

      const handler = jiraGetIssuesHandler({ jira: mockJira as any });
      const result = await handler({ jql: 'project = TAP', limit: 20, adf: true });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.items[0].descriptionAdf).toEqual(expectedAdf);
      expect('descriptionAdf' in parsed.items[1]).toBe(false);
    });

    it('omits descriptionAdf when adf is not set', async () => {
      mockJira.getIssue.mockResolvedValue({ id: '1', key: 'TAP-1', fields: { summary: 'Test', description: adfDescription } });

      const handler = jiraGetIssuesHandler({ jira: mockJira as any });
      const result = await handler({ key: 'TAP-1' });

      const parsed = JSON.parse(result.content[0].text);
      expect('descriptionAdf' in parsed.items[0]).toBe(false);
      expect(parsed.items[0].description).toBe('Problem\nDetails');
    });

    it('omits descriptionAdf when adf is false', async () => {
      mockJira.getIssue.mockResolvedValue({ id: '1', key: 'TAP-1', fields: { summary: 'Test', description: adfDescription } });

      const handler = jiraGetIssuesHandler({ jira: mockJira as any });
      const result = await handler({ key: 'TAP-1', adf: false });

      const parsed = JSON.parse(result.content[0].text);
      expect('descriptionAdf' in parsed.items[0]).toBe(false);
    });
  });
});

describe('jiraGetIssuesSchema adf', () => {
  it('accepts a boolean adf', () => {
    const parsed = jiraGetIssuesSchema.safeParse({ key: 'TAP-1', adf: true });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.adf).toBe(true);
  });

  it('leaves adf undefined when omitted', () => {
    const parsed = jiraGetIssuesSchema.safeParse({ key: 'TAP-1' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.adf).toBeUndefined();
  });

  it('rejects a non-boolean adf', () => {
    expect(jiraGetIssuesSchema.safeParse({ key: 'TAP-1', adf: 'yes' }).success).toBe(false);
  });

  it('documents adf in the published tool input schema', () => {
    const descriptor = jiraToolDescriptors.find((d) => d.name === 'jira_get_issues')!;
    expect((descriptor.inputSchema as any).properties.adf.type).toBe('boolean');
  });
});

describe('jiraCreateIssueHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('creates an issue with minimal fields', async () => {
    const created = { id: '100', key: 'TAP-42' };
    mockJira.createIssue.mockResolvedValue(created);

    const handler = jiraCreateIssueHandler({ jira: mockJira as any });
    const result = await handler({
      projectKey: 'TAP',
      issueType: 'Task',
      summary: 'My task',
    });

    expect(mockJira.createIssue).toHaveBeenCalledWith({
      projectKey: 'TAP',
      issueType: 'Task',
      summary: 'My task',
      description: undefined,
      fields: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(created);
  });

  it('creates an issue with description', async () => {
    mockJira.createIssue.mockResolvedValue({ key: 'TAP-43' });

    const handler = jiraCreateIssueHandler({ jira: mockJira as any });
    await handler({
      projectKey: 'TAP',
      issueType: 'Bug',
      summary: 'A bug',
      description: 'Something broke',
    });

    expect(mockJira.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Something broke' }),
    );
  });

  it('creates an issue with extra fields', async () => {
    mockJira.createIssue.mockResolvedValue({ key: 'TAP-44' });

    const handler = jiraCreateIssueHandler({ jira: mockJira as any });
    await handler({
      projectKey: 'TAP',
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
      key: 'TAP-1',
      fields: { summary: 'Updated title' },
    });

    expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', {
      summary: 'Updated title',
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TAP-1',
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
      key: 'TAP-1',
      transitionId: '41',
    });

    expect(mockJira.transitionIssue).toHaveBeenCalledWith('TAP-1', '41', {
      comment: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TAP-1',
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
      key: 'TAP-1',
      transitionName: 'In Progress',
    });

    expect(mockJira.listTransitions).toHaveBeenCalledWith('TAP-1');
    expect(mockJira.transitionIssue).toHaveBeenCalledWith('TAP-1', '41', {
      comment: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TAP-1',
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
      key: 'TAP-1',
      transitionName: 'in progress',
    });

    expect(mockJira.transitionIssue).toHaveBeenCalledWith('TAP-1', '31', {
      comment: undefined,
    });
    expect(JSON.parse(result.content[0].text).transitionId).toBe('31');
  });

  it('passes comment during transition', async () => {
    mockJira.transitionIssue.mockResolvedValue(undefined);

    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });
    await handler({
      key: 'TAP-1',
      transitionId: '41',
      comment: 'Moving along',
    });

    expect(mockJira.transitionIssue).toHaveBeenCalledWith('TAP-1', '41', {
      comment: 'Moving along',
    });
  });

  it('throws when transition name not found', async () => {
    mockJira.listTransitions.mockResolvedValue([
      { id: '41', name: 'In Progress', to: { id: '3' } },
    ]);

    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });

    await expect(
      handler({ key: 'TAP-1', transitionName: 'Unknown' }),
    ).rejects.toThrow(McpError);
    await expect(
      handler({ key: 'TAP-1', transitionName: 'Unknown' }),
    ).rejects.toThrow(
      'Transition "Unknown" not found. Available: In Progress',
    );
  });

  it('throws when neither transitionId nor transitionName provided', async () => {
    const handler = jiraTransitionIssueHandler({ jira: mockJira as any });

    await expect(handler({ key: 'TAP-1' })).rejects.toThrow(McpError);
    await expect(handler({ key: 'TAP-1' })).rejects.toThrow(
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
    const result = await handler({ key: 'TAP-1', assignee: 'me' });

    expect(mockJira.assignToMe).toHaveBeenCalledWith('TAP-1');
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TAP-1',
      assignee: 'Current User',
    });
  });

  it('uses "me" assignee when passed explicitly', async () => {
    mockJira.assignToMe.mockResolvedValue({ displayName: 'Default User' });

    // Note: handler receives raw args (Zod defaults not applied), so 'me' must be explicit
    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', assignee: 'me' });

    expect(mockJira.assignToMe).toHaveBeenCalledWith('TAP-1');
    expect(JSON.parse(result.content[0].text).assignee).toBe('Default User');
  });

  it('unassigns (none)', async () => {
    mockJira.assignIssue.mockResolvedValue(undefined);

    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', assignee: 'none' });

    expect(mockJira.assignIssue).toHaveBeenCalledWith('TAP-1', null);
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TAP-1',
      assignee: null,
    });
  });

  it('assigns to a specific user by display name', async () => {
    mockJira.searchUsers.mockResolvedValue([
      { accountId: 'abc-123', displayName: 'John Doe', emailAddress: 'john@example.com' },
    ]);
    mockJira.assignIssue.mockResolvedValue(undefined);

    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    const result = await handler({
      key: 'TAP-1',
      assignee: 'John Doe',
    });

    expect(mockJira.searchUsers).toHaveBeenCalledWith('John Doe');
    expect(mockJira.assignIssue).toHaveBeenCalledWith('TAP-1', 'abc-123');
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TAP-1',
      assignee: 'John Doe',
    });
  });

  it('throws when user search returns no results', async () => {
    mockJira.searchUsers.mockResolvedValue([]);

    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    await expect(
      handler({ key: 'TAP-1', assignee: 'Unknown User' }),
    ).rejects.toThrow('No user found matching "Unknown User"');
  });

  it('throws when user search returns multiple results', async () => {
    mockJira.searchUsers.mockResolvedValue([
      { accountId: 'a1', displayName: 'John Doe' },
      { accountId: 'a2', displayName: 'John Doe' },
    ]);

    const handler = jiraAssignIssueHandler({ jira: mockJira as any });
    await expect(
      handler({ key: 'TAP-1', assignee: 'John Doe' }),
    ).rejects.toThrow('Multiple users match');
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
    const result = await handler({ key: 'TAP-1', body: 'Thanks!' });

    expect(mockJira.addComment).toHaveBeenCalledWith('TAP-1', 'Thanks!');
    expect(JSON.parse(result.content[0].text)).toEqual(comment);
  });

  it('replies in a thread when parentId is given and returns the posted comment', async () => {
    const comment = { id: '48838', parentId: '48106' };
    mockJira.addComment.mockResolvedValue(comment);

    const handler = jiraAddCommentHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', body: 'Thanks!', parentId: '48106' });

    expect(mockJira.addComment).toHaveBeenCalledWith('TAP-1', 'Thanks!', '48106');
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
    const result = await handler({ key: 'TAP-799', commentId: '38560', body: 'Revised.' });

    expect(mockJira.updateComment).toHaveBeenCalledWith('TAP-799', '38560', 'Revised.');
    expect(JSON.parse(result.content[0].text)).toEqual(comment);
  });
});

describe('jiraAddCommentSchema parentId', () => {
  const base = { key: 'TAP-1', body: 'Thanks!' };

  it('accepts a numeric parentId', () => {
    expect(jiraAddCommentSchema.safeParse({ ...base, parentId: '48106' }).success).toBe(true);
  });

  it('keeps parentId optional', () => {
    expect(jiraAddCommentSchema.safeParse(base).success).toBe(true);
  });

  it.each(['abc', '48106abc', '48 106', '-1', ''])('rejects a non-numeric parentId %j', (parentId) => {
    expect(jiraAddCommentSchema.safeParse({ ...base, parentId }).success).toBe(false);
  });

  it('is advertised as an optional property on the jira_add_comment descriptor', () => {
    const descriptor = jiraToolDescriptors.find((d) => d.name === 'jira_add_comment')!;
    const schema = descriptor.inputSchema as { properties: Record<string, unknown>; required?: string[] };

    expect(schema.properties).toHaveProperty('parentId');
    expect(schema.required).not.toContain('parentId');
  });
});

describe('comment body schemas', () => {
  it.each([
    ['jiraAddCommentSchema', jiraAddCommentSchema],
    ['jiraUpdateCommentSchema', jiraUpdateCommentSchema],
  ])('%s documents the mention token syntax', (_name, schema) => {
    expect(schema.shape.body.description).toContain('[~accountid:<accountId>]');
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
      inwardKey: 'TAP-1',
      outwardKey: 'TAP-2',
      type: 'Blocks',
    });

    expect(mockJira.listIssueLinkTypes).toHaveBeenCalled();
    expect(mockJira.linkIssues).toHaveBeenCalledWith({
      type: 'Blocks',
      inwardKey: 'TAP-1',
      outwardKey: 'TAP-2',
      comment: undefined,
    });
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      type: 'Blocks',
      inwardKey: 'TAP-1',
      outwardKey: 'TAP-2',
    });
  });

  it('matches link type case-insensitively', async () => {
    mockJira.listIssueLinkTypes.mockResolvedValue([
      { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    ]);
    mockJira.linkIssues.mockResolvedValue(undefined);

    const handler = jiraLinkIssuesHandler({ jira: mockJira as any });
    const result = await handler({
      inwardKey: 'TAP-1',
      outwardKey: 'TAP-2',
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
      inwardKey: 'TAP-1',
      outwardKey: 'TAP-2',
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
        inwardKey: 'TAP-1',
        outwardKey: 'TAP-2',
        type: 'InvalidType',
      }),
    ).rejects.toThrow(McpError);
    await expect(
      handler({
        inwardKey: 'TAP-1',
        outwardKey: 'TAP-2',
        type: 'InvalidType',
      }),
    ).rejects.toThrow('Link type "InvalidType" not found. Available: Blocks');
  });
});

describe('jiraGetCommentsHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('returns paginated comments with default limit', async () => {
    const comments = Array.from({ length: 10 }, (_, i) => ({
      id: String(i + 1),
      author: { displayName: `User ${i + 1}` },
      body: { type: 'doc', content: [] },
      created: '2025-01-01T00:00:00Z',
      updated: '2025-01-01T00:00:00Z',
    }));
    mockJira.getComments.mockResolvedValue(comments);

    const handler = jiraGetCommentsHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1' });

    expect(mockJira.getComments).toHaveBeenCalledWith('TAP-1');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(10);
    expect(parsed.hasMore).toBe(false);
  });

  it('respects limit parameter', async () => {
    const comments = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
    }));
    mockJira.getComments.mockResolvedValue(comments);

    const handler = jiraGetCommentsHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', limit: 10 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(10);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('10');
  });

  it('uses cursor for offset-based pagination', async () => {
    const comments = Array.from({ length: 100 }, (_, i) => ({
      id: String(i + 1),
    }));
    mockJira.getComments.mockResolvedValue(comments);

    const handler = jiraGetCommentsHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', limit: 10, cursor: '20' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(10);
    expect(parsed.items[0].id).toBe('21');
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextPageToken).toBe('30');
  });

  it('hasMore is false for last page', async () => {
    const comments = Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1) }));
    mockJira.getComments.mockResolvedValue(comments);

    const handler = jiraGetCommentsHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', limit: 10 });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.items).toHaveLength(5);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextPageToken).toBeUndefined();
  });
});

describe('jiraListTransitionsHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('lists transitions for an issue', async () => {
    const transitions = [
      { id: '41', name: 'In Progress' },
      { id: '31', name: 'Done' },
    ];
    mockJira.listTransitions.mockResolvedValue(transitions);

    const handler = jiraListTransitionsHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1' });

    expect(mockJira.listTransitions).toHaveBeenCalledWith('TAP-1');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(transitions);
  });
});

describe('jiraListIssueLinkTypesHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('lists issue link types', async () => {
    const linkTypes = [
      { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' },
    ];
    mockJira.listIssueLinkTypes.mockResolvedValue(linkTypes);

    const handler = jiraListIssueLinkTypesHandler({ jira: mockJira as any });
    const result = await handler({});

    expect(mockJira.listIssueLinkTypes).toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(linkTypes);
  });
});

describe('jiraSearchUsersHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('searches users by query', async () => {
    const users = [
      { accountId: 'abc', displayName: 'John Doe', emailAddress: 'john@example.com' },
    ];
    mockJira.searchUsers.mockResolvedValue(users);

    const handler = jiraSearchUsersHandler({ jira: mockJira as any });
    const result = await handler({ query: 'John' });

    expect(mockJira.searchUsers).toHaveBeenCalledWith('John');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(users);
  });
});

describe('jiraListFieldsHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('returns all fields when no search filter given', async () => {
    const fields = [
      { id: 'summary', name: 'Summary', custom: false },
      { id: 'customfield_10058', name: 'Story Points', custom: true },
    ];
    mockJira.getFields.mockResolvedValue(fields);

    const handler = jiraListFieldsHandler({ jira: mockJira as any });
    const result = await handler({});

    expect(mockJira.getFields).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result.content[0].text)).toEqual(fields);
  });

  it('filters fields by case-insensitive name substring', async () => {
    const fields = [
      { id: 'summary', name: 'Summary', custom: false },
      { id: 'customfield_10058', name: 'Story Points', custom: true },
      { id: 'customfield_10016', name: 'Story point estimate', custom: true },
      { id: 'customfield_10020', name: 'Sprint', custom: true },
    ];
    mockJira.getFields.mockResolvedValue(fields);

    const handler = jiraListFieldsHandler({ jira: mockJira as any });
    const result = await handler({ search: 'STORY' });

    const items = JSON.parse(result.content[0].text);
    expect(items).toHaveLength(2);
    expect(items.map((f: any) => f.id).sort()).toEqual(['customfield_10016', 'customfield_10058']);
  });
});

describe('jiraDeleteCommentHandler', () => {
  let mockJira: MockJira;

  beforeEach(() => {
    vi.clearAllMocks();
    mockJira = makeMockJira();
  });

  it('deletes a comment and returns success', async () => {
    mockJira.deleteComment.mockResolvedValue(undefined);

    const handler = jiraDeleteCommentHandler({ jira: mockJira as any });
    const result = await handler({ key: 'TAP-1', commentId: '12345' });

    expect(mockJira.deleteComment).toHaveBeenCalledWith('TAP-1', '12345');
    expect(JSON.parse(result.content[0].text)).toEqual({
      success: true,
      key: 'TAP-1',
      commentId: '12345',
    });
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
    const result = await handler({ attachmentId: '39824', issueKey: 'TAP-1260' });

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
      issueKey: 'TAP-1260',
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
