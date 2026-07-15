import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../services/index.js', () => ({
  JenkinsClient: class MockJenkinsClient {},
}));

import { JenkinsModule } from './index.js';

function makeMockJenkins() {
  return {
    getJobs: vi.fn(),
    getBuilds: vi.fn(),
    getBuild: vi.fn(),
    getConsole: vi.fn(),
  };
}

type MockJenkins = ReturnType<typeof makeMockJenkins>;

describe('JenkinsModule', () => {
  let mod: JenkinsModule;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mod = new JenkinsModule();
  });

  describe('id', () => {
    it('returns "jenkins"', () => {
      expect(mod.id).toBe('jenkins');
    });
  });

  describe('needsEnv', () => {
    beforeEach(() => {
      delete process.env.JENKINS_URL;
      delete process.env.JENKINS_USER;
      delete process.env.JENKINS_TOKEN;
    });

    it('returns true when all three env vars are set', () => {
      vi.stubEnv('JENKINS_URL', 'http://jenkins');
      vi.stubEnv('JENKINS_USER', 'jommar');
      vi.stubEnv('JENKINS_TOKEN', 'tok');
      expect(mod.needsEnv()).toBe(true);
    });

    it('returns false when any is missing', () => {
      vi.stubEnv('JENKINS_URL', 'http://jenkins');
      vi.stubEnv('JENKINS_USER', 'jommar');
      expect(mod.needsEnv()).toBe(false);
    });
  });

  describe('createToolHandlers', () => {
    let mockJenkins: MockJenkins;

    beforeEach(() => {
      mockJenkins = makeMockJenkins();
    });

    it('returns 5 handlers', () => {
      const handlers = mod.createToolHandlers({ jenkins: mockJenkins as any });
      expect(Object.keys(handlers)).toHaveLength(5);
      expect(handlers).toHaveProperty('jenkins_get_jobs');
      expect(handlers).toHaveProperty('jenkins_get_builds');
      expect(handlers).toHaveProperty('jenkins_get_build');
      expect(handlers).toHaveProperty('jenkins_get_console');
      expect(handlers).toHaveProperty('jenkins_healthcheck');
    });

    it('jenkins_get_jobs delegates and returns a paginated envelope', async () => {
      mockJenkins.getJobs.mockResolvedValue({
        items: [{ name: 'a', status: 'success' }],
        total: 1,
        hasMore: false,
      });
      const handlers = mod.createToolHandlers({ jenkins: mockJenkins as any });
      const result = await handlers.jenkins_get_jobs({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.hasMore).toBe(false);
      expect(parsed.total).toBe(1);
    });

    it('rejects an invalid job name through Zod validation', async () => {
      const handlers = mod.createToolHandlers({ jenkins: mockJenkins as any });
      await expect(handlers.jenkins_get_builds({ job: 'bad;job' })).rejects.toThrow();
    });
  });

  describe('getToolDescriptors', () => {
    it('returns 5 descriptors with name, description, and inputSchema', () => {
      const descriptors = mod.getToolDescriptors();
      expect(descriptors).toHaveLength(5);
      const names = descriptors.map((d) => d.name);
      expect(names).toEqual([
        'jenkins_get_jobs',
        'jenkins_get_builds',
        'jenkins_get_build',
        'jenkins_get_console',
        'jenkins_healthcheck',
      ]);
      for (const d of descriptors) {
        expect(d.description).toBeTruthy();
        expect(d.inputSchema).toBeDefined();
      }
    });
  });
});
