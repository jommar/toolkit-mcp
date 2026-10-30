import { describe, expect, it, vi } from 'vitest';
import { runBatch } from './batch-runner.js';
import { keyOf, messageOf, page, resumeCursorOf, type BatchItem } from './__fixtures__/batch-helpers.js';

describe('runBatch response ceiling', () => {
  it('drops whole messages from the end, sets truncated and points the cut entry at its first omitted message', async () => {
    const earlier = Array.from({ length: 2 }, (_unused, index) => messageOf('A', index));
    const later = Array.from({ length: 8 }, (_unused, index) => messageOf('B', index));
    const exec = vi.fn(async (item: BatchItem) =>
      item.id === 'A'
        ? page(earlier)
        : page(later, { hasMore: true, nextPageToken: 'slack-next-page-of-B' }),
    );

    const { results, truncated } = await runBatch([{ id: 'A' }, { id: 'B' }], {
      key: keyOf,
      exec,
      resume: resumeCursorOf,
      limits: { maxItems: 20, maxResponseChars: 700 },
    });

    const kept = results[1].items?.length ?? -1;
    expect(truncated).toBe(true);
    expect(results[0].items).toEqual(earlier);
    expect(results[0].nextPageToken).toBeUndefined();
    expect(kept).toBeGreaterThanOrEqual(1);
    expect(kept).toBeLessThan(later.length);
    expect(results[1].items).toEqual(later.slice(0, kept));
    expect(results[1].hasMore).toBe(true);
    expect(results[1].nextPageToken).toBe(`resume:B:${kept}`);
    expect(results[1].nextPageToken).not.toBe('slack-next-page-of-B');
  });

  it('leaves a result under the ceiling whole and not truncated', async () => {
    const small = [messageOf('A', 0), messageOf('A', 1)];
    const exec = vi.fn(async () => page(small, { hasMore: true, nextPageToken: 'slack-next-page-of-A' }));

    const { results, truncated } = await runBatch([{ id: 'A' }], {
      key: keyOf,
      exec,
      resume: resumeCursorOf,
      limits: { maxItems: 20, maxResponseChars: 100_000 },
    });

    expect(truncated).toBe(false);
    expect(results[0].items).toEqual(small);
    expect(results[0].nextPageToken).toBe('slack-next-page-of-A');
  });

  it('uses a 100,000 character ceiling by default', async () => {
    const huge = Array.from({ length: 5 }, (_unused, index) => messageOf('A', index, 30_000));
    const exec = vi.fn(async () => page(huge));

    const { results, truncated } = await runBatch([{ id: 'A' }], {
      key: keyOf,
      exec,
      resume: resumeCursorOf,
      limits: { maxItems: 20 },
    });

    expect(truncated).toBe(true);
    expect(results[0].items).toEqual(huge.slice(0, 3));
    expect(results[0].hasMore).toBe(true);
    expect(results[0].nextPageToken).toBe('resume:A:3');
  });
});
