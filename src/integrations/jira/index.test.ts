import { vi, describe, it, expect, beforeEach } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

// Resolve the jira-cli import (used as a type in the module implementation)
vi.mock('../../services/index.js', () => ({
  JiraClient: class MockJiraClient {},
  toSlimIssue: vi.fn((issue: any) => issue),
  DEV_FIELDS: ['summary', 'status', 'issuetype', 'assignee', 'reporter', 'priority', 'labels', 'created', 'updated', 'parent', 'subtasks', 'description', 'comment', 'attachment'],
  ISSUE_KEY_PATTERN: /^[A-Z][A-Z0-9]{0,10}-\d{1,6}$/i,
}));

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

    it('returns all 17 handlers', () => {
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      expect(Object.keys(handlers)).toHaveLength(17);
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
      expect(handlers).toHaveProperty('jira_list_transitions');
      expect(handlers).toHaveProperty('jira_list_issue_link_types');
      expect(handlers).toHaveProperty('jira_search_users');
      expect(handlers).toHaveProperty('jira_list_fields');
      expect(handlers).toHaveProperty('jira_list_components');
      expect(handlers).toHaveProperty('jira_delete_comment');
    });

    it('jira_whoami calls whoami on the client', async () => {
      mockJira.whoami.mockResolvedValue({ displayName: 'Bot' });
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      const result = await handlers.jira_whoami({});
      expect(mockJira.whoami).toHaveBeenCalled();
      expect(JSON.parse(result.content[0].text).displayName).toBe('Bot');
    });

    it('jira_get_issues parses and delegates', async () => {
      mockJira.getIssueSlim.mockResolvedValue({ key: 'TAP-1' });
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      const result = await handlers.jira_get_issues({ key: 'TAP-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.items).toHaveLength(1);
    });

    it('jira_create_issue validates required fields', async () => {
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await expect(
        handlers.jira_create_issue({}),
      ).rejects.toThrow();
    });

    it('jira_link_issues throws when required fields missing', async () => {
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await expect(
        handlers.jira_link_issues({ inwardKey: 'TAP-1' }),
      ).rejects.toThrow();
    });

    it('jira_list_components lists the project components via the client', async () => {
      mockJira.listProjectComponents.mockResolvedValue([{ id: '10040', name: 'EZAT Automation' }]);
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      const result = await handlers.jira_list_components({ projectKey: 'TAP' });
      expect(mockJira.listProjectComponents).toHaveBeenCalledWith('TAP');
      expect(JSON.parse(result.content[0].text)).toEqual({
        items: [{ id: '10040', name: 'EZAT Automation' }],
        hasMore: false,
      });
    });

    it('jira_update_issue resolves component names to ids', async () => {
      mockJira.listProjectComponents.mockResolvedValue([{ id: '10040', name: 'EZAT Automation' }]);
      mockJira.updateIssue.mockResolvedValue(undefined);
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await handlers.jira_update_issue({ key: 'TAP-1', fields: {}, components: ['ezat automation'] });
      expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', { components: [{ id: '10040' }] });
    });

    it('jira_update_issue changes only components when fields is omitted', async () => {
      mockJira.listProjectComponents.mockResolvedValue([{ id: '10040', name: 'EZAT Automation' }]);
      mockJira.updateIssue.mockResolvedValue(undefined);
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      const result = await handlers.jira_update_issue({ key: 'TAP-1', components: ['ezat automation'] });
      expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', { components: [{ id: '10040' }] });
      expect(JSON.parse(result.content[0].text)).toEqual({ success: true, key: 'TAP-1' });
    });

    it('jira_update_issue passes fields-only updates through unchanged', async () => {
      mockJira.updateIssue.mockResolvedValue(undefined);
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await handlers.jira_update_issue({ key: 'TAP-1', fields: { summary: 'New' } });
      expect(mockJira.listProjectComponents).not.toHaveBeenCalled();
      expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', { summary: 'New' });
    });

    it('jira_update_issue still accepts an explicit empty fields object', async () => {
      mockJira.updateIssue.mockResolvedValue(undefined);
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await handlers.jira_update_issue({ key: 'TAP-1', fields: {} });
      expect(mockJira.updateIssue).toHaveBeenCalledWith('TAP-1', {});
    });

    it('jira_update_issue rejects neither fields nor components before any API call', async () => {
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await expect(handlers.jira_update_issue({ key: 'TAP-1' })).rejects.toThrow('Provide fields and/or components');
      expect(mockJira.listProjectComponents).not.toHaveBeenCalled();
      expect(mockJira.updateIssue).not.toHaveBeenCalled();
    });

    it('jira_update_issue rejects an empty components array so it can never clear them', async () => {
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await expect(
        handlers.jira_update_issue({ key: 'TAP-1', fields: {}, components: [] }),
      ).rejects.toThrow();
      expect(mockJira.updateIssue).not.toHaveBeenCalled();
    });

    it('jira_add_comment forwards a numeric parentId to the client', async () => {
      mockJira.addComment.mockResolvedValue({ id: '48838' });
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await handlers.jira_add_comment({ key: 'TAP-1', body: 'hi', parentId: '48106' });
      expect(mockJira.addComment).toHaveBeenCalledWith('TAP-1', 'hi', '48106');
    });

    it('jira_add_comment rejects a non-numeric parentId without posting', async () => {
      const handlers = mod.createToolHandlers({ jira: mockJira as any });
      await expect(
        handlers.jira_add_comment({ key: 'TAP-1', body: 'hi', parentId: 'abc' }),
      ).rejects.toThrow();
      expect(mockJira.addComment).not.toHaveBeenCalled();
    });
  });

  describe('getToolDescriptors', () => {
    it('returns 17 tool descriptors', () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors).toHaveLength(17);
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

    it('throws for unknown URI', async () => {
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      await expect(rh('jira://unknown')).rejects.toThrow('Unknown resource');
    });

    it('throws when issue key is empty', async () => {
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      await expect(rh('jira://issue/')).rejects.toThrow('Missing issue key');
    });

    it('throws when JQL query is empty', async () => {
      const rh = mod.getResourceHandler({ jira: mockJira as any });
      await expect(rh('jira://search/')).rejects.toThrow('Missing JQL query');
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
      const text = result.messages[0].content.text;
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
        labels: ['frontend', 'ux'],
      });

      const text = result.messages[0].content.text;
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

      const text = result.messages[0].content.text;
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

      const text = result.messages[0].content.text;
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
