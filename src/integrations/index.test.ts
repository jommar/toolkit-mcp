import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../services/index.js', () => ({
  JiraClient: class MockJiraClient {},
  GitHubClient: class MockGitHubClient {},
  FigmaClient: class MockFigmaClient {},
  ConfluenceClient: class MockConfluenceClient {},
}));

import { modules, IntegrationModule } from './index.js';

describe('Module Registry', () => {
  it('exports exactly 4 modules', () => {
    expect(modules).toHaveLength(4);
  });

  it('all modules have correct ids', () => {
    const ids = modules.map((m) => m.id).sort();
    expect(ids).toEqual(['confluence', 'figma', 'github', 'jira']);
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
      if (mod.id === 'figma') clients.figma = {};
      if (mod.id === 'confluence') clients.confluence = {};

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

  it('FigmaModule has no getResourceHandler or getPromptHandler', () => {
    const figmaMod = modules.find((m) => m.id === 'figma')!;
    expect(figmaMod.getResourceHandler).toBeUndefined();
    expect(figmaMod.getPromptHandler).toBeUndefined();
  });

  it('ConfluenceModule has no getResourceHandler or getPromptHandler', () => {
    const confluenceMod = modules.find((m) => m.id === 'confluence')!;
    expect(confluenceMod.getResourceHandler).toBeUndefined();
    expect(confluenceMod.getPromptHandler).toBeUndefined();
  });
});
