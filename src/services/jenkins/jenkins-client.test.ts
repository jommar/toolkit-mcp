import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { JenkinsClient, describeJenkinsError } from './jenkins-client.js';

// Mock only axios.create — keep real isAxiosError for describeJenkinsError tests
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

interface MockAxiosInstance {
  get: Mock;
  interceptors: { response: { use: Mock } };
}

function mockAxiosInstance(): MockAxiosInstance {
  const instance: MockAxiosInstance = {
    get: vi.fn(),
    interceptors: { response: { use: vi.fn() } },
  };
  createMock.mockReturnValue(instance);
  return instance;
}

describe('JenkinsClient', () => {
  let http: MockAxiosInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JENKINS_URL = 'http://jedi.onecampus.com:8080/';
    process.env.JENKINS_USER = 'jommar';
    process.env.JENKINS_TOKEN = 'token123';
    http = mockAxiosInstance();
  });

  describe('constructor', () => {
    it('throws when required env vars are missing', () => {
      delete process.env.JENKINS_TOKEN;
      expect(() => new JenkinsClient()).toThrow('JENKINS_URL, JENKINS_USER, and JENKINS_TOKEN');
    });

    it('creates an axios instance with basic auth and a trimmed base URL', () => {
      new JenkinsClient();
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://jedi.onecampus.com:8080',
          auth: { username: 'jommar', password: 'token123' },
        }),
      );
    });
  });

  describe('ping', () => {
    it('returns true when Jenkins responds, using a short timeout and no retries', async () => {
      http.get.mockResolvedValue({ data: { nodeName: '' } });
      const client = new JenkinsClient();
      await expect(client.ping()).resolves.toBe(true);

      const [url, opts] = http.get.mock.calls[0];
      expect(url).toBe('/api/json');
      expect(opts.timeout).toBe(3000);
      expect(opts.__noRetry).toBe(true);
    });

    it('returns true when the server is up but auth fails (401)', async () => {
      http.get.mockRejectedValue({ isAxiosError: true, response: { status: 401 }, message: 'unauthorized' });
      const client = new JenkinsClient();
      await expect(client.ping()).resolves.toBe(true);
    });

    it('returns false when the host is unreachable (no response)', async () => {
      http.get.mockRejectedValue({ isAxiosError: true, code: 'ECONNABORTED', message: 'timeout' });
      const client = new JenkinsClient();
      await expect(client.ping()).resolves.toBe(false);
    });

    it('returns false on a non-axios error', async () => {
      http.get.mockRejectedValue(new Error('boom'));
      const client = new JenkinsClient();
      await expect(client.ping()).resolves.toBe(false);
    });
  });

  describe('getJobs', () => {
    it('maps ball colors to friendly status and paginates', async () => {
      http.get.mockResolvedValue({
        data: {
          jobs: [
            { name: 'a', url: 'u/a', color: 'blue', lastBuild: { number: 5, result: 'SUCCESS' } },
            { name: 'b', url: 'u/b', color: 'red', lastBuild: { number: 2, result: 'FAILURE' } },
            { name: 'c', url: 'u/c', color: 'blue_anime', lastBuild: { number: 9, result: null } },
          ],
        },
      });
      const client = new JenkinsClient();
      const page = await client.getJobs({ offset: 0, limit: 2 });

      expect(page.total).toBe(3);
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({ name: 'a', status: 'success', lastBuildNumber: 5 });
      expect(page.items[1]).toMatchObject({ name: 'b', status: 'failed' });
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(2);
    });

    it('marks in-progress builds as building and reports no more pages at the end', async () => {
      http.get.mockResolvedValue({
        data: { jobs: [{ name: 'c', url: 'u/c', color: 'blue_anime', lastBuild: { number: 9 } }] },
      });
      const client = new JenkinsClient();
      const page = await client.getJobs({ offset: 0, limit: 20 });
      expect(page.items[0].status).toBe('building');
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeUndefined();
    });

    it('maps a missing color to "unknown" and passes unmapped colors through', async () => {
      http.get.mockResolvedValue({
        data: {
          jobs: [
            { name: 'x', url: 'u/x', lastBuild: null },
            { name: 'y', url: 'u/y', color: 'purple', lastBuild: null },
          ],
        },
      });
      const client = new JenkinsClient();
      const page = await client.getJobs({ offset: 0, limit: 20 });
      expect(page.items[0]).toMatchObject({ name: 'x', status: 'unknown', lastBuildNumber: null });
      expect(page.items[1].status).toBe('purple');
    });
  });

  describe('getBuilds', () => {
    it('uses a lookahead to detect further pages and trims to the limit', async () => {
      // limit 2 → requests 3 (lookahead); 3 returned means hasMore
      http.get.mockResolvedValue({
        data: {
          builds: [
            { number: 10, result: 'SUCCESS', building: false, timestamp: 1, duration: 100, url: 'u/10' },
            { number: 9, result: 'FAILURE', building: false, timestamp: 2, duration: 200, url: 'u/9' },
            { number: 8, result: 'SUCCESS', building: false, timestamp: 3, duration: 300, url: 'u/8' },
          ],
        },
      });
      const client = new JenkinsClient();
      const page = await client.getBuilds('EZAT-backend-dev', { offset: 0, limit: 2 });

      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({ number: 10, result: 'SUCCESS', durationMs: 100 });
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(2);

      const [, opts] = http.get.mock.calls[0];
      expect(opts.params.tree).toContain('{0,3}');
    });

    it('reports hasMore=false when fewer than limit+1 builds come back', async () => {
      http.get.mockResolvedValue({
        data: {
          builds: [
            { number: 10, result: 'SUCCESS', building: false, timestamp: 1, duration: 100, url: 'u/10' },
            { number: 9, result: 'SUCCESS', building: false, timestamp: 2, duration: 100, url: 'u/9' },
          ],
        },
      });
      const client = new JenkinsClient();
      const page = await client.getBuilds('EZAT-backend-dev', { offset: 0, limit: 2 });
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeUndefined();
    });
  });

  describe('getBuild', () => {
    it('defaults to lastBuild when no build number is given', async () => {
      http.get.mockResolvedValue({
        data: { number: 42, result: 'SUCCESS', building: false, timestamp: 1, duration: 5, url: 'u', description: null },
      });
      const client = new JenkinsClient();
      await client.getBuild('EZAT-backend-dev');
      expect(http.get.mock.calls[0][0]).toContain('/lastBuild/api/json');
    });

    it('requests a specific build number', async () => {
      http.get.mockResolvedValue({ data: { number: 7, result: 'FAILURE', building: false, timestamp: 1, duration: 5, url: 'u' } });
      const client = new JenkinsClient();
      const build = await client.getBuild('EZAT-backend-dev', 7);
      expect(http.get.mock.calls[0][0]).toContain('/job/EZAT-backend-dev/7/api/json');
      expect(build.result).toBe('FAILURE');
    });
  });

  describe('getConsole', () => {
    it('splits the log into lines, drops the trailing newline, and paginates', async () => {
      http.get.mockResolvedValue({ data: 'line1\nline2\nline3\n' });
      const client = new JenkinsClient();
      const page = await client.getConsole('EZAT-backend-dev', undefined, { offset: 0, limit: 2 });

      expect(page.totalLines).toBe(3);
      expect(page.lines).toEqual(['line1', 'line2']);
      expect(page.fromLine).toBe(0);
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(2);
    });

    it('reports no more pages once the offset reaches the end', async () => {
      http.get.mockResolvedValue({ data: 'only-line\n' });
      const client = new JenkinsClient();
      const page = await client.getConsole('EZAT-backend-dev', 3, { offset: 0, limit: 200 });
      expect(page.lines).toEqual(['only-line']);
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeUndefined();
    });
  });

  describe('job name validation', () => {
    it('rejects an invalid job name', async () => {
      const client = new JenkinsClient();
      await expect(client.getBuilds('bad;job')).rejects.toThrow('Invalid job name');
    });

    it('builds folder paths with /job/ segments', async () => {
      http.get.mockResolvedValue({ data: { builds: [] } });
      const client = new JenkinsClient();
      await client.getBuilds('folder/child', { offset: 0, limit: 5 });
      expect(http.get.mock.calls[0][0]).toBe('/job/folder/job/child/api/json');
    });
  });

  describe('build number validation', () => {
    it('rejects non-positive or non-integer build numbers before any request', async () => {
      const client = new JenkinsClient();
      await expect(client.getBuild('EZAT-backend-dev', 0)).rejects.toThrow('Invalid build number');
      await expect(client.getBuild('EZAT-backend-dev', -1)).rejects.toThrow('Invalid build number');
      await expect(client.getConsole('EZAT-backend-dev', 1.5)).rejects.toThrow('Invalid build number');
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  describe('describeJenkinsError', () => {
    it('explains auth failures', () => {
      expect(describeJenkinsError({ isAxiosError: true, response: { status: 401 }, message: 'x' })).toContain(
        'JENKINS_USER / JENKINS_TOKEN',
      );
    });

    it('explains 404s', () => {
      expect(describeJenkinsError({ isAxiosError: true, response: { status: 404 }, message: 'x' })).toContain(
        'not found',
      );
    });

    it('reports a generic API error with its status', () => {
      expect(describeJenkinsError({ isAxiosError: true, response: { status: 500 }, message: 'boom' })).toBe(
        'Jenkins API error (500): boom',
      );
    });

    it('reports an API error with no status', () => {
      expect(describeJenkinsError({ isAxiosError: true, message: 'timeout' })).toBe('Jenkins API error: timeout');
    });

    it('falls back to the error message for non-axios errors', () => {
      expect(describeJenkinsError(new Error('boom'))).toBe('boom');
    });
  });
});
