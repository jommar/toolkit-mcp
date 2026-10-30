import { describe, it, expect, vi } from 'vitest';
import { WriteGate } from './write-gate.js';
import { createClock } from './__fixtures__/tools/clock.js';
import { expectSlackError } from './__fixtures__/tools/assertions.js';

const TEN_MINUTES_MS = 10 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

const THREE_ITEMS = [
  { action: 'post', text: 'first' },
  { action: 'post', text: 'second' },
  { action: 'post', text: 'third' },
];

function newGate() {
  const clock = createClock();
  return { clock, gate: new WriteGate({ now: clock.now }) };
}

describe('WriteGate', () => {
  it('rejects a token redeemed after ten minutes with confirmation_expired and runs nothing', async () => {
    const { clock, gate } = newGate();
    const { confirmation_token } = gate.issue(THREE_ITEMS);
    clock.advance(TEN_MINUTES_MS + 1);
    const execute = vi.fn();

    await expectSlackError(() => gate.redeem(confirmation_token, execute), 'confirmation_expired');

    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an unknown token with confirmation_unknown and runs nothing', async () => {
    const { gate } = newGate();
    gate.issue(THREE_ITEMS);
    const execute = vi.fn();

    await expectSlackError(() => gate.redeem('token-that-was-never-issued', execute), 'confirmation_unknown');

    expect(execute).not.toHaveBeenCalled();
  });

  it('returns the stored results with already_sent on a replay and runs the executor once per item', async () => {
    const { clock, gate } = newGate();
    const { confirmation_token } = gate.issue(THREE_ITEMS);
    const execute = vi.fn(async (item: { text: string }, index: number) => ({
      index,
      status: 'ok',
      echoed: item.text,
    }));

    const first = await gate.redeem(confirmation_token, execute);
    clock.advance(9 * ONE_MINUTE_MS);
    const replay = await gate.redeem(confirmation_token, execute);

    expect(first.already_sent).toBe(false);
    expect(first.results).toEqual([
      { index: 0, status: 'ok', echoed: 'first' },
      { index: 1, status: 'ok', echoed: 'second' },
      { index: 2, status: 'ok', echoed: 'third' },
    ]);
    expect(replay.already_sent).toBe(true);
    expect(replay.results).toEqual(first.results);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([, index]) => index)).toEqual([0, 1, 2]);
  });

  it('forgets an expired token when another is issued, so it reads confirmation_unknown rather than confirmation_expired', async () => {
    const { clock, gate } = newGate();
    const { confirmation_token: stale } = gate.issue(THREE_ITEMS);
    clock.advance(TEN_MINUTES_MS + 1);
    gate.issue(THREE_ITEMS);
    const execute = vi.fn();

    await expectSlackError(() => gate.redeem(stale, execute), 'confirmation_unknown');

    expect(execute).not.toHaveBeenCalled();
  });

  it('forgets every prepare-only token once the ten minutes have passed and another is issued', async () => {
    const { clock, gate } = newGate();
    const abandoned = Array.from({ length: 50 }, () => gate.issue(THREE_ITEMS).confirmation_token);
    clock.advance(TEN_MINUTES_MS + 1);
    gate.issue(THREE_ITEMS);

    for (const token of abandoned) {
      await expectSlackError(() => gate.redeem(token, vi.fn()), 'confirmation_unknown');
    }
  });

  it('keeps a token that has not expired when an older one is swept', async () => {
    const { clock, gate } = newGate();
    const { confirmation_token: older } = gate.issue(THREE_ITEMS);
    clock.advance(6 * ONE_MINUTE_MS);
    const { confirmation_token: younger } = gate.issue(THREE_ITEMS);
    clock.advance(5 * ONE_MINUTE_MS);
    gate.issue(THREE_ITEMS);
    const execute = vi.fn(async (_item: unknown, index: number) => ({ index, status: 'ok' }));

    await expectSlackError(() => gate.redeem(older, execute), 'confirmation_unknown');
    const redeemed = await gate.redeem(younger, execute);

    expect(redeemed.already_sent).toBe(false);
    expect(redeemed.results).toHaveLength(3);
  });

  it('answers a replay of a redeemed token with already_sent while it lives, and forgets it after it expires', async () => {
    const { clock, gate } = newGate();
    const { confirmation_token: sent } = gate.issue(THREE_ITEMS);
    const execute = vi.fn(async (_item: unknown, index: number) => ({ index, status: 'ok' }));
    const first = await gate.redeem(sent, execute);
    clock.advance(5 * ONE_MINUTE_MS);
    gate.issue(THREE_ITEMS);

    const replay = await gate.redeem(sent, execute);

    expect(replay.already_sent).toBe(true);
    expect(replay.results).toEqual(first.results);
    expect(execute).toHaveBeenCalledTimes(3);

    clock.advance(5 * ONE_MINUTE_MS + 1);
    gate.issue(THREE_ITEMS);

    await expectSlackError(() => gate.redeem(sent, execute), 'confirmation_unknown');
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
