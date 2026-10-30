// The home sandbox must stay the first import so that nothing resolves the real home.
import { removeSandbox, resetSandbox, seedToken } from './__fixtures__/tools/home-sandbox.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClock } from './__fixtures__/tools/clock.js';
import { createToolContext } from './__fixtures__/tools/context.js';
import { parseResult } from './__fixtures__/tools/assertions.js';
import { createFakeSlack, historyRoute, rawMessage, repliesRoute } from './__fixtures__/tools/fake-slack.js';
import { rootFirstRepliesRoute, topLevelHistoryRoute } from './__fixtures__/tools/fix1-slack-like-routes.js';
import {
  CHANNEL_ONE,
  CHANNEL_THREE,
  CHANNEL_TWO,
  EXAMPLE_TEAM,
  FILE_ONE,
  OTHER_TEAM,
  USER_ME,
  USER_PARTNER,
  channelLink,
  clientThreadLink,
  fileLink,
  messageLink,
  replyLink,
  tsFor,
  userLink,
} from './__fixtures__/tools/ids.js';
import { drainPages } from './__fixtures__/tools/messages-drain.js';
import { generateHistory, generateThread } from './__fixtures__/tools/messages-fixtures.js';
import { slackGetMessagesHandler, slackGetThreadsHandler } from './read-tools.js';

const PAGE_LIMIT = 100;

describe('slack_get_messages and slack_get_threads', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  it('continues two 250-message channels by cursor alone with every non-bot ts once, newest first', async () => {
    const channelOne = generateHistory({ count: 250, newestOffset: 1000, botEvery: 7, botRemainder: 3 });
    const channelTwo = generateHistory({ count: 250, newestOffset: 2000, botEvery: 5, botRemainder: 0 });
    const slack = createFakeSlack({
      routes: {
        'conversations.history': historyRoute({
          [CHANNEL_ONE]: channelOne.messages,
          [CHANNEL_TWO]: channelTwo.messages,
        }),
      },
    });
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    const outcome = await drainPages(
      async (items) => parseResult(await handler({ messages: items, limit: PAGE_LIMIT })),
      [{ channel: CHANNEL_ONE }, { channel: CHANNEL_TWO }],
    );

    expect(outcome.notOk).toEqual([]);
    expect(outcome.unfinished).toEqual([]);
    expect(outcome.botEntries).toBe(0);
    expect(outcome.timestamps[0]).toEqual(channelOne.humanTimestamps);
    expect(outcome.timestamps[1]).toEqual(channelTwo.humanTimestamps);
    expect(outcome.pageSizes[0].length).toBeGreaterThan(1);
    expect(outcome.pageSizes[1].length).toBeGreaterThan(1);
    for (const size of [...outcome.pageSizes[0], ...outcome.pageSizes[1]]) {
      expect(size).toBeLessThanOrEqual(PAGE_LIMIT);
    }
  });

  it('reads a channel link as that channel history', async () => {
    const history = generateHistory({ count: 3, newestOffset: 50, botEvery: 100, botRemainder: 99 });
    const slack = createFakeSlack({
      routes: { 'conversations.history': historyRoute({ [CHANNEL_ONE]: history.messages }) },
    });
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(
      await handler({ messages: [{ channel: channelLink(EXAMPLE_TEAM, CHANNEL_ONE) }] }),
    );

    expect(body.results[0].status).toBe('ok');
    expect(body.results[0].items.map((entry: any) => entry.ts)).toEqual(history.humanTimestamps);
    const historyCalls = slack.callsTo('conversations.history');
    expect(historyCalls).toHaveLength(1);
    const { channel, oldest, latest } = historyCalls[0].params;
    expect(channel).toBe(CHANNEL_ONE);
    expect(oldest !== undefined && oldest === latest).toBe(false);
  });

  it('fetches the root once for a message link, a reply link and a client-thread link', async () => {
    const threadA = generateThread(CHANNEL_ONE, 0, 4);
    const threadB = generateThread(CHANNEL_ONE, 10, 4);
    const threadC = generateThread(CHANNEL_TWO, 20, 4);
    const slack = createFakeSlack({
      routes: {
        'conversations.replies': repliesRoute({
          [threadA.key]: threadA.messages,
          [threadB.key]: threadB.messages,
          [threadC.key]: threadC.messages,
        }),
      },
    });
    const handler = slackGetThreadsHandler(createToolContext({ slack, clock: createClock() }));

    const outcome = await drainPages(
      async (items) => parseResult(await handler({ threads: items, limit: 2 })),
      [
        { thread: messageLink(EXAMPLE_TEAM, CHANNEL_ONE, threadA.rootTs) },
        { thread: replyLink(EXAMPLE_TEAM, CHANNEL_ONE, threadB.replyTs[1], threadB.rootTs) },
        { thread: clientThreadLink(EXAMPLE_TEAM, CHANNEL_TWO, threadC.rootTs) },
      ],
    );

    expect(outcome.notOk).toEqual([]);
    expect(outcome.unfinished).toEqual([]);
    expect(outcome.timestamps[0]).toEqual(threadA.timestamps);
    expect(outcome.timestamps[1]).toEqual(threadB.timestamps);
    expect(outcome.timestamps[2]).toEqual(threadC.timestamps);
    const fetchedThreads = new Set(
      slack.callsTo('conversations.replies').map((recorded) => `${recorded.params.channel}:${recorded.params.ts}`),
    );
    expect([...fetchedThreads].sort()).toEqual([threadA.key, threadB.key, threadC.key].sort());
  });

  it('makes one fetch for a reply link and the link of its root message together', async () => {
    const thread = generateThread(CHANNEL_ONE, 40, 2);
    const slack = createFakeSlack({
      routes: { 'conversations.replies': repliesRoute({ [thread.key]: thread.messages }) },
    });
    const handler = slackGetThreadsHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(
      await handler({
        threads: [
          { thread: replyLink(EXAMPLE_TEAM, CHANNEL_ONE, thread.replyTs[0], thread.rootTs) },
          { thread: messageLink(EXAMPLE_TEAM, CHANNEL_ONE, thread.rootTs) },
        ],
      }),
    );

    expect(slack.callsTo('conversations.replies')).toHaveLength(1);
    expect(body.results.map((result: any) => [result.index, result.status])).toEqual([
      [0, 'ok'],
      [1, 'ok'],
    ]);
    expect(body.results[0].items.map((entry: any) => entry.ts)).toEqual(thread.timestamps);
    expect(body.results[1].items.map((entry: any) => entry.ts)).toEqual(thread.timestamps);
  });

  it('fails a user link and a file link with wrong_link_kind and no upstream call', async () => {
    const slack = createFakeSlack();
    const context = createToolContext({ slack, clock: createClock() });

    const messages = parseResult(
      await slackGetMessagesHandler(context)({
        messages: [{ channel: userLink(EXAMPLE_TEAM, USER_PARTNER) }],
      }),
    );
    const threads = parseResult(
      await slackGetThreadsHandler(context)({
        threads: [{ thread: fileLink(EXAMPLE_TEAM, USER_ME, FILE_ONE) }],
      }),
    );

    expect(messages.results[0].status).toBe('error');
    expect(messages.results[0].error.code).toBe('wrong_link_kind');
    expect(threads.results[0].status).toBe('error');
    expect(threads.results[0].error.code).toBe('wrong_link_kind');
    expect(slack.calls).toHaveLength(0);
  });

  it('answers bad links with item errors and no upstream call while the good items stay ok', async () => {
    const historyOne = generateHistory({ count: 2, newestOffset: 60, botEvery: 100, botRemainder: 99 });
    const historyTwo = generateHistory({ count: 2, newestOffset: 70, botEvery: 100, botRemainder: 99 });
    const slack = createFakeSlack({
      routes: {
        'conversations.history': historyRoute({
          [CHANNEL_ONE]: historyOne.messages,
          [CHANNEL_TWO]: historyTwo.messages,
        }),
      },
    });
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(
      await handler({
        messages: [
          { channel: channelLink(EXAMPLE_TEAM, CHANNEL_ONE) },
          { channel: `https://example.com/archives/${CHANNEL_THREE}` },
          { channel: channelLink(OTHER_TEAM, CHANNEL_THREE) },
          { channel: CHANNEL_TWO },
        ],
      }),
    );

    expect(body.results.map((result: any) => result.status)).toEqual(['ok', 'error', 'error', 'ok']);
    expect(body.results[0].items.map((entry: any) => entry.ts)).toEqual(historyOne.humanTimestamps);
    expect(body.results[1].error.code).toBe('unrecognized_link');
    expect(body.results[2].error.code).toBe('wrong_workspace');
    expect(body.results[2].error.message).toContain('example-team');
    expect(body.results[3].items.map((entry: any) => entry.ts)).toEqual(historyTwo.humanTimestamps);
    expect(slack.calls.map((recorded) => recorded.params.channel).sort()).toEqual([
      CHANNEL_ONE,
      CHANNEL_TWO,
    ]);
  });
});

describe('slack_get_messages and slack_get_threads: a cursor belongs to the target it was issued for', () => {
  const channelOne = generateHistory({ count: 6, newestOffset: 100, botEvery: 100, botRemainder: 99 });
  const channelTwo = generateHistory({ count: 6, newestOffset: 200, botEvery: 100, botRemainder: 99 });

  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  function historySlack() {
    return createFakeSlack({
      routes: {
        'conversations.history': historyRoute({
          [CHANNEL_ONE]: channelOne.messages,
          [CHANNEL_TWO]: channelTwo.messages,
        }),
      },
    });
  }

  async function firstChannelOnePage(handler: ReturnType<typeof slackGetMessagesHandler>) {
    const first = parseResult(await handler({ messages: [{ channel: CHANNEL_ONE }], limit: 2 }));
    expect(first.results[0].items.map((entry: any) => entry.ts)).toEqual(channelOne.humanTimestamps.slice(0, 2));
    expect(first.results[0].hasMore).toBe(true);
    return first.results[0].nextPageToken as string;
  }

  it('fails a channel item that carries a cursor issued for another channel, returns none of its messages, and serves the rest', async () => {
    const slack = historySlack();
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));
    const cursorForChannelOne = await firstChannelOnePage(handler);
    const callsBefore = slack.calls.length;

    const body = parseResult(
      await handler({
        messages: [
          { channel: CHANNEL_TWO, cursor: cursorForChannelOne, ref: 'mismatch' },
          { channel: CHANNEL_TWO, ref: 'plain' },
        ],
        limit: 2,
      }),
    );

    expect(body.results[0].ref).toBe('mismatch');
    expect(body.results[0].status).toBe('error');
    expect(body.results[0].error.code).toBe('invalid_cursor');
    expect(body.results[0].items).toBeUndefined();
    expect(body.results[1].status).toBe('ok');
    expect(body.results[1].items.map((entry: any) => entry.ts)).toEqual(channelTwo.humanTimestamps.slice(0, 2));
    const returnedTimestamps = body.results.flatMap((result: any) => (result.items ?? []).map((entry: any) => entry.ts));
    for (const ts of channelOne.humanTimestamps) expect(returnedTimestamps).not.toContain(ts);
    expect(slack.calls.slice(callsBefore).map((recorded) => recorded.params.channel)).toEqual([CHANNEL_TWO]);
  });

  it('continues a channel item with its own cursor, whether the channel is given as an id or a link', async () => {
    const slack = historySlack();
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));
    const cursorForChannelOne = await firstChannelOnePage(handler);

    const body = parseResult(
      await handler({
        messages: [
          { channel: CHANNEL_ONE, cursor: cursorForChannelOne },
          { channel: channelLink(EXAMPLE_TEAM, CHANNEL_ONE), cursor: cursorForChannelOne },
        ],
        limit: 2,
      }),
    );

    expect(body.results.map((result: any) => result.status)).toEqual(['ok', 'ok']);
    for (const result of body.results) {
      expect(result.items.map((entry: any) => entry.ts)).toEqual(channelOne.humanTimestamps.slice(2, 4));
    }
  });

  it('fails a thread item that carries a cursor issued for another thread and returns none of that thread', async () => {
    const threadA = generateThread(CHANNEL_ONE, 0, 4);
    const threadB = generateThread(CHANNEL_ONE, 10, 4);
    const slack = createFakeSlack({
      routes: { 'conversations.replies': repliesRoute({ [threadA.key]: threadA.messages, [threadB.key]: threadB.messages }) },
    });
    const handler = slackGetThreadsHandler(createToolContext({ slack, clock: createClock() }));
    const first = parseResult(
      await handler({ threads: [{ thread: { channel: CHANNEL_ONE, ts: threadA.rootTs } }], limit: 2 }),
    );
    expect(first.results[0].hasMore).toBe(true);

    const body = parseResult(
      await handler({
        threads: [
          { thread: { channel: CHANNEL_ONE, ts: threadB.rootTs }, cursor: first.results[0].nextPageToken, ref: 'mismatch' },
        ],
        limit: 2,
      }),
    );

    expect(body.results[0].ref).toBe('mismatch');
    expect(body.results[0].status).toBe('error');
    expect(body.results[0].error.code).toBe('invalid_cursor');
    expect(body.results[0].items).toBeUndefined();
    expect(slack.callsTo('conversations.replies').map((recorded) => recorded.params.ts)).toEqual([threadA.rootTs]);
  });
});

describe('slack_get_messages: a message that is a thread reply', () => {
  const thread = generateThread(CHANNEL_ONE, 100, 3);
  const unthreaded = rawMessage({ ts: tsFor(200) });
  const threads = [thread.messages, [unthreaded]];
  const [, secondReplyTs] = thread.replyTs;

  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  function slackWithRootFirstReplies() {
    return createFakeSlack({
      routes: {
        'conversations.history': topLevelHistoryRoute(CHANNEL_ONE, threads),
        'conversations.replies': rootFirstRepliesRoute(CHANNEL_ONE, threads),
      },
    });
  }

  it('asks conversations.replies for at least two messages, so the parent cannot take the only slot', async () => {
    const slack = slackWithRootFirstReplies();
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    await handler({ messages: [{ message: replyLink(EXAMPLE_TEAM, CHANNEL_ONE, secondReplyTs, thread.rootTs) }] });

    const repliesCalls = slack.callsTo('conversations.replies');
    expect(repliesCalls).toHaveLength(1);
    expect(repliesCalls[0].params.limit ?? 100).toBeGreaterThanOrEqual(2);
  });

  it('finds a reply link when Slack returns the thread parent first', async () => {
    const slack = slackWithRootFirstReplies();
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(
      await handler({ messages: [{ message: replyLink(EXAMPLE_TEAM, CHANNEL_ONE, secondReplyTs, thread.rootTs) }] }),
    );

    expect(body.results[0].error).toBeUndefined();
    expect(body.results[0].status).toBe('ok');
    expect(body.results[0].items.map((entry: any) => entry.ts)).toEqual([secondReplyTs]);
  });

  it('finds a reply addressed as a channel and a ts, which conversations.history never returns', async () => {
    const slack = slackWithRootFirstReplies();
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(
      await handler({ messages: [{ message: { channel: CHANNEL_ONE, ts: secondReplyTs } }] }),
    );

    expect(body.results[0].error).toBeUndefined();
    expect(body.results[0].status).toBe('ok');
    expect(body.results[0].items.map((entry: any) => entry.ts)).toEqual([secondReplyTs]);
  });

  it('still finds an unthreaded message by a channel and a ts and by its link', async () => {
    const slack = slackWithRootFirstReplies();
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(
      await handler({
        messages: [
          { message: { channel: CHANNEL_ONE, ts: unthreaded.ts } },
          { message: messageLink(EXAMPLE_TEAM, CHANNEL_ONE, unthreaded.ts) },
        ],
      }),
    );

    expect(body.results.map((result: any) => result.status)).toEqual(['ok', 'ok']);
    for (const result of body.results) {
      expect(result.items.map((entry: any) => entry.ts)).toEqual([unthreaded.ts]);
    }
  });
});

describe('slack_get_messages: a message that does not exist', () => {
  const present = rawMessage({ ts: tsFor(200) });
  const missingTs = tsFor(900);

  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  function slackWithOneMessage() {
    return createFakeSlack({
      routes: { 'conversations.replies': rootFirstRepliesRoute(CHANNEL_ONE, [[present]]) },
    });
  }

  it.each([
    ['a channel and a ts', { channel: CHANNEL_ONE, ts: missingTs }],
    ['a message link', messageLink(EXAMPLE_TEAM, CHANNEL_ONE, missingTs)],
  ])('fails a message given as %s with message_not_found while the rest of the batch stays ok', async (_label, missing) => {
    const slack = slackWithOneMessage();
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(
      await handler({
        messages: [{ message: missing, ref: 'missing' }, { message: { channel: CHANNEL_ONE, ts: present.ts }, ref: 'present' }],
      }),
    );

    expect(body.results[0].ref).toBe('missing');
    expect(body.results[0].status).toBe('error');
    expect(body.results[0].error.code).toBe('message_not_found');
    expect(body.results[0].items).toBeUndefined();
    expect(body.results[1].ref).toBe('present');
    expect(body.results[1].status).toBe('ok');
    expect(body.results[1].items.map((entry: any) => entry.ts)).toEqual([present.ts]);
    expect(slack.callsTo('conversations.replies').map((recorded) => recorded.params.ts)).toContain(missingTs);
  });

  it('keeps channel_not_found for a message in a channel Slack does not know', async () => {
    const slack = slackWithOneMessage();
    const handler = slackGetMessagesHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(await handler({ messages: [{ message: { channel: CHANNEL_TWO, ts: present.ts } }] }));

    expect(body.results[0].status).toBe('error');
    expect(body.results[0].error.code).toBe('channel_not_found');
  });
});

describe('slack_get_threads: a thread that does not exist', () => {
  const thread = generateThread(CHANNEL_ONE, 300, 2);

  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  it('keeps thread_not_found for an unknown thread while the rest of the batch stays ok', async () => {
    const slack = createFakeSlack({
      routes: { 'conversations.replies': repliesRoute({ [thread.key]: thread.messages }) },
    });
    const handler = slackGetThreadsHandler(createToolContext({ slack, clock: createClock() }));

    const body = parseResult(
      await handler({
        threads: [
          { thread: { channel: CHANNEL_ONE, ts: tsFor(900) }, ref: 'unknown' },
          { thread: { channel: CHANNEL_ONE, ts: thread.rootTs }, ref: 'known' },
        ],
      }),
    );

    expect(body.results[0].ref).toBe('unknown');
    expect(body.results[0].status).toBe('error');
    expect(body.results[0].error.code).toBe('thread_not_found');
    expect(body.results[1].ref).toBe('known');
    expect(body.results[1].status).toBe('ok');
    expect(body.results[1].items.map((entry: any) => entry.ts)).toEqual(thread.timestamps);
  });
});
