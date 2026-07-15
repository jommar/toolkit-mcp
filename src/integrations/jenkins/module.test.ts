import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  jenkinsGetJobsHandler,
  jenkinsGetBuildsHandler,
  jenkinsGetBuildHandler,
  jenkinsGetConsoleHandler,
  jenkinsHealthcheckHandler,
} from './module.js';

function makeMockJenkins() {
  return {
    getJobs: vi.fn(),
    getBuilds: vi.fn(),
    getBuild: vi.fn(),
    getConsole: vi.fn(),
  };
}

describe('jenkins module handlers', () => {
  let jenkins: ReturnType<typeof makeMockJenkins>;

  beforeEach(() => {
    jenkins = makeMockJenkins();
  });

  describe('jenkinsGetJobsHandler', () => {
    it('emits a nextPageToken when more pages exist', async () => {
      jenkins.getJobs.mockResolvedValue({
        items: [{ name: 'a', status: 'success' }],
        total: 5,
        hasMore: true,
        nextOffset: 1,
      });
      const result = await jenkinsGetJobsHandler({ jenkins: jenkins as any })({ limit: 1 });
      const body = JSON.parse(result.content[0].text);
      expect(body.nextPageToken).toBe('1');
      expect(body.hasMore).toBe(true);
      expect(body.total).toBe(5);
    });

    it('passes the cursor through as an offset', async () => {
      jenkins.getJobs.mockResolvedValue({ items: [], total: 5, hasMore: false });
      await jenkinsGetJobsHandler({ jenkins: jenkins as any })({ limit: 2, cursor: '2' });
      expect(jenkins.getJobs).toHaveBeenCalledWith({ offset: 2, limit: 2 });
    });

    it('treats a non-numeric or negative cursor as offset 0', async () => {
      jenkins.getJobs.mockResolvedValue({ items: [], total: 0, hasMore: false });
      await jenkinsGetJobsHandler({ jenkins: jenkins as any })({ limit: 2, cursor: 'abc' });
      expect(jenkins.getJobs).toHaveBeenLastCalledWith({ offset: 0, limit: 2 });
      await jenkinsGetJobsHandler({ jenkins: jenkins as any })({ limit: 2, cursor: '-5' });
      expect(jenkins.getJobs).toHaveBeenLastCalledWith({ offset: 0, limit: 2 });
    });
  });

  describe('jenkinsGetBuildsHandler', () => {
    it('returns builds with pagination token', async () => {
      jenkins.getBuilds.mockResolvedValue({
        items: [{ number: 10, result: 'SUCCESS' }],
        hasMore: true,
        nextOffset: 1,
      });
      const result = await jenkinsGetBuildsHandler({ jenkins: jenkins as any })({ job: 'EZAT-backend-dev', limit: 1 });
      const body = JSON.parse(result.content[0].text);
      expect(body.items[0].number).toBe(10);
      expect(body.nextPageToken).toBe('1');
    });
  });

  describe('jenkinsGetBuildHandler', () => {
    it('returns a single build with no pagination envelope', async () => {
      jenkins.getBuild.mockResolvedValue({ number: 42, result: 'SUCCESS' });
      const result = await jenkinsGetBuildHandler({ jenkins: jenkins as any })({ job: 'EZAT-backend-dev' });
      const body = JSON.parse(result.content[0].text);
      expect(body.number).toBe(42);
      expect(body.items).toBeUndefined();
      expect(jenkins.getBuild).toHaveBeenCalledWith('EZAT-backend-dev', undefined);
    });
  });

  describe('jenkinsGetConsoleHandler', () => {
    it('returns log lines with totalLines and a next token', async () => {
      jenkins.getConsole.mockResolvedValue({
        lines: ['line1', 'line2'],
        totalLines: 5,
        fromLine: 0,
        hasMore: true,
        nextOffset: 2,
      });
      const result = await jenkinsGetConsoleHandler({ jenkins: jenkins as any })({ job: 'EZAT-backend-dev', limit: 2 });
      const body = JSON.parse(result.content[0].text);
      expect(body.items).toEqual(['line1', 'line2']);
      expect(body.totalLines).toBe(5);
      expect(body.fromLine).toBe(0);
      expect(body.nextPageToken).toBe('2');
    });
  });

  describe('jenkinsHealthcheckHandler', () => {
    const job = (name: string, lastBuildNumber: number | null, lastResult: string | null) => ({
      name,
      url: `http://jenkins/job/${name}/`,
      status: lastResult === 'SUCCESS' ? 'success' : 'failed',
      color: null,
      lastBuildNumber,
      lastResult,
    });

    it('reports healthy when every visible job last built SUCCESS', async () => {
      jenkins.getJobs.mockResolvedValue({
        items: [job('EZAT-backend-dev', 167, 'SUCCESS'), job('TT-dev', 1577, 'SUCCESS')],
        total: 2,
        hasMore: false,
      });
      const result = await jenkinsHealthcheckHandler({ jenkins: jenkins as any })({});
      const body = JSON.parse(result.content[0].text);
      expect(body.healthy).toBe(true);
      expect(body.checked).toBe(2);
      expect(body.unhealthy).toEqual([]);
      expect(body.jobs[0].buildUrl).toBe('http://jenkins/job/EZAT-backend-dev/167/');
    });

    it('flags a failed build as unhealthy', async () => {
      jenkins.getJobs.mockResolvedValue({
        items: [job('EZAT-backend-dev', 165, 'FAILURE'), job('TT-dev', 1577, 'SUCCESS')],
        total: 2,
        hasMore: false,
      });
      const result = await jenkinsHealthcheckHandler({ jenkins: jenkins as any })({});
      const body = JSON.parse(result.content[0].text);
      expect(body.healthy).toBe(false);
      expect(body.unhealthy).toEqual([
        { job: 'EZAT-backend-dev', lastResult: 'FAILURE', buildUrl: 'http://jenkins/job/EZAT-backend-dev/165/' },
      ]);
    });

    it('treats an in-progress build (null result) as building, not a failure', async () => {
      jenkins.getJobs.mockResolvedValue({
        items: [job('EZAT-backend-dev', 168, null)],
        total: 1,
        hasMore: false,
      });
      const result = await jenkinsHealthcheckHandler({ jenkins: jenkins as any })({});
      const body = JSON.parse(result.content[0].text);
      expect(body.healthy).toBe(true);
      expect(body.building).toEqual([{ job: 'EZAT-backend-dev', buildUrl: 'http://jenkins/job/EZAT-backend-dev/168/' }]);
      expect(body.unhealthy).toEqual([]);
    });

    it('filters to the requested jobs and annotates unknown names without failing the call', async () => {
      jenkins.getJobs.mockResolvedValue({
        items: [job('EZAT-backend-dev', 167, 'SUCCESS'), job('TT-dev', 1577, 'SUCCESS')],
        total: 2,
        hasMore: false,
      });
      const result = await jenkinsHealthcheckHandler({ jenkins: jenkins as any })({
        jobs: ['EZAT-backend-dev', 'EZAT-nope-dev'],
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.checked).toBe(1);
      expect(body.jobs.map((j: any) => j.job)).toEqual(['EZAT-backend-dev']);
      expect(body.notFound).toEqual(['EZAT-nope-dev']);
      expect(body.healthy).toBe(false);
    });

    it('treats a never-built job (no build number) as unhealthy, not building', async () => {
      jenkins.getJobs.mockResolvedValue({
        items: [job('EZAT-backend-dev', null, null)],
        total: 1,
        hasMore: false,
      });
      const result = await jenkinsHealthcheckHandler({ jenkins: jenkins as any })({});
      const body = JSON.parse(result.content[0].text);
      expect(body.healthy).toBe(false);
      expect(body.building).toEqual([]);
      expect(body.unhealthy).toEqual([{ job: 'EZAT-backend-dev', lastResult: null, buildUrl: null }]);
    });

    it('de-duplicates repeated job names in the request', async () => {
      jenkins.getJobs.mockResolvedValue({
        items: [job('EZAT-backend-dev', 167, 'SUCCESS')],
        total: 1,
        hasMore: false,
      });
      const result = await jenkinsHealthcheckHandler({ jenkins: jenkins as any })({
        jobs: ['EZAT-backend-dev', 'EZAT-backend-dev'],
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.checked).toBe(1);
      expect(body.jobs).toHaveLength(1);
    });

    it('reports checked:0 when no jobs are visible', async () => {
      jenkins.getJobs.mockResolvedValue({ items: [], total: 0, hasMore: false });
      const result = await jenkinsHealthcheckHandler({ jenkins: jenkins as any })({});
      const body = JSON.parse(result.content[0].text);
      expect(body.checked).toBe(0);
      expect(body.jobs).toEqual([]);
    });

    it('follows pagination so scope is never silently capped', async () => {
      jenkins.getJobs
        .mockResolvedValueOnce({ items: [job('a', 1, 'SUCCESS')], total: 2, hasMore: true, nextOffset: 1 })
        .mockResolvedValueOnce({ items: [job('b', 1, 'SUCCESS')], total: 2, hasMore: false });
      const result = await jenkinsHealthcheckHandler({ jenkins: jenkins as any })({});
      const body = JSON.parse(result.content[0].text);
      expect(body.checked).toBe(2);
      expect(jenkins.getJobs).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('wraps a plain client error as an McpError (not the raw Error)', async () => {
      jenkins.getJobs.mockRejectedValue(new Error('network down'));
      await expect(jenkinsGetJobsHandler({ jenkins: jenkins as any })({})).rejects.toBeInstanceOf(McpError);
      await expect(jenkinsGetJobsHandler({ jenkins: jenkins as any })({})).rejects.toThrow('network down');
    });

    it('passes an existing McpError through unchanged', async () => {
      const original = new McpError(ErrorCode.InvalidParams, 'bad input');
      jenkins.getBuild.mockRejectedValue(original);
      await expect(
        jenkinsGetBuildHandler({ jenkins: jenkins as any })({ job: 'EZAT-backend-dev' }),
      ).rejects.toBe(original);
    });
  });
});
