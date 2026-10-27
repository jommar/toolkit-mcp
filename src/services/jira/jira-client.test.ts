import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { JiraClient, describeError } from './jira-client.js';
import { toSlimComment } from '../slim.js';

// Mock axios.create — keep real AxiosError and isAxiosError
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

// Mock config to return known values without env vars
vi.mock('../config.js', () => ({
  loadConfig: () => ({
    baseUrl: 'https://test.atlassian.net',
    email: 'test@example.com',
    token: 'test-token',
  }),
  loadConfluenceConfig: () => ({
    baseUrl: 'https://test.atlassian.net/wiki',
    email: 'test@example.com',
    token: 'test-token',
  }),
  DEV_FIELDS: ['summary', 'status', 'issuetype', 'assignee', 'reporter', 'priority', 'labels', 'created', 'updated', 'parent', 'subtasks', 'description', 'comment', 'attachment'],
}));

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

describe('JiraClient', () => {
  let http: MockAxiosInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    http = mockAxiosInstance();
  });

  describe('constructor', () => {
    it('creates axios instance with correct baseURL and auth', () => {
      new JiraClient();
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'https://test.atlassian.net/rest/api/3',
          auth: { username: 'test@example.com', password: 'test-token' },
          headers: expect.objectContaining({
            Accept: 'application/json',
            'Content-Type': 'application/json',
          }),
          timeout: 30_000,
        }),
      );
    });

    it('registers a response interceptor for retry', () => {
      new JiraClient();
      expect(http.interceptors.response.use).toHaveBeenCalledWith(undefined, expect.any(Function));
    });
  });

  describe('whoami', () => {
    it('calls GET /myself and returns the user', async () => {
      const user = { accountId: 'abc', displayName: 'Test', emailAddress: 'test@test.com' };
      http.get.mockResolvedValueOnce({ data: user });

      const client = new JiraClient();
      const result = await client.whoami();

      expect(http.get).toHaveBeenCalledWith('/myself');
      expect(result).toEqual(user);
    });
  });

  describe('getIssue', () => {
    it('calls GET /issue/{key} with no fields', async () => {
      const issue = { id: '1', key: 'TAP-1', fields: {} };
      http.get.mockResolvedValueOnce({ data: issue });

      const client = new JiraClient();
      const result = await client.getIssue('TAP-1');

      expect(http.get).toHaveBeenCalledWith('/issue/TAP-1', { params: undefined });
      expect(result).toEqual(issue);
    });

    it('passes fields param when provided', async () => {
      http.get.mockResolvedValueOnce({ data: { id: '1', key: 'TAP-1', fields: {} } });

      const client = new JiraClient();
      await client.getIssue('TAP-1', ['summary', 'status']);

      expect(http.get).toHaveBeenCalledWith('/issue/TAP-1', {
        params: { fields: 'summary,status' },
      });
    });

    it('encodes the issue key', async () => {
      http.get.mockResolvedValueOnce({ data: { id: '1', key: 'TEST-1', fields: {} } });

      const client = new JiraClient();
      await client.getIssue('TEST-1');

      expect(http.get).toHaveBeenCalledWith('/issue/TEST-1', expect.anything());
    });
  });

  describe('getIssueSlim', () => {
    it('calls getIssue with DEV_FIELDS and maps to SlimIssue', async () => {
      const raw = {
        id: '1',
        key: 'TAP-1',
        fields: {
          summary: 'Test issue',
          status: { name: 'In Progress' },
          issuetype: { name: 'Bug' },
          assignee: { displayName: 'Alice' },
          reporter: { displayName: 'Bob' },
          priority: { name: 'High' },
          labels: ['bug'],
          created: '2025-01-01T00:00:00Z',
          updated: '2025-01-02T00:00:00Z',
          parent: { key: 'EPIC-1' },
          subtasks: [{ key: 'SUB-1' }],
          description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'desc' }] }] },
          comment: { total: 1, comments: [{ id: 'c1', author: { displayName: 'Alice' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nice' }] }] }, created: '2025-01-01T00:00:00Z' }] },
          attachment: [{ id: 'a1', filename: 'file.txt', author: { displayName: 'Alice' }, created: '2025-01-01T00:00:00Z', size: 100, mimeType: 'text/plain', content: 'http://example.com/file.txt', thumbnail: null }],
        },
      };
      http.get.mockResolvedValueOnce({ data: raw });

      const client = new JiraClient();
      const result = await client.getIssueSlim('TAP-1');

      expect(http.get).toHaveBeenCalledWith('/issue/TAP-1', {
        params: { fields: expect.stringContaining('summary') },
      });
      expect(result.key).toBe('TAP-1');
      expect(result.summary).toBe('Test issue');
      expect(result.status).toBe('In Progress');
      expect(result.type).toBe('Bug');
      expect(result.assignee).toBe('Alice');
      expect(result.reporter).toBe('Bob');
      expect(result.priority).toBe('High');
      expect(result.labels).toEqual(['bug']);
      expect(result.parent).toBe('EPIC-1');
      expect(result.subtasks).toEqual(['SUB-1']);
      expect(result.description).toBe('desc');
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].body).toBe('Nice');
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].filename).toBe('file.txt');
    });

    it('refetches comments when comment.total > comment.comments.length', async () => {
      const raw = {
        id: '1',
        key: 'TAP-1',
        fields: {
          summary: 'Test',
          status: { name: 'Open' },
          comment: { total: 5, comments: [{ id: 'c1', body: { type: 'doc', content: [] } }] },
        },
      };
      http.get.mockResolvedValueOnce({ data: raw });
      // getComments response — total matches comments.length so pagination stops
      http.get.mockResolvedValueOnce({
        data: {
          comments: [
            { id: 'c1', author: { displayName: 'A' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Full comment' }] }] }, created: '2025-01-01T00:00:00Z' },
          ],
          total: 1,
        },
      });

      const client = new JiraClient();
      const result = await client.getIssueSlim('TAP-1');

      // Should have called getComments for the second request
      expect(http.get).toHaveBeenCalledTimes(2);
      expect(http.get).toHaveBeenNthCalledWith(2, '/issue/TAP-1/comment', {
        params: { startAt: 0, maxResults: 100 },
      });
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0].body).toBe('Full comment');
    });

    it('does not refetch comments when total matches comments length', async () => {
      const raw = {
        id: '1',
        key: 'TAP-1',
        fields: {
          summary: 'Test',
          status: { name: 'Open' },
          comment: { total: 1, comments: [{ id: 'c1', body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }] } }] },
        },
      };
      http.get.mockResolvedValueOnce({ data: raw });

      const client = new JiraClient();
      await client.getIssueSlim('TAP-1');

      // Only one GET call (getIssue), no additional getComments
      expect(http.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('getComments', () => {
    it('paginates through comments using startAt/total', async () => {
      // Page 1: 2 comments, total: 3
      http.get.mockResolvedValueOnce({
        data: {
          comments: [
            { id: 'c1', author: { displayName: 'A' }, body: { type: 'doc', content: [] }, created: '2025-01-01T00:00:00Z' },
            { id: 'c2', author: { displayName: 'B' }, body: { type: 'doc', content: [] }, created: '2025-01-02T00:00:00Z' },
          ],
          total: 3,
        },
      });
      // Page 2: 1 remaining comment
      http.get.mockResolvedValueOnce({
        data: {
          comments: [
            { id: 'c3', author: { displayName: 'C' }, body: { type: 'doc', content: [] }, created: '2025-01-03T00:00:00Z' },
          ],
          total: 3,
        },
      });

      const client = new JiraClient();
      const result = await client.getComments('TAP-1');

      expect(http.get).toHaveBeenCalledTimes(2);
      expect(http.get).toHaveBeenNthCalledWith(1, '/issue/TAP-1/comment', {
        params: { startAt: 0, maxResults: 100 },
      });
      expect(http.get).toHaveBeenNthCalledWith(2, '/issue/TAP-1/comment', {
        params: { startAt: 2, maxResults: 100 },
      });
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('c1');
      expect(result[1].id).toBe('c2');
      expect(result[2].id).toBe('c3');
    });

    it('stops when empty comments returned', async () => {
      http.get.mockResolvedValueOnce({
        data: { comments: [], total: 0 },
      });

      const client = new JiraClient();
      const result = await client.getComments('TAP-1');

      expect(http.get).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });

    it('stops when startAt reaches total', async () => {
      http.get.mockResolvedValueOnce({
        data: {
          comments: [{ id: 'c1', author: { displayName: 'A' }, body: { type: 'doc', content: [] }, created: '' }],
          total: 1,
        },
      });

      const client = new JiraClient();
      const result = await client.getComments('TAP-1');

      expect(http.get).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });
  });

  describe('search', () => {
    it('POSTs to /search/jql with default fields', async () => {
      http.post.mockResolvedValueOnce({
        data: { issues: [{ id: '1', key: 'TAP-1', fields: {} }], nextPageToken: undefined, isLast: true },
      });

      const client = new JiraClient();
      const result = await client.search('project = TAP');

      expect(http.post).toHaveBeenCalledWith('/search/jql', {
        jql: 'project = TAP',
        fields: ['summary', 'status', 'assignee'],
        maxResults: 50,
      });
      expect(result.issues).toHaveLength(1);
      expect(result.isLast).toBe(true);
    });

    it('passes custom fields, maxResults, and nextPageToken', async () => {
      http.post.mockResolvedValueOnce({
        data: { issues: [], nextPageToken: 'token2', isLast: false },
      });

      const client = new JiraClient();
      await client.search('project = TEST', {
        fields: ['summary', 'description'],
        maxResults: 10,
        nextPageToken: 'token1',
      });

      expect(http.post).toHaveBeenCalledWith('/search/jql', {
        jql: 'project = TEST',
        fields: ['summary', 'description'],
        maxResults: 10,
        nextPageToken: 'token1',
      });
    });
  });

  describe('searchAll', () => {
    it('follows nextPageToken until isLast', async () => {
      // Page 1: returns nextPageToken, isLast: false
      http.post.mockResolvedValueOnce({
        data: {
          issues: [{ id: '1', key: 'TAP-1', fields: {} }],
          nextPageToken: 'page2',
          isLast: false,
        },
      });
      // Page 2: returns no token, isLast: true
      http.post.mockResolvedValueOnce({
        data: {
          issues: [{ id: '2', key: 'TAP-2', fields: {} }],
          nextPageToken: undefined,
          isLast: true,
        },
      });

      const client = new JiraClient();
      const result = await client.searchAll('project = TAP');

      expect(http.post).toHaveBeenCalledTimes(2);
      expect(http.post).toHaveBeenNthCalledWith(1, '/search/jql', expect.objectContaining({ jql: 'project = TAP' }));
      expect(http.post).toHaveBeenNthCalledWith(2, '/search/jql', expect.objectContaining({ nextPageToken: 'page2' }));
      expect(result).toHaveLength(2);
    });

    it('respects max cap', async () => {
      http.post.mockResolvedValueOnce({
        data: {
          issues: [
            { id: '1', key: 'TAP-1', fields: {} },
            { id: '2', key: 'TAP-2', fields: {} },
            { id: '3', key: 'TAP-3', fields: {} },
          ],
          nextPageToken: 'page2',
          isLast: false,
        },
      });

      const client = new JiraClient();
      const result = await client.searchAll('project = TAP', { max: 2 });

      expect(result).toHaveLength(2);
      expect(result[0].key).toBe('TAP-1');
      expect(result[1].key).toBe('TAP-2');
      // Only one request since max was reached immediately
      expect(http.post).toHaveBeenCalledTimes(1);
    });

    it('stops when empty issues returned', async () => {
      http.post.mockResolvedValueOnce({
        data: { issues: [], nextPageToken: 'page2', isLast: false },
      });

      const client = new JiraClient();
      const result = await client.searchAll('project = EMPTY');

      expect(http.post).toHaveBeenCalledTimes(1);
      expect(result).toEqual([]);
    });
  });

  describe('searchSlim', () => {
    it('returns slim issues from search', async () => {
      http.post.mockResolvedValueOnce({
        data: {
          issues: [{ id: '1', key: 'TAP-1', fields: { summary: 'Slim', status: { name: 'Open' } } }],
          nextPageToken: undefined,
          isLast: true,
        },
      });

      const client = new JiraClient();
      const result = await client.searchSlim('project = TAP');

      expect(http.post).toHaveBeenCalledWith('/search/jql', expect.objectContaining({
        fields: expect.arrayContaining(['summary']),
      }));
      expect(result).toHaveLength(1);
      expect(result[0].summary).toBe('Slim');
    });
  });

  describe('searchAllSlim', () => {
    it('returns slim issues from all pages', async () => {
      http.post.mockResolvedValueOnce({
        data: {
          issues: [{ id: '1', key: 'TAP-1', fields: { summary: 'A' } }],
          nextPageToken: undefined,
          isLast: true,
        },
      });

      const client = new JiraClient();
      const result = await client.searchAllSlim('project = TAP');

      expect(result).toHaveLength(1);
      expect(result[0].summary).toBe('A');
    });
  });

  describe('createIssue', () => {
    it('POSTs to /issue with ADF-wrapped description', async () => {
      http.post.mockResolvedValueOnce({ data: { id: '100', key: 'TAP-42' } });

      const client = new JiraClient();
      const result = await client.createIssue({
        projectKey: 'TAP',
        issueType: 'Task',
        summary: 'My task',
        description: 'Do the thing',
      });

      expect(http.post).toHaveBeenCalledWith('/issue', {
        fields: {
          project: { key: 'TAP' },
          issuetype: { name: 'Task' },
          summary: 'My task',
          description: {
            type: 'doc',
            version: 1,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Do the thing' }] }],
          },
        },
      });
      expect(result.key).toBe('TAP-42');
    });

    it('creates issue without description', async () => {
      http.post.mockResolvedValueOnce({ data: { key: 'TAP-43' } });

      const client = new JiraClient();
      await client.createIssue({
        projectKey: 'TAP',
        issueType: 'Bug',
        summary: 'No desc',
      });

      expect(http.post).toHaveBeenCalledWith('/issue', {
        fields: {
          project: { key: 'TAP' },
          issuetype: { name: 'Bug' },
          summary: 'No desc',
        },
      });
      // No description field
      expect(http.post.mock.calls[0][1].fields.description).toBeUndefined();
    });

    it('merges extra fields', async () => {
      http.post.mockResolvedValueOnce({ data: { key: 'TAP-44' } });

      const client = new JiraClient();
      await client.createIssue({
        projectKey: 'TAP',
        issueType: 'Story',
        summary: 'Story',
        fields: { customfield_123: 'value' },
      });

      expect(http.post.mock.calls[0][1].fields.customfield_123).toBe('value');
    });
  });

  describe('updateIssue', () => {
    it('PUTs to /issue/{key} with fields', async () => {
      http.put.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.updateIssue('TAP-1', { summary: 'Updated' });

      expect(http.put).toHaveBeenCalledWith('/issue/TAP-1', { fields: { summary: 'Updated' } });
    });
  });

  describe('addComment', () => {
    it('POSTs to /issue/{key}/comment with ADF body', async () => {
      http.post.mockResolvedValueOnce({ data: { id: '12345' } });

      const client = new JiraClient();
      const result = await client.addComment('TAP-1', 'Nice work');

      expect(http.post).toHaveBeenCalledWith('/issue/TAP-1/comment', {
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nice work' }] }],
        },
      });
      expect(result.id).toBe('12345');
    });

    it('sends parentId alongside the ADF body when replying in a thread', async () => {
      http.post.mockResolvedValueOnce({ data: { id: '48838' } });

      await new JiraClient().addComment('TAP-1', 'Nice work', '48106');

      expect(http.post).toHaveBeenCalledWith('/issue/TAP-1/comment', {
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Nice work' }] }],
        },
        parentId: '48106',
      });
    });

    it('omits the parentId key from the request body when not replying', async () => {
      http.post.mockResolvedValueOnce({ data: { id: '12345' } });

      await new JiraClient().addComment('TAP-1', 'Nice work');

      expect(Object.keys(http.post.mock.calls[0][1])).toEqual(['body']);
    });
  });

  describe('updateComment', () => {
    it('PUTs to /issue/{key}/comment/{id} with ADF body', async () => {
      http.put.mockResolvedValueOnce({ data: { id: '38560' } });

      const client = new JiraClient();
      const result = await client.updateComment('TAP-1', '38560', 'Revised');

      expect(http.put).toHaveBeenCalledWith('/issue/TAP-1/comment/38560', {
        body: {
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Revised' }] }],
        },
      });
      expect(result.id).toBe('38560');
    });
  });

  describe('deleteComment', () => {
    it('DELETEs /issue/{key}/comment/{id}', async () => {
      http.delete.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.deleteComment('TAP-1', '12345');

      expect(http.delete).toHaveBeenCalledWith('/issue/TAP-1/comment/12345');
    });
  });

  describe('listTransitions', () => {
    it('GETs /issue/{key}/transitions and returns transitions', async () => {
      http.get.mockResolvedValueOnce({
        data: { transitions: [{ id: '41', name: 'In Progress' }] },
      });

      const client = new JiraClient();
      const result = await client.listTransitions('TAP-1');

      expect(http.get).toHaveBeenCalledWith('/issue/TAP-1/transitions');
      expect(result).toEqual([{ id: '41', name: 'In Progress' }]);
    });
  });

  describe('transitionIssue', () => {
    it('POSTs to /issue/{key}/transitions with transition id', async () => {
      http.post.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.transitionIssue('TAP-1', '41');

      expect(http.post).toHaveBeenCalledWith('/issue/TAP-1/transitions', {
        transition: { id: '41' },
      });
    });

    it('includes comment when provided', async () => {
      http.post.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.transitionIssue('TAP-1', '41', { comment: 'Moving' });

      expect(http.post).toHaveBeenCalledWith('/issue/TAP-1/transitions', {
        transition: { id: '41' },
        update: { comment: [{ add: { body: expect.objectContaining({ type: 'doc' }) } }] },
      });
    });

    it('includes fields when provided', async () => {
      http.post.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.transitionIssue('TAP-1', '41', { fields: { resolution: { name: 'Done' } } });

      expect(http.post).toHaveBeenCalledWith('/issue/TAP-1/transitions', {
        transition: { id: '41' },
        fields: { resolution: { name: 'Done' } },
      });
    });
  });

  describe('assignIssue', () => {
    it('PUTs to /issue/{key}/assignee with accountId', async () => {
      http.put.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.assignIssue('TAP-1', 'abc-123');

      expect(http.put).toHaveBeenCalledWith('/issue/TAP-1/assignee', { accountId: 'abc-123' });
    });

    it('passes null to unassign', async () => {
      http.put.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.assignIssue('TAP-1', null);

      expect(http.put).toHaveBeenCalledWith('/issue/TAP-1/assignee', { accountId: null });
    });
  });

  describe('assignToMe', () => {
    it('calls whoami then assignIssue with the result', async () => {
      http.get.mockResolvedValueOnce({ data: { accountId: 'me123', displayName: 'Current User' } });
      http.put.mockResolvedValueOnce({});

      const client = new JiraClient();
      const result = await client.assignToMe('TAP-1');

      expect(http.get).toHaveBeenCalledWith('/myself');
      expect(http.put).toHaveBeenCalledWith('/issue/TAP-1/assignee', { accountId: 'me123' });
      expect(result.accountId).toBe('me123');
    });
  });

  describe('searchUsers', () => {
    it('GETs /user/search with query param', async () => {
      const users = [{ accountId: 'abc', displayName: 'John', emailAddress: 'john@example.com' }];
      http.get.mockResolvedValueOnce({ data: users });

      const client = new JiraClient();
      const result = await client.searchUsers('John');

      expect(http.get).toHaveBeenCalledWith('/user/search', { params: { query: 'John' } });
      expect(result).toEqual(users);
    });
  });

  describe('listProjectComponents', () => {
    it('GETs /project/{key}/components and maps each component to id + name', async () => {
      http.get.mockResolvedValueOnce({
        data: [
          {
            self: 'https://test.atlassian.net/rest/api/3/component/10040',
            id: '10040',
            name: 'EZAT Automation',
            project: 'TAP',
            assigneeType: 'PROJECT_DEFAULT',
          },
          { self: 'https://test.atlassian.net/rest/api/3/component/10041', id: '10041', name: 'Billing' },
        ],
      });

      const client = new JiraClient();
      const result = await client.listProjectComponents('TAP');

      expect(http.get).toHaveBeenCalledWith('/project/TAP/components');
      expect(result).toEqual([
        { id: '10040', name: 'EZAT Automation' },
        { id: '10041', name: 'Billing' },
      ]);
    });

    it('encodes the project key', async () => {
      http.get.mockResolvedValueOnce({ data: [] });

      await new JiraClient().listProjectComponents('A/B');

      expect(http.get).toHaveBeenCalledWith('/project/A%2FB/components');
    });

    it('returns an empty list for a project with no components', async () => {
      http.get.mockResolvedValueOnce({ data: [] });

      expect(await new JiraClient().listProjectComponents('TAP')).toEqual([]);
    });
  });

  describe('listIssueLinkTypes', () => {
    it('GETs /issueLinkType and returns types', async () => {
      const types = [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }];
      http.get.mockResolvedValueOnce({ data: { issueLinkTypes: types } });

      const client = new JiraClient();
      const result = await client.listIssueLinkTypes();

      expect(http.get).toHaveBeenCalledWith('/issueLinkType');
      expect(result).toEqual(types);
    });
  });

  describe('linkIssues', () => {
    it('POSTs to /issueLink with type and issue keys', async () => {
      http.post.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.linkIssues({
        type: 'Blocks',
        inwardKey: 'TAP-1',
        outwardKey: 'TAP-2',
      });

      expect(http.post).toHaveBeenCalledWith('/issueLink', {
        type: { name: 'Blocks' },
        inwardIssue: { key: 'TAP-1' },
        outwardIssue: { key: 'TAP-2' },
      });
    });

    it('includes comment when provided', async () => {
      http.post.mockResolvedValueOnce({});

      const client = new JiraClient();
      await client.linkIssues({
        type: 'Relates',
        inwardKey: 'TAP-1',
        outwardKey: 'TAP-2',
        comment: 'Related',
      });

      expect(http.post).toHaveBeenCalledWith('/issueLink', {
        type: { name: 'Relates' },
        inwardIssue: { key: 'TAP-1' },
        outwardIssue: { key: 'TAP-2' },
        comment: { body: expect.objectContaining({ type: 'doc' }) },
      });
    });
  });

  describe('getAttachmentContent', () => {
    it('fetches metadata then downloads content', async () => {
      http.get
        // Metadata call
        .mockResolvedValueOnce({
          data: { id: '39824', filename: 'screenshot.png', mimeType: 'image/png', size: 107133 },
        })
        // Content download
        .mockResolvedValueOnce({
          data: Buffer.from('fake-image-binary'),
        });

      const client = new JiraClient();
      const result = await client.getAttachmentContent('39824');

      expect(http.get).toHaveBeenNthCalledWith(1, '/attachment/39824');
      expect(http.get).toHaveBeenNthCalledWith(2, '/attachment/content/39824', {
        responseType: 'arraybuffer',
      });
      expect(result.id).toBe('39824');
      expect(result.filename).toBe('screenshot.png');
      expect(result.mimeType).toBe('image/png');
      expect(result.size).toBe(107133);
      expect(typeof result.contentBase64).toBe('string');
      expect(result.contentBase64).toBe(Buffer.from('fake-image-binary').toString('base64'));
    });

    it('uses raw length as fallback when size is undefined', async () => {
      http.get
        .mockResolvedValueOnce({
          data: { id: '1', filename: 'test.txt', mimeType: 'text/plain' },
        })
        .mockResolvedValueOnce({
          data: Buffer.from('hello'),
        });

      const client = new JiraClient();
      const result = await client.getAttachmentContent('1');

      expect(result.size).toBe(5); // raw.length of 'hello'
    });
  });

  describe('retry interceptor', () => {
    it('is installed on the axios instance', () => {
      new JiraClient();
      expect(http.interceptors.response.use).toHaveBeenCalledWith(undefined, expect.any(Function));
    });
  });

  describe('toAdf (via addComment)', () => {
    it('wraps text in Atlassian Document Format', async () => {
      http.post.mockResolvedValueOnce({ data: { id: '12345' } });

      const client = new JiraClient();
      await client.addComment('TAP-1', 'Hello world');

      const body = http.post.mock.calls[0][1].body;
      expect(body).toEqual({
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
      });
    });
  });

  describe('comment mentions', () => {
    const accountId = '712020:e130b750-b09b-4d24-95b9-d72d503e4911';
    const otherAccountId = '5b10ac8d82e05b22cc7d4ef5';

    async function addedParagraph(body: string) {
      http.post.mockResolvedValueOnce({ data: { id: '1' } });
      await new JiraClient().addComment('TAP-1', body);
      return http.post.mock.calls[0][1].body.content[0].content;
    }

    it('converts a mention token into a mention node', async () => {
      expect(await addedParagraph(`[~accountid:${accountId}]`)).toEqual([
        { type: 'mention', attrs: { id: accountId } },
      ]);
    });

    it('keeps the text around a mention token', async () => {
      expect(await addedParagraph(`Hi [~accountid:${accountId}], please review.`)).toEqual([
        { type: 'text', text: 'Hi ' },
        { type: 'mention', attrs: { id: accountId } },
        { type: 'text', text: ', please review.' },
      ]);
    });

    it('converts every mention token in one body', async () => {
      expect(await addedParagraph(`[~accountid:${accountId}] and [~accountid:${otherAccountId}]`)).toEqual([
        { type: 'mention', attrs: { id: accountId } },
        { type: 'text', text: ' and ' },
        { type: 'mention', attrs: { id: otherAccountId } },
      ]);
    });

    it('leaves a body without tokens as a single text node', async () => {
      const body = 'Line one\nLine two [link](https://example.com) [~notamention] [~accountid:]';
      expect(await addedParagraph(body)).toEqual([{ type: 'text', text: body }]);
    });

    it('leaves an unclosed token as plain text', async () => {
      const body = `see [~accountid:${accountId} for details`;
      expect(await addedParagraph(body)).toEqual([{ type: 'text', text: body }]);
    });

    it('converts mention tokens identically when replying in a thread', async () => {
      http.post.mockResolvedValue({ data: { id: '1' } });
      const text = `Hi [~accountid:${accountId}], done.`;

      await new JiraClient().addComment('TAP-1', text);
      await new JiraClient().addComment('TAP-1', text, '48106');

      const [topLevel, reply] = http.post.mock.calls.map((call) => call[1]);
      expect(reply.body).toEqual(topLevel.body);
      expect(reply.body.content[0].content).toContainEqual({ type: 'mention', attrs: { id: accountId } });
      expect(reply.parentId).toBe('48106');
    });

    it('converts mention tokens when updating a comment', async () => {
      http.put.mockResolvedValueOnce({ data: { id: '38560' } });

      await new JiraClient().updateComment('TAP-1', '38560', `Ping [~accountid:${accountId}]`);

      expect(http.put).toHaveBeenCalledWith('/issue/TAP-1/comment/38560', {
        body: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Ping ' },
                { type: 'mention', attrs: { id: accountId } },
              ],
            },
          ],
        },
      });
    });
  });
});
