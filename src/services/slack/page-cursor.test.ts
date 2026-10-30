import { describe, it, expect } from 'vitest';
import { decodeCursor, encodeCursor } from './page-cursor.js';
import { CHANNEL_ID, DM_ID } from './__fixtures__/synthetic.js';

const MESSAGES_TOOL = 'slack_get_messages';
const THREADS_TOOL = 'slack_get_threads';
const SLACK_POSITION = 'cursor-position-fixture';

function messagesCursor(target = CHANNEL_ID) {
  return encodeCursor(MESSAGES_TOOL, { target, position: SLACK_POSITION, skip: 3 });
}

function invalidCursorCode(result: ReturnType<typeof decodeCursor>) {
  return result.ok ? undefined : result.error.code;
}

describe('page cursor', () => {
  it('round-trips the target, Slack position and skip offset for the tool and target that issued it', () => {
    const cursor = messagesCursor();

    const decoded = decodeCursor(MESSAGES_TOOL, cursor, CHANNEL_ID);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.payload).toMatchObject({ target: CHANNEL_ID, position: SLACK_POSITION, skip: 3 });
  });

  it('is an opaque non-empty string', () => {
    const cursor = messagesCursor();

    expect(typeof cursor).toBe('string');
    expect(cursor.length).toBeGreaterThan(0);
  });

  it('carries the frozen upper time bound of a search page', () => {
    const cursor = encodeCursor('slack_search_messages', {
      target: 'search-key-fixture',
      position: '*',
      skip: 0,
      upper: '1700000000.000100',
    });

    const decoded = decodeCursor('slack_search_messages', cursor, 'search-key-fixture');

    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.payload).toMatchObject({ position: '*', upper: '1700000000.000100' });
  });

  it('restores the target for a cursor-only item that names no target', () => {
    const cursor = messagesCursor();

    const decoded = decodeCursor(MESSAGES_TOOL, cursor);

    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.payload.target).toBe(CHANNEL_ID);
  });

  it('rejects a cursor issued by a different tool', () => {
    const cursor = messagesCursor();

    expect(invalidCursorCode(decodeCursor(THREADS_TOOL, cursor, CHANNEL_ID))).toBe('invalid_cursor');
    expect(invalidCursorCode(decodeCursor(THREADS_TOOL, cursor))).toBe('invalid_cursor');
  });

  it('rejects a cursor issued for a different target', () => {
    const cursor = messagesCursor(CHANNEL_ID);

    expect(invalidCursorCode(decodeCursor(MESSAGES_TOOL, cursor, DM_ID))).toBe('invalid_cursor');
  });

  it.each([
    ['a truncated cursor', () => messagesCursor().slice(0, -6)],
    ['a made-up string', () => 'not-a-cursor'],
    ['an empty string', () => ''],
  ])('rejects %s without throwing', (_label, makeCursor) => {
    const cursor = makeCursor();

    expect(() => decodeCursor(MESSAGES_TOOL, cursor, CHANNEL_ID)).not.toThrow();
    expect(invalidCursorCode(decodeCursor(MESSAGES_TOOL, cursor, CHANNEL_ID))).toBe('invalid_cursor');
    expect(invalidCursorCode(decodeCursor(MESSAGES_TOOL, cursor))).toBe('invalid_cursor');
  });

  it('names the problem in a message an agent can read', () => {
    const decoded = decodeCursor(MESSAGES_TOOL, 'not-a-cursor', CHANNEL_ID);

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error.message.length).toBeGreaterThan(0);
  });
});
