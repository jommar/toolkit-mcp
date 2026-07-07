import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../services/index.js', () => ({
  GitHubClient: class MockGitHubClient {},
}));

import { GitHubModule } from './index.js';

function makeMockGitHub() {
  return {
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

    it('returns 16 handlers', () => {
      const handlers = mod.createToolHandlers({ github: mockGitHub as any });
      expect(Object.keys(handlers)).toHaveLength(16);
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
    });

    it('github_get_prs delegates to handler with parsed args', async () => {
      mockGitHub.searchPrs.mockResolvedValue([{ number: 1, title: 'PR', repo: 'Org/Repo', state: 'open' }]);

      const handlers = mod.createToolHandlers({ github: mockGitHub as any });
      const result = await handlers.github_get_prs({ issueKey: 'TRIPS-1' });

      expect(mockGitHub.searchPrs).toHaveBeenCalledWith('TRIPS-1', undefined, 'open');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.items).toHaveLength(1);
    });

    it('rejects invalid args through Zod validation', async () => {
      const handlers = mod.createToolHandlers({ github: mockGitHub as any });
      // state must be 'open', 'closed', or 'all'
      await expect(
        handlers.github_get_prs({ issueKey: 'TRIPS-1', state: 'invalid' }),
      ).rejects.toThrow();
    });
  });

  describe('getToolDescriptors', () => {
    it('returns 16 tool descriptors', () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors).toHaveLength(16);
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

  describe('getResourceHandler', () => {
    let mockGitHub: MockGitHub;

    beforeEach(() => {
      mockGitHub = makeMockGitHub();
    });

    it('resolves github://prs/<issueKey>', async () => {
      const prs = [{ number: 1, title: 'Fix', repo: 'Org/Repo', state: 'open' }];
      mockGitHub.searchPrs.mockResolvedValue(prs);

      const rh = mod.getResourceHandler({ github: mockGitHub as any });
      const result = await rh('github://prs/TRIPS-1');

      expect(mockGitHub.searchPrs).toHaveBeenCalledWith('TRIPS-1');
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('github://prs/TRIPS-1');
      expect(result.contents[0].mimeType).toBe('application/json');
    });

    it('throws when issue key is empty', async () => {
      const rh = mod.getResourceHandler({ github: mockGitHub as any });
      await expect(rh('github://prs/')).rejects.toThrow('Missing issue key');
    });

    it('throws for unknown URI', async () => {
      const rh = mod.getResourceHandler({ github: mockGitHub as any });
      await expect(rh('github://unknown')).rejects.toThrow('Unknown resource');
    });
  });
});
