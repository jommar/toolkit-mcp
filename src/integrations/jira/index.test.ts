import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { contentText, inputJsonSchema, promptText, rawToolHandlers } from '../../__fixtures__/mcp.js';

// Resolve the jira-cli import (used as a type in the module implementation)
vi.mock('../../services/index.js', async () => {
  const actualSlim = await vi.importActual<Record<string, unknown>>('../../services/slim.js');
  return {
    JiraClient: class MockJiraClient {},
    toSlimIssue: vi.fn((issue: any) => issue),
    toSlimChangelog: actualSlim.toSlimChangelog,
    describeError: (await vi.importActual<typeof import('../../services/jira/jira-client.js')>(
      '../../services/jira/jira-client.js',
    )).describeError,
    DEV_FIELDS: ['summary', 'status', 'issuetype', 'assignee', 'reporter', 'priority', 'labels', 'created', 'updated', 'parent', 'subtasks', 'description', 'comment', 'attachment'],
    ISSUE_KEY_PATTERN: /^[A-Z][A-Z0-9]{0,10}-\d{1,6}$/i,
  };
});

import { JiraModule } from './index.js';

function makeMockJira() {
  return {
    whoami: vi.fn(),
    getIssue: vi.fn(),
    getIssueSlim: vi.fn(),
    search: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    listTransitions: vi.fn(),
    searchSlim: vi.fn(),
    transitionIssue: vi.fn(),
    assignIssue: vi.fn(),
    assignToMe: vi.fn(),
    searchUsers: vi.fn(),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    deleteComment: vi.fn(),
    getComments: vi.fn(),
    getChangelogs: vi.fn(),
    listIssueLinkTypes: vi.fn(),
    listProjectComponents: vi.fn(),
    linkIssues: vi.fn(),
  };
}

type MockJira = ReturnType<typeof makeMockJira>;

describe('JiraModule', () => {
  let mod: JiraModule;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mod = new JiraModule();
  });

  describe('id', () => {
    it('returns "jira"', () => {
      expect(mod.id).toBe('jira');
    });
  });

  describe('needsEnv', () => {
    beforeEach(() => {
      // Jira env vars may be set from .env — clear for predictable tests
      delete process.env.JIRA_BASE_URL;
      delete process.env.JIRA_EMAIL;
      delete process.env.JIRA_TOKEN;
    });

    it('returns true when all Jira env vars are set', () => {
      vi.stubEnv('JIRA_BASE_URL', 'https://test.atlassian.net');
      vi.stubEnv('JIRA_EMAIL', 'bot@test.com');
      vi.stubEnv('JIRA_TOKEN', 'tok_123');
      expect(mod.needsEnv()).toBe(true);
    });

    it('returns false when JIRA_BASE_URL is missing', () => {
      vi.stubEnv('JIRA_EMAIL', 'bot@test.com');
      vi.stubEnv('JIRA_TOKEN', 'tok_123');
      expect(mod.needsEnv()).toBe(false);
    });

    it('returns false when JIRA_EMAIL is missing', () => {
      vi.stubEnv('JIRA_BASE_URL', 'https://test.atlassian.net');
      vi.stubEnv('JIRA_TOKEN', 'tok_123');
      expect(mod.needsEnv()).toBe(false);
    });

    it('returns false when JIRA_TOKEN is missing', () => {
      vi.stubEnv('JIRA_BASE_URL', 'https://test.atlassian.net');
      vi.stubEnv('JIRA_EMAIL', 'bot@test.com');
      expect(mod.needsEnv()).toBe(false);
    });

    it('returns false when all Jira env vars are empty', () => {
      vi.stubEnv('JIRA_BASE_URL', '');
      vi.stubEnv('JIRA_EMAIL', '');
      vi.stubEnv('JIRA_TOKEN', '');
      expect(mod.needsEnv()).toBe(false);
    });
  });

  describe('createToolHandlers', () => {
    let mockJira: MockJira;

    beforeEach(() => {
      mockJira = makeMockJira();
    });

    it('returns all 18 handlers', () => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      expect(Object.keys(handlers)).toHaveLength(18);
      expect(handlers).toHaveProperty('jira_whoami');
      expect(handlers).toHaveProperty('jira_get_issues');
      expect(handlers).toHaveProperty('jira_create_issue');
      expect(handlers).toHaveProperty('jira_update_issue');
      expect(handlers).toHaveProperty('jira_transition_issue');
      expect(handlers).toHaveProperty('jira_assign_issue');
      expect(handlers).toHaveProperty('jira_add_comment');
      expect(handlers).toHaveProperty('jira_update_comment');
      expect(handlers).toHaveProperty('jira_link_issues');
      expect(handlers).toHaveProperty('jira_get_attachment');
      expect(handlers).toHaveProperty('jira_get_comments');
      expect(handlers).toHaveProperty('jira_get_changelogs');
      expect(handlers).toHaveProperty('jira_list_transitions');
      expect(handlers).toHaveProperty('jira_list_issue_link_types');
      expect(handlers).toHaveProperty('jira_search_users');
      expect(handlers).toHaveProperty('jira_list_fields');
      expect(handlers).toHaveProperty('jira_list_components');
      expect(handlers).toHaveProperty('jira_delete_comment');
    });

    it('jira_whoami calls whoami on the client', async () => {
      mockJira.whoami.mockResolvedValue({ displayName: 'Bot' });
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      const result = await handlers.jira_whoami({});
      expect(mockJira.whoami).toHaveBeenCalled();
      expect(JSON.parse(contentText(result)).displayName).toBe('Bot');
    });

    it('jira_get_issues parses and delegates', async () => {
      mockJira.getIssueSlim.mockResolvedValue({ key: 'TAP-1' });
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      const result = await handlers.jira_get_issues({ key: 'TAP-1' });
      const parsed = JSON.parse(contentText(result));
      expect(parsed.items).toHaveLength(1);
    });

    describe('jira_get_issues linked context', () => {
      const issue = { id: '1', key: 'TAP-1', fields: { summary: 'Test' } };

      beforeEach(() => {
        mockJira.getIssue.mockResolvedValue(issue);
      });

      it('hands the GitHub client the issue key when includeGithubPrs is set', async () => {
        const findPrsForIssueKeys = vi.fn().mockResolvedValue(new Map());
        const handlers = rawToolHandlers(mod, { jira: mockJira as any, github: { findPrsForIssueKeys } as any });

        const result = await handlers.jira_get_issues({ key: 'TAP-1', includeGithubPrs: true });

        expect(findPrsForIssueKeys).toHaveBeenCalledWith(['TAP-1'], 'all');
        expect(JSON.parse(contentText(result)).items[0].pullRequests).toEqual([]);
      });

      it('hands the Slack client the issue key when includeSlackThreads is set', async () => {
        const slack = {
          teamUrl: vi.fn().mockResolvedValue('https://example-team.slack.com/'),
          searchMessages: vi.fn().mockResolvedValue({ ok: true, messages: { matches: [] } }),
        };
        const handlers = rawToolHandlers(mod, { jira: mockJira as any, slack: slack as any });

        const result = await handlers.jira_get_issues({ key: 'TAP-1', includeSlackThreads: true });

        expect(slack.searchMessages).toHaveBeenCalledWith(
          expect.objectContaining({ query: expect.stringContaining('"TAP-1"') }),
        );
        expect(JSON.parse(contentText(result)).items[0].slackThreads).toEqual([]);
      });

      it('answers with a warning, not an error, when a flag is set and the integration is not active', async () => {
        const handlers = rawToolHandlers(mod, { jira: mockJira as any });

        const result = await handlers.jira_get_issues({ key: 'TAP-1', includeGithubPrs: true });

        const parsed = JSON.parse(contentText(result));
        expect(parsed.items[0].key).toBe('TAP-1');
        expect(parsed.warnings).toEqual([expect.objectContaining({ source: 'github' })]);
      });

      it('rejects a non-boolean flag before any lookup', async () => {
        const findPrsForIssueKeys = vi.fn();
        const handlers = rawToolHandlers(mod, { jira: mockJira as any, github: { findPrsForIssueKeys } as any });

        await expect(handlers.jira_get_issues({ key: 'TAP-1', includeGithubPrs: 'yes' })).rejects.toThrow();
        expect(findPrsForIssueKeys).not.toHaveBeenCalled();
      });
    });

    it('jira_create_issue validates required fields', async () => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await expect(
        handlers.jira_create_issue({}),
      ).rejects.toThrow();
    });

    it('jira_link_issues throws when required fields missing', async () => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await expect(
        handlers.jira_link_issues({ inwardKey: 'TAP-1' }),
      ).rejects.toThrow();
    });

    it('jira_list_components lists the project components via the client', async () => {
      mockJira.listProjectComponents.mockResolvedValue([{ id: '10040', name: 'EZAT Automation' }]);
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      const result = await handlers.jira_list_components({ projectKey: 'TAP' });
      expect(mockJira.listProjectComponents).toHaveBeenCalledWith('TAP');
      expect(JSON.parse(contentText(result))).toEqual({
        items: [{ id: '10040', name: 'EZAT Automation' }],
        hasMore: false,
      });
    });

    it('jira_update_issue resolves component names to ids', async () => {
      mockJira.listProjectComponents.mockResolvedValue([{ id: '10040', name: 'EZAT Automation' }]);
      mockJira.updateIssue.mockResolvedValue(undefined);
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await handlers.jira_update_issue({ key: 'TAP-1', fields: {}, components: ['ezat automation'] });
      expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', { components: [{ id: '10040' }] });
    });

    it('jira_update_issue changes only components when fields is omitted', async () => {
      mockJira.listProjectComponents.mockResolvedValue([{ id: '10040', name: 'EZAT Automation' }]);
      mockJira.updateIssue.mockResolvedValue(undefined);
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      const result = await handlers.jira_update_issue({ key: 'TAP-1', components: ['ezat automation'] });
      expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', { components: [{ id: '10040' }] });
      expect(JSON.parse(contentText(result))).toEqual({ success: true, key: 'TAP-1' });
    });

    it('jira_update_issue passes fields-only updates through unchanged', async () => {
      mockJira.updateIssue.mockResolvedValue(undefined);
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await handlers.jira_update_issue({ key: 'TAP-1', fields: { summary: 'New' } });
      expect(mockJira.listProjectComponents).not.toHaveBeenCalled();
      expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', { summary: 'New' });
    });

    it('jira_update_issue still accepts an explicit empty fields object', async () => {
      mockJira.updateIssue.mockResolvedValue(undefined);
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await handlers.jira_update_issue({ key: 'TAP-1', fields: {} });
      expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', {});
    });

    it('jira_update_issue rejects neither fields nor components before any API call', async () => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await expect(handlers.jira_update_issue({ key: 'TAP-1' })).rejects.toThrow('Provide fields and/or components');
      expect(mockJira.listProjectComponents).not.toHaveBeenCalled();
      expect(mockJira.updateIssue).not.toHaveBeenCalled();
    });

    it('jira_update_issue rejects an empty components array so it can never clear them', async () => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await expect(
        handlers.jira_update_issue({ key: 'TAP-1', fields: {}, components: [] }),
      ).rejects.toThrow();
      expect(mockJira.updateIssue).not.toHaveBeenCalled();
    });

    it('jira_add_comment forwards a numeric parentId to the client', async () => {
      mockJira.addComment.mockResolvedValue({ id: '48838' });
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await handlers.jira_add_comment({ key: 'TAP-1', body: 'hi', parentId: '48106' });
      expect(mockJira.addComment).toHaveBeenCalledWith('TAP-1', 'hi', '48106', 'text');
    });

    it('jira_add_comment defaults format to text and forwards an explicit one', async () => {
      mockJira.addComment.mockResolvedValue({ id: '1' });
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await handlers.jira_add_comment({ key: 'TAP-1', body: 'hi' });
      await handlers.jira_add_comment({ key: 'TAP-1', body: '# hi', format: 'markdown' });
      expect(mockJira.addComment).toHaveBeenNthCalledWith(1, 'TAP-1', 'hi', undefined, 'text');
      expect(mockJira.addComment).toHaveBeenNthCalledWith(2, 'TAP-1', '# hi', undefined, 'markdown');
    });

    it('jira_update_comment defaults format to text and forwards an explicit one', async () => {
      mockJira.updateComment.mockResolvedValue({ id: '2' });
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await handlers.jira_update_comment({ key: 'TAP-1', commentId: '2', body: 'hi' });
      await handlers.jira_update_comment({ key: 'TAP-1', commentId: '2', body: '{}', format: 'adf' });
      expect(mockJira.updateComment).toHaveBeenNthCalledWith(1, 'TAP-1', '2', 'hi', 'text');
      expect(mockJira.updateComment).toHaveBeenNthCalledWith(2, 'TAP-1', '2', '{}', 'adf');
    });

    it.each(['jira_add_comment', 'jira_update_comment'])('%s rejects an unknown format without writing', async (tool) => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await expect(
        handlers[tool]({ key: 'TAP-1', commentId: '2', body: 'hi', format: 'html' }),
      ).rejects.toThrow();
      expect(mockJira.addComment).not.toHaveBeenCalled();
      expect(mockJira.updateComment).not.toHaveBeenCalled();
    });

    it('jira_add_comment rejects a non-numeric parentId without posting', async () => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await expect(
        handlers.jira_add_comment({ key: 'TAP-1', body: 'hi', parentId: 'abc' }),
      ).rejects.toThrow();
      expect(mockJira.addComment).not.toHaveBeenCalled();
    });

    it('jira_transition_issue enforces its refine before any API call', async () => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await expect(handlers.jira_transition_issue({ key: 'TAP-1' })).rejects.toThrow(
        'Provide either transitionId or transitionName',
      );
      expect(mockJira.listTransitions).not.toHaveBeenCalled();
      expect(mockJira.transitionIssue).not.toHaveBeenCalled();
    });

    it('jira_get_issues search pages with the schema default limit of 20', async () => {
      mockJira.search.mockResolvedValue({ issues: [], total: 0, isLast: true });
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await handlers.jira_get_issues({ jql: 'project = TAP' });
      expect(mockJira.search).toHaveBeenCalledWith('project = TAP', expect.objectContaining({ maxResults: 20 }));
    });

    it.each([
      ['jira_get_issues', { jql: 'project = TAP' }, 'search'],
      ['jira_get_comments', { key: 'TAP-1' }, 'getComments'],
    ] as const)('%s rejects limit above 100 without calling the client', async (tool, base, method) => {
      const handlers = rawToolHandlers(mod, { jira: mockJira as any });
      await expect(handlers[tool]({ ...base, limit: 101 })).rejects.toBeInstanceOf(z.ZodError);
      expect(mockJira[method]).not.toHaveBeenCalled();
    });
  });

  describe('getToolDescriptors', () => {
    it('returns 18 tool descriptors', () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors).toHaveLength(18);
    });

    it('registers jira_get_changelogs with a keys array string schema', () => {
      const descriptor = mod.getToolDescriptors().find((d) => d.name === 'jira_get_changelogs');
      expect(descriptor).toBeDefined();
      expect(descriptor!.description).toBeTruthy();
      const schema = inputJsonSchema(descriptor!) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.required).toContain('keys');
      expect(schema.properties?.keys).toMatchObject({
        type: 'array',
        items: { type: 'string' },
      });
    });

    it('has a descriptor for every handler', () => {
      const handlerNames = Object.keys(mod.createToolHandlers({ jira: makeMockJira() as any })).sort();
      expect(mod.getToolDescriptors().map((d) => d.name).sort()).toEqual(handlerNames);
    });

    it('each descriptor has name, description, and inputSchema', () => {
      const descriptors = mod.getToolDescriptors();
      for (const d of descriptors) {
        expect(d).toHaveProperty('name');
        expect(d).toHaveProperty('description');
        expect(d).toHaveProperty('inputSchema');
      }
    });

    it('includes jira_whoami as first descriptor', () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors[0].name).toBe('jira_whoami');
    });
  });

  describe('getResourceHandler', () => {
    let mockJira: MockJira;

    beforeEach(() => {
      mockJira = makeMockJira();
    });

    it('resolves jira://issue/<key>', async () => {
      mockJira.getIssueSlim.mockResolvedValue({ key: 'TAP-1', summary: 'Test' });
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      const result = await rh('jira://issue/TAP-1');

      expect(mockJira.getIssueSlim).toHaveBeenCalledWith('TAP-1');
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('jira://issue/TAP-1');
      expect(result.contents[0].mimeType).toBe('application/json');
    });

    it('resolves jira://search/<encoded JQL>', async () => {
      mockJira.searchSlim.mockResolvedValue([{ key: 'TAP-1' }]);
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      const result = await rh('jira://search/project%20%3D%20TAP');

      expect(mockJira.searchSlim).toHaveBeenCalledWith(
        'project = TAP',
        { maxResults: 20 },
      );
      expect(result.contents).toHaveLength(1);
    });

    it('resolves jira://myself', async () => {
      mockJira.whoami.mockResolvedValue({ displayName: 'Me' });
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      const result = await rh('jira://myself');

      expect(mockJira.whoami).toHaveBeenCalled();
      expect(result.contents[0].uri).toBe('jira://myself');
    });

    it('decodes a JQL holding a slash before searching', async () => {
      mockJira.searchSlim.mockResolvedValue([]);
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      await rh('jira://search/project%20%3D%20TAP%20AND%20text%20~%20a/b');

      expect(mockJira.searchSlim).toHaveBeenCalledWith('project = TAP AND text ~ a/b', { maxResults: 20 });
    });

    it('throws ResourceNotFoundError carrying the URI for an unknown URI', async () => {
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      const call = rh('jira://unknown');
      await expect(call).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(call).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams, data: { uri: 'jira://unknown' } });
    });

    it.each([
      ['jira://issue/', 'Missing issue key'],
      ['jira://issue/notakey', 'Invalid issue key format'],
      ['jira://search/', 'Missing JQL query'],
    ])('throws InvalidParams for %s with "%s"', async (uri, message) => {
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      const call = rh(uri);
      await expect(call).rejects.toBeInstanceOf(ProtocolError);
      await expect(call).rejects.toMatchObject({ code: ProtocolErrorCode.InvalidParams });
      await expect(call).rejects.toThrow(message);
      expect(mockJira.getIssueSlim).not.toHaveBeenCalled();
      expect(mockJira.searchSlim).not.toHaveBeenCalled();
    });
  });

  describe('getResourceDescriptors', () => {
    it('describes jira://myself and the issue and search templates as titled JSON resources', () => {
      const descriptors = mod.getResourceDescriptors();
      const byAddress = Object.fromEntries(descriptors.map((d) => [d.uri ?? d.uriTemplate, d]));

      expect(Object.keys(byAddress).sort()).toEqual(['jira://issue/{key}', 'jira://myself', 'jira://search/{+jql}']);
      expect(byAddress['jira://myself'].uri).toBe('jira://myself');
      expect(byAddress['jira://issue/{key}'].uriTemplate).toBe('jira://issue/{key}');
      expect(byAddress['jira://search/{+jql}'].uriTemplate).toBe('jira://search/{+jql}');
      for (const d of descriptors) {
        expect(d.title).toBeTruthy();
        expect(d.description).toBeTruthy();
        expect(d.mimeType).toBe('application/json');
      }
    });
  });

  describe('getPromptDescriptors', () => {
    const required = (name: string) => {
      const descriptor = mod.getPromptDescriptors().find((d) => d.name === name)!;
      return (z.toJSONSchema(descriptor.argsSchema, { io: 'input' }) as { required?: string[] }).required ?? [];
    };

    it('describes create-issue and triage-issue with titles', () => {
      const descriptors = mod.getPromptDescriptors();
      expect(descriptors.map((d) => d.name).sort()).toEqual(['create-issue', 'triage-issue']);
      for (const d of descriptors) {
        expect(d.title).toBeTruthy();
        expect(d.description).toBeTruthy();
      }
    });

    it('requires projectKey, issueType and summary for create-issue', () => {
      expect(required('create-issue').sort()).toEqual(['issueType', 'projectKey', 'summary']);
    });

    it('requires key for triage-issue', () => {
      expect(required('triage-issue')).toEqual(['key']);
    });

    it('takes create-issue labels as an optional comma-separated string', () => {
      const { argsSchema } = mod.getPromptDescriptors().find((d) => d.name === 'create-issue')!;
      const base = { projectKey: 'TAP', issueType: 'Task', summary: 's' };
      expect(argsSchema.safeParse({ ...base, labels: 'a,b' }).success).toBe(true);
      expect(argsSchema.safeParse(base).success).toBe(true);
      expect(argsSchema.safeParse({ ...base, labels: ['a', 'b'] }).success).toBe(false);
    });
  });

  describe('getPromptHandler', () => {
    let mockJira: MockJira;

    beforeEach(() => {
      mockJira = makeMockJira();
    });

    it('returns create-issue prompt with required fields', async () => {
      const ph = mod.getPromptHandler({ jira: mockJira as any });
      const result = await ph('create-issue', {
        projectKey: 'TAP',
        issueType: 'Task',
        summary: 'Do the thing',
      });

      expect(result.messages).toHaveLength(1);
      const text = promptText(result);
      expect(text).toContain('TAP');
      expect(text).toContain('Task');
      expect(text).toContain('Do the thing');
      expect(text).toContain('jira_create_issue');
    });

    it('includes optional fields in create-issue prompt', async () => {
      const ph = mod.getPromptHandler({ jira: mockJira as any });
      const result = await ph('create-issue', {
        projectKey: 'TAP',
        issueType: 'Story',
        summary: 'New feature',
        description: 'Implement X',
        priority: 'High',
        labels: 'frontend,ux',
      });

      const text = promptText(result);
      expect(text).toContain('Priority: High');
      expect(text).toContain('Labels: frontend, ux');
      expect(text).toContain('Description provided');
    });

    it('throws create-issue when required fields missing', async () => {
      const ph = mod.getPromptHandler({ jira: mockJira as any });
      await expect(ph('create-issue', {})).rejects.toThrow();
    });

    it('returns triage-issue prompt', async () => {
      mockJira.getIssueSlim.mockResolvedValue({
        key: 'TAP-1',
        summary: 'Bug in login',
        status: 'In Progress',
        assignee: 'john',
        type: 'Bug',
        priority: 'High',
        description: 'Users cannot login',
        comments: [
          { created: '2024-01-01', author: 'alice', body: 'Looking into it' },
        ],
      });
      mockJira.listTransitions.mockResolvedValue([
        { id: '41', name: 'Done', to: { id: '3' } },
      ]);

      const ph = mod.getPromptHandler({ jira: mockJira as any });
      const result = await ph('triage-issue', { key: 'TAP-1' });

      const text = promptText(result);
      expect(text).toContain('TAP-1');
      expect(text).toContain('Bug in login');
      expect(text).toContain('In Progress');
      expect(text).toContain('john');
      expect(text).toContain('High');
      expect(text).toContain('Users cannot login');
      expect(text).toContain('alice');
      expect(text).toContain('Done');
    });

    it('throws triage-issue when key missing', async () => {
      const ph = mod.getPromptHandler({ jira: mockJira as any });
      await expect(ph('triage-issue', {})).rejects.toThrow();
    });

    it('handles triage-issue for issue with no comments', async () => {
      mockJira.getIssueSlim.mockResolvedValue({
        key: 'TAP-1',
        summary: 'Test',
        status: 'Open',
        assignee: null,
        type: null,
        priority: null,
        description: null,
        comments: [],
      });
      mockJira.listTransitions.mockResolvedValue([]);

      const ph = mod.getPromptHandler({ jira: mockJira as any });
      const result = await ph('triage-issue', { key: 'TAP-1' });

      const text = promptText(result);
      expect(text).toContain('unassigned');
      expect(text).toContain('none');
      expect(text).toContain('(no description)');
      expect(text).toContain('(none)');
    });

    it('throws for unknown prompt name', async () => {
      const ph = mod.getPromptHandler({ jira: mockJira as any });
      await expect(ph('unknown-prompt', {})).rejects.toThrow(
        'Unknown prompt',
      );
    });
  });
});
