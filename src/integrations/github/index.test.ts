import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../services/index.js', () => ({
  GitHubClient: class MockGitHubClient {},
  ISSUE_KEY_PATTERN: /^[A-Z][A-Z0-9]{0,10}-\d{1,6}$/i,
}));

import { ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import { contentText, inputJsonSchema, rawToolHandlers } from '../../__fixtures__/mcp.js';
import { GitHubModule } from './index.js';

function makeMockGitHub() {
  return {
    getCopilotUnresolvedPrs: vi.fn(),
    searchPrs: vi.fn(),
    findPrsForIssueKeys: vi.fn(),
    updatePullRequest: vi.fn(),
  };
}

type MockGitHub = ReturnType<typeof makeMockGitHub>;

describe('GitHubModule', () => {
  let mod: GitHubModule;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mod = new GitHubModule();
  });

  describe('id', () => {
    it('returns "github"', () => {
      expect(mod.id).toBe('github');
    });
  });

  describe('needsEnv', () => {
    beforeEach(() => {
      // GH_TOKEN may be set from .env — clear it for predictable tests
      delete process.env.GH_TOKEN;
    });

    it('returns true when GH_TOKEN is set', () => {
      vi.stubEnv('GH_TOKEN', 'ghp_abc123');
      expect(mod.needsEnv()).toBe(true);
    });

    it('returns false when GH_TOKEN is missing', () => {
      expect(mod.needsEnv()).toBe(false);
    });

    it('returns false when GH_TOKEN is empty string', () => {
      vi.stubEnv('GH_TOKEN', '');
      expect(mod.needsEnv()).toBe(false);
    });
  });

  describe('createToolHandlers', () => {
    let mockGitHub: MockGitHub;

    beforeEach(() => {
      mockGitHub = makeMockGitHub();
    });

    it('returns 30 handlers', () => {
      const handlers = rawToolHandlers(mod, { github: mockGitHub as any });
      expect(Object.keys(handlers)).toHaveLength(30);
      expect(handlers).toHaveProperty('github_get_copilot_unresolved_prs');
      expect(handlers).toHaveProperty('github_get_prs');
      expect(handlers).toHaveProperty('github_create_pr');
      expect(handlers).toHaveProperty('github_add_pr_comment');
      expect(handlers).toHaveProperty('github_get_pr_comments');
      expect(handlers).toHaveProperty('github_update_pr_comment');
      expect(handlers).toHaveProperty('github_list_branches');
      expect(handlers).toHaveProperty('github_get_pr_details');
      expect(handlers).toHaveProperty('github_get_pr_reviews');
      expect(handlers).toHaveProperty('github_get_pr_checks');
      expect(handlers).toHaveProperty('github_search_prs');
      expect(handlers).toHaveProperty('github_update_pr');
      expect(handlers).toHaveProperty('github_create_pr_review_comment');
      expect(handlers).toHaveProperty('github_get_pr_review_comments');
      expect(handlers).toHaveProperty('github_update_pr_review_comment');
      expect(handlers).toHaveProperty('github_delete_pr_review_comment');
      expect(handlers).toHaveProperty('github_submit_pr_review');
      expect(handlers).toHaveProperty('github_get_pr_files');
      expect(handlers).toHaveProperty('github_get_pr_commits');
      expect(handlers).toHaveProperty('github_get_file_contents');
      expect(handlers).toHaveProperty('github_get_pr_review_threads');
      expect(handlers).toHaveProperty('github_resolve_review_thread');
      expect(handlers).toHaveProperty('github_unresolve_review_thread');
      expect(handlers).toHaveProperty('github_delete_pr_issue_comment');
      expect(handlers).toHaveProperty('github_merge_pr');
      expect(handlers).toHaveProperty('github_request_pr_reviewers');
      expect(handlers).toHaveProperty('github_update_pr_labels');
      expect(handlers).toHaveProperty('github_update_pr_assignees');
      expect(handlers).toHaveProperty('github_dismiss_pr_review');
    });

    it('github_get_copilot_unresolved_prs validates and delegates default discovery', async () => {
      mockGitHub.getCopilotUnresolvedPrs.mockResolvedValue({
        items: [{ repo: 'Org/Repo', prNumber: 42, comments: ['Handle the empty response.'] }], hasMore: false,
      });
      const handlers = rawToolHandlers(mod, { github: mockGitHub as any });

      expect(handlers.github_get_copilot_unresolved_prs).toBeTypeOf('function');
      const result = await handlers.github_get_copilot_unresolved_prs({ repo: 'Org/Repo' });

      expect(mockGitHub.getCopilotUnresolvedPrs).toHaveBeenCalledExactlyOnceWith({
        repo: 'Org/Repo', state: 'open', limit: 20,
      });
      expect(result).toEqual({ content: [{
        type: 'text', text: '{"items":[{"repo":"Org/Repo","prNumber":42,"comments":["Handle the empty response."]}],"hasMore":false}',
      }] });
      await expect(handlers.github_get_copilot_unresolved_prs({ repo: 'Org/Repo', prNumbers: [1.5] })).rejects.toThrow();
      expect(mockGitHub.getCopilotUnresolvedPrs).toHaveBeenCalledTimes(1);
    });

    it('github_get_prs delegates to handler with parsed args', async () => {
      mockGitHub.searchPrs.mockResolvedValue([{ number: 1, title: 'PR', repo: 'Org/Repo', state: 'open' }]);

      const handlers = rawToolHandlers(mod, { github: mockGitHub as any });
      const result = await handlers.github_get_prs({ issueKey: 'TAP-1' });

      expect(mockGitHub.searchPrs).toHaveBeenCalledWith('TAP-1', 21, 'open');
      const parsed = JSON.parse(contentText(result));
      expect(parsed.items).toHaveLength(1);
    });

    it('rejects invalid args through Zod validation', async () => {
      const handlers = rawToolHandlers(mod, { github: mockGitHub as any });
      // state must be 'open', 'closed', or 'all'
      await expect(
        handlers.github_get_prs({ issueKey: 'TAP-1', state: 'invalid' }),
      ).rejects.toThrow();
    });

    const review = { repo: 'Org/Repo', prNumber: 1, body: 'x' };
    it.each([
      ['github_get_file_contents', { repo: 'Org/Repo', path: 'f.ts', startLine: 5, endLine: 2 },
        'startLine must be less than or equal to endLine'],
      ['github_update_pr', { repo: 'Org/Repo', prNumber: 1 },
        'At least one of title, body, state, base, maintainerCanModify, or draft must be provided'],
      ['github_search_prs', {},
        'At least one of query, author, repo, label, reviewRequested, or base must be provided'],
      ['github_create_pr_review_comment', review,
        'path, commitId, and line are required unless inReplyTo is provided'],
      ['github_create_pr_review_comment', { ...review, path: 'f.ts', commitId: 'abc', line: 2, startLine: 3 },
        'startLine must be less than line for multi-line comments'],
      ['github_create_pr_review_comment', { ...review, path: 'f.ts', commitId: 'abc', line: 2, startSide: 'LEFT' },
        'startSide requires startLine to be provided'],
    ])('%s keeps its refine rule on the descriptor schema: %j', async (name, args, message) => {
      const handlers = rawToolHandlers(mod, { github: mockGitHub as any });
      await expect(handlers[name](args)).rejects.toThrow(message);
      for (const fn of Object.values(mockGitHub)) expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('getToolDescriptors', () => {
    it('returns 30 tool descriptors', () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors).toHaveLength(30);
      expect(descriptors.find((d) => d.name === 'github_get_copilot_unresolved_prs')).toMatchObject({
        description: 'List PRs with full originating comment bodies from every unresolved Copilot-started review thread.',
      });
      const schema = inputJsonSchema(descriptors.find((d) => d.name === 'github_get_copilot_unresolved_prs')!) as any;
      expect(schema).toMatchObject({
        type: 'object', required: ['repo'],
        properties: {
          prNumbers: { type: 'array', items: { type: 'integer', exclusiveMinimum: 0, maximum: 2147483647 } },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          state: { enum: ['open', 'closed', 'all'], default: 'open' },
          cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' },
        },
      });
      expect(schema.properties.prNumbers).not.toHaveProperty('default');
      expect(schema.properties.cursor).not.toHaveProperty('maxLength');
    });

    it('every descriptor has a title and four boolean hints', () => {
      // Hint values are owned by the 80-tool table in src/integrations/index.test.ts.
      for (const d of mod.getToolDescriptors()) {
        expect(d.title, d.name).toEqual(expect.stringMatching(/\S/));
        for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
          expect(typeof d.annotations?.[hint], `${d.name}.${hint}`).toBe('boolean');
        }
      }
    });

    it('descriptors have name, description, and inputSchema', () => {
      const descriptors = mod.getToolDescriptors();
      const names = descriptors.map((d) => d.name);
      expect(names).toContain('github_get_prs');
      expect(names).toContain('github_create_pr');
      expect(names).toContain('github_list_branches');
      expect(names).toContain('github_update_pr');
      for (const d of descriptors) {
        expect(d.description).toBeTruthy();
        expect(d.inputSchema).toBeDefined();
      }
    });
  });

  describe('getResourceDescriptors', () => {
    it('declares the github://prs/{issueKey} template and no static resources', () => {
      const descriptors = mod.getResourceDescriptors();
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        uriTemplate: 'github://prs/{issueKey}',
        name: expect.stringMatching(/\S/),
        title: expect.stringMatching(/\S/),
        description: expect.stringMatching(/\S/),
        mimeType: 'application/json',
      });
      expect(descriptors[0].uri).toBeUndefined();
    });
  });

  describe('getResourceHandler', () => {
    let mockGitHub: MockGitHub;

    beforeEach(() => {
      mockGitHub = makeMockGitHub();
    });

    it('resolves github://prs/<issueKey>', async () => {
      const prs = [{ number: 1, title: 'Fix', repo: 'Org/Repo', state: 'open' }];
      mockGitHub.searchPrs.mockResolvedValue(prs);

      const rh = mod.getResourceHandler({ github: mockGitHub as any });
      const result = await rh('github://prs/TAP-1');

      expect(mockGitHub.searchPrs).toHaveBeenCalledWith('TAP-1');
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('github://prs/TAP-1');
      expect(result.contents[0].mimeType).toBe('application/json');
    });

    it('throws InvalidParams when issue key is empty', async () => {
      const rh = mod.getResourceHandler({ github: mockGitHub as any });
      const err = await rh('github://prs/').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProtocolError);
      expect(err).not.toBeInstanceOf(ResourceNotFoundError);
      expect(err).toMatchObject({ code: ProtocolErrorCode.InvalidParams, message: expect.stringContaining('Missing issue key') });
    });

    it('throws InvalidParams for a malformed issue key without calling GitHub', async () => {
      const rh = mod.getResourceHandler({ github: mockGitHub as any });
      const err = await rh('github://prs/notakey').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProtocolError);
      expect(err).not.toBeInstanceOf(ResourceNotFoundError);
      expect(err).toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringContaining('Invalid issue key format: "notakey"'),
      });
      expect(mockGitHub.searchPrs).not.toHaveBeenCalled();
    });

    it('throws ResourceNotFoundError for unknown URI', async () => {
      const rh = mod.getResourceHandler({ github: mockGitHub as any });
      const err = await rh('github://unknown').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ResourceNotFoundError);
      expect(err).toMatchObject({ code: ProtocolErrorCode.InvalidParams, data: { uri: 'github://unknown' } });
    });
  });
});
