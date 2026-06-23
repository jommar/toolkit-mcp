import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../services/index.js', () => ({
  JiraClient: class MockJiraClient {},
  GitHubClient: class MockGitHubClient {},
}));

import { modules, IntegrationModule } from './index.js';

describe('Module Registry', () => {
  it('exports exactly 2 modules', () => {
    expect(modules).toHaveLength(2);
  });

  it('both modules have correct ids', () => {
    const ids = modules.map((m) => m.id).sort();
    expect(ids).toEqual(['github', 'jira']);
  });

  it('each module implements IntegrationModule interface', () => {
    for (const mod of modules) {
      expect(mod).toHaveProperty('id');
      expect(typeof mod.id).toBe('string');
      expect(typeof mod.needsEnv).toBe('function');
      expect(typeof mod.createToolHandlers).toBe('function');
      expect(typeof mod.getToolDescriptors).toBe('function');
    }
  });

  it('each module returns valid needsEnv result', () => {
    for (const mod of modules) {
      // needsEnv returns a boolean regardless of env state
      const result = mod.needsEnv();
      expect(typeof result).toBe('boolean');
    }
  });

  it('each module returns handlers and descriptors from createToolHandlers/getToolDescriptors', () => {
    for (const mod of modules) {
      const clients: Record<string, unknown> = {};
      if (mod.id === 'jira') clients.jira = {};
      if (mod.id === 'github') clients.github = {};

      const handlers = mod.createToolHandlers(clients);
      expect(typeof handlers).toBe('object');
      expect(Object.keys(handlers).length).toBeGreaterThan(0);

      const descriptors = mod.getToolDescriptors();
      expect(Array.isArray(descriptors)).toBe(true);
      expect(descriptors.length).toBeGreaterThan(0);

      for (const d of descriptors) {
        expect(d).toHaveProperty('name');
        expect(d).toHaveProperty('description');
        expect(d).toHaveProperty('inputSchema');
      }
    }
  });

  it('JiraModule has getResourceHandler and getPromptHandler', () => {
    const jiraMod = modules.find((m) => m.id === 'jira')!;
    expect(typeof jiraMod.getResourceHandler).toBe('function');
    expect(typeof jiraMod.getPromptHandler).toBe('function');
  });

  it('GitHubModule has getResourceHandler but not getPromptHandler', () => {
    const githubMod = modules.find((m) => m.id === 'github')!;
    expect(typeof githubMod.getResourceHandler).toBe('function');
    expect(githubMod.getPromptHandler).toBeUndefined();
  });
});
