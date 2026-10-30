import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBatch } from './batch-runner.js';
import {
  deferred,
  failure,
  keyOf,
  messageOf,
  numberedItems,
  page,
  resumeCursorOf,
  tick,
  type BatchItem,
} from './__fixtures__/batch-helpers.js';

const instantExec = () => vi.fn(async (item: BatchItem) => page([messageOf(item.id, 0)]));

describe('runBatch scale limits', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('concurrency', () => {
    it('keeps at most 4 upstream executions in flight across 20 slow items', async () => {
      vi.useFakeTimers();
      let inFlight = 0;
      let highWaterMark = 0;
      const exec = vi.fn(async (item: BatchItem) => {
        inFlight += 1;
        highWaterMark = Math.max(highWaterMark, inFlight);
        await new Promise((done) => setTimeout(done, 100));
        inFlight -= 1;
        return page([messageOf(item.id, 0)]);
      });

      const running = runBatch(numberedItems(20), {
        key: keyOf,
        exec,
        resume: resumeCursorOf,
        limits: { maxItems: 20 },
      });
      await vi.runAllTimersAsync();
      const { results } = await running;

      expect(highWaterMark).toBe(4);
      expect(exec).toHaveBeenCalledTimes(20);
      expect(results.every((entry) => entry.status === 'ok')).toBe(true);
    });
  });

  describe('call budget', () => {
    it('stops at 50 upstream calls by default and returns the rest as not_attempted with resume cursors', async () => {
      const items = numberedItems(60);
      const exec = instantExec();

      const { results } = await runBatch(items, {
        key: keyOf,
        exec,
        resume: resumeCursorOf,
        limits: { maxItems: 60 },
      });

      expect(exec).toHaveBeenCalledTimes(50);
      expect(results.slice(0, 50).every((entry) => entry.status === 'ok')).toBe(true);
      expect(results.slice(50).map((entry) => entry.status)).toEqual(Array(10).fill('not_attempted'));
      expect(results.slice(50).map((entry) => entry.nextPageToken)).toEqual(
        items.slice(50).map((item) => `resume:${item.id}:0`),
      );
    });

    it('marks the unstarted tail not_attempted when the budget runs out mid-batch', async () => {
      const items = numberedItems(8);
      const exec = instantExec();

      const { results } = await runBatch(items, {
        key: keyOf,
        exec,
        resume: resumeCursorOf,
        limits: { maxItems: 8, callBudget: 5, concurrency: 2 },
      });

      expect(exec).toHaveBeenCalledTimes(5);
      expect(results.map((entry) => entry.status)).toEqual([
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'not_attempted',
        'not_attempted',
        'not_attempted',
      ]);
      expect(results.slice(5).map((entry) => entry.nextPageToken)).toEqual(['resume:item-6:0', 'resume:item-7:0', 'resume:item-8:0']);
      expect(results.slice(5).map((entry) => entry.ref)).toEqual(['item-6', 'item-7', 'item-8']);
    });
  });

  describe('a rate limit that survives retries', () => {
    it('reports rate_limited with retry_after_s on that item and starts nothing after it', async () => {
      const items = numberedItems(6);
      const exec = vi.fn(async (item: BatchItem) => {
        if (item.id === 'item-3') throw failure('rate_limited', { retry_after_s: 7 });
        return page([messageOf(item.id, 0)]);
      });

      const { results } = await runBatch(items, {
        key: keyOf,
        exec,
        resume: resumeCursorOf,
        limits: { maxItems: 6, concurrency: 1 },
      });

      expect(exec).toHaveBeenCalledTimes(3);
      expect(results.map((entry) => entry.status)).toEqual([
        'ok',
        'ok',
        'error',
        'not_attempted',
        'not_attempted',
        'not_attempted',
      ]);
      expect(results[2].error).toMatchObject({ code: 'rate_limited', retry_after_s: 7 });
      expect(results.slice(3).map((entry) => entry.nextPageToken)).toEqual([
        'resume:item-4:0',
        'resume:item-5:0',
        'resume:item-6:0',
      ]);
    });

    it('starts no new item even when another execution is still in flight and frees a slot afterwards', async () => {
      const items = numberedItems(6);
      const stillRunning = deferred();
      const exec = vi.fn(async (item: BatchItem) => {
        if (item.id === 'item-1') throw failure('rate_limited', { retry_after_s: 7 });
        await stillRunning.promise;
        return page([messageOf(item.id, 0)]);
      });

      const running = runBatch(items, {
        key: keyOf,
        exec,
        resume: resumeCursorOf,
        limits: { maxItems: 6, concurrency: 2 },
      });
      await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
      await tick(25);
      expect(exec).toHaveBeenCalledTimes(2);
      stillRunning.resolve();
      const { results } = await running;

      expect(exec).toHaveBeenCalledTimes(2);
      expect(results[0]).toMatchObject({ status: 'error', error: { code: 'rate_limited', retry_after_s: 7 } });
      expect(results[1].status).toBe('ok');
      expect(results.slice(2).map((entry) => entry.status)).toEqual(Array(4).fill('not_attempted'));
      expect(results[2].nextPageToken).toBe('resume:item-3:0');
    });
  });
});
