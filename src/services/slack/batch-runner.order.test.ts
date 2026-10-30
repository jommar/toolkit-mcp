import { describe, it, expect, vi } from 'vitest';
import { runBatch } from './batch-runner.js';
import {
  deferred,
  failure,
  keyOf,
  messageOf,
  page,
  resumeCursorOf,
  type BatchItem,
} from './__fixtures__/batch-helpers.js';
import { settle } from './__fixtures__/settle.js';

const LIMITS = { maxItems: 20 };

describe('runBatch input order, dedupe and per-item failure', () => {
  it('returns one entry per input position in input order, echoing refs, running a repeated key once and failing only the failing item', async () => {
    const messagesOf = {
      A: [messageOf('A', 0)],
      B: [messageOf('B', 0), messageOf('B', 1)],
    };
    const exec = vi.fn(async (item: BatchItem) => {
      if (item.id === 'C') throw failure('channel_not_found');
      return page(messagesOf[item.id as 'A' | 'B']);
    });
    const items: BatchItem[] = [
      { id: 'B', ref: 'first-b' },
      { id: 'A', ref: 'only-a' },
      { id: 'B', ref: 'second-b' },
      { id: 'C' },
    ];

    const { results, truncated } = await runBatch(items, { key: keyOf, exec, resume: resumeCursorOf, limits: LIMITS });

    expect(results.map((entry) => entry.index)).toEqual([0, 1, 2, 3]);
    expect(results.map((entry) => entry.ref)).toEqual(['first-b', 'only-a', 'second-b', 'C']);
    expect(results.map((entry) => entry.status)).toEqual(['ok', 'ok', 'ok', 'error']);
    expect(results[0].items).toEqual(messagesOf.B);
    expect(results[2].items).toEqual(messagesOf.B);
    expect(results[1].items).toEqual(messagesOf.A);
    expect(results[3].error).toMatchObject({ code: 'channel_not_found' });
    expect(results[3].items).toBeUndefined();
    expect(truncated).toBe(false);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls.filter(([item]) => item.id === 'B')).toHaveLength(1);
  });

  it('keeps input order even when later items finish first', async () => {
    const slowFirst = deferred();
    const exec = vi.fn(async (item: BatchItem) => {
      if (item.id === 'A') await slowFirst.promise;
      return page([messageOf(item.id, 0)]);
    });
    const running = runBatch([{ id: 'A' }, { id: 'B' }, { id: 'C' }], {
      key: keyOf,
      exec,
      resume: resumeCursorOf,
      limits: LIMITS,
    });

    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(3));
    slowFirst.resolve();
    const { results } = await running;

    expect(results.map((entry) => entry.ref)).toEqual(['A', 'B', 'C']);
    expect(results.map((entry) => entry.items?.[0].owner)).toEqual(['A', 'B', 'C']);
  });

  it('passes an item\'s own next-page token and hasMore through untouched', async () => {
    const exec = vi.fn(async () => page([messageOf('A', 0)], { hasMore: true, nextPageToken: 'slack-next-page' }));

    const { results } = await runBatch([{ id: 'A' }], { key: keyOf, exec, resume: resumeCursorOf, limits: LIMITS });

    expect(results[0]).toMatchObject({ status: 'ok', hasMore: true, nextPageToken: 'slack-next-page' });
  });

  it('fails the whole call with batch_too_large and makes no upstream call when items exceed the cap', async () => {
    const exec = vi.fn(async (item: BatchItem) => page([messageOf(item.id, 0)]));
    const items: BatchItem[] = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];

    const outcome = await settle(() =>
      runBatch(items, { key: keyOf, exec, resume: resumeCursorOf, limits: { maxItems: 3 } }),
    );

    expect(outcome.threw).toBe(true);
    expect(String(outcome.error?.message)).toContain('slack.batch_too_large');
    expect(exec).not.toHaveBeenCalled();
  });

  it('accepts exactly the cap', async () => {
    const exec = vi.fn(async (item: BatchItem) => page([messageOf(item.id, 0)]));

    const { results } = await runBatch([{ id: 'A' }, { id: 'B' }, { id: 'C' }], {
      key: keyOf,
      exec,
      resume: resumeCursorOf,
      limits: { maxItems: 3 },
    });

    expect(results.map((entry) => entry.status)).toEqual(['ok', 'ok', 'ok']);
  });
});
