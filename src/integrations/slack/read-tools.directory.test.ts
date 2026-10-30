import './__fixtures__/tools/home-sandbox.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  removeSandbox,
  resetSandbox,
  seedToken,
} from './__fixtures__/tools/home-sandbox.js';
import { createClock } from './__fixtures__/tools/clock.js';
import { createToolContext } from './__fixtures__/tools/context.js';
import {
  conversationsInfoRoute,
  constantRoute,
  createFakeSlack,
  directChannel,
  privateChannel,
  publicChannel,
  rawSearchMatch,
  rawUser,
  slackFailure,
  usersInfoRoute,
  type RawUser,
} from './__fixtures__/tools/fake-slack.js';
import { expectInvalidParams, expectSlackError, parseResult } from './__fixtures__/tools/assertions.js';
import {
  MATCHES_PER_NAME,
  UPSTREAM_CALLS_PER_NAME,
  budgetRoomIds,
  budgetRoomName,
  nameFallbackRoutes,
} from './__fixtures__/tools/fix1-budget-fixtures.js';
import {
  CHANNEL_ONE,
  CHANNEL_THREE,
  CHANNEL_TWO,
  DM_ONE,
  EMAIL_SENTINEL_ADDRESS,
  EXAMPLE_TEAM,
  USER_ME,
  USER_PARTNER,
  channelLink,
  tsFor,
} from './__fixtures__/tools/ids.js';
import { slackGetChannelsHandler, slackGetUsersHandler } from './read-tools.js';

const ME = rawUser({ id: USER_ME, displayName: 'Example Me' });
const PARTNER = rawUser({ id: USER_PARTNER, displayName: 'Example Partner' });

function personId(n: number): string {
  return `U0EXAMPLE${String(n).padStart(2, '0')}`;
}

function harness(options: Parameters<typeof createFakeSlack>[0] = {}) {
  const clock = createClock();
  const slack = createFakeSlack(options);
  return { slack, ctx: createToolContext({ slack, clock }) };
}

describe('slack_get_channels', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  it('takes each channel type from one conversations.info call, for ids and links alike', async () => {
    const { slack, ctx } = harness({
      routes: {
        'conversations.info': conversationsInfoRoute({
          [CHANNEL_ONE]: publicChannel(CHANNEL_ONE, 'example-room'),
          [CHANNEL_TWO]: privateChannel(CHANNEL_TWO, 'private-room'),
          [DM_ONE]: directChannel(DM_ONE, USER_PARTNER),
        }),
        'users.info': usersInfoRoute([ME, PARTNER]),
        'conversations.members': constantRoute({ members: [USER_ME, USER_PARTNER] }),
      },
      directory: [ME, PARTNER],
    });

    const body = parseResult(
      await slackGetChannelsHandler(ctx)({
        channels: [
          { channel: CHANNEL_ONE },
          { channel: channelLink(EXAMPLE_TEAM, CHANNEL_TWO) },
          { channel: channelLink(EXAMPLE_TEAM, DM_ONE) },
        ],
      }),
    );

    expect(body.results).toHaveLength(3);
    expect(body.results.map((result: any) => result.status)).toEqual(['ok', 'ok', 'ok']);
    expect(body.results.map((result: any) => result.items[0].channel_id)).toEqual([
      CHANNEL_ONE,
      CHANNEL_TWO,
      DM_ONE,
    ]);
    expect(body.results.map((result: any) => result.items[0].type)).toEqual([
      'public_channel',
      'private_channel',
      'im',
    ]);
    const infoCalls = slack.callsTo('conversations.info');
    expect(infoCalls).toHaveLength(3);
    expect(infoCalls.map((recorded) => recorded.params.channel).sort()).toEqual(
      [CHANNEL_ONE, CHANNEL_TWO, DM_ONE].sort(),
    );
  });

  it('falls back to a message search for a name that conversations.list does not hold', async () => {
    const { slack, ctx } = harness({
      routes: {
        'conversations.list': constantRoute({
          channels: [publicChannel(CHANNEL_ONE, 'example-room')],
        }),
        'search.messages': constantRoute({
          messages: {
            total: 1,
            matches: [
              rawSearchMatch({
                ts: tsFor(5),
                channelId: CHANNEL_THREE,
                channelName: 'unlisted-room',
              }),
            ],
          },
        }),
        'conversations.info': conversationsInfoRoute({
          [CHANNEL_THREE]: publicChannel(CHANNEL_THREE, 'unlisted-room'),
        }),
      },
    });

    const body = parseResult(
      await slackGetChannelsHandler(ctx)({ channels: [{ name: 'unlisted-room' }] }),
    );

    expect(body.results[0].status).toBe('ok');
    expect(body.results[0].items[0].channel_id).toBe(CHANNEL_THREE);
    expect(body.results[0].items[0].name).toBe('unlisted-room');
    const searchCalls = slack.callsTo('search.messages');
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0].params.query).toContain('in:unlisted-room');
    const methodsInOrder = slack.calls.map((recorded) => recorded.method);
    expect(methodsInOrder.indexOf('conversations.list')).toBeGreaterThanOrEqual(0);
    expect(methodsInOrder.indexOf('conversations.list')).toBeLessThan(
      methodsInOrder.indexOf('search.messages'),
    );
  });
});

describe('slack_get_users', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  it('reads more than ten user ids from the directory instead of one users.info call each', async () => {
    const people: RawUser[] = Array.from({ length: 11 }, (_, offset) =>
      rawUser({ id: personId(10 + offset), displayName: `Example Person ${10 + offset}` }),
    );
    const { slack, ctx } = harness({ directory: people });

    const body = parseResult(
      await slackGetUsersHandler(ctx)({ users: people.map((person) => ({ user: person.id })) }),
    );

    expect(slack.client.getUserDirectory).toHaveBeenCalledTimes(1);
    expect(slack.callsTo('users.info')).toHaveLength(0);
    expect(body.results).toHaveLength(11);
    expect(body.results.map((result: any) => result.status)).toEqual(Array(11).fill('ok'));
    expect(body.results.map((result: any) => result.items[0].user_id)).toEqual(
      people.map((person) => person.id),
    );
    expect(body.results.map((result: any) => result.items[0].display_name)).toEqual(
      people.map((_, offset) => `Example Person ${10 + offset}`),
    );
  });

  it('lists the user id and display name of each member of a DM link', async () => {
    const { slack, ctx } = harness({
      routes: {
        'conversations.members': constantRoute({ members: [USER_ME, USER_PARTNER] }),
        'conversations.info': conversationsInfoRoute({ [DM_ONE]: directChannel(DM_ONE, USER_PARTNER) }),
        'users.info': usersInfoRoute([ME, PARTNER]),
      },
      directory: [ME, PARTNER],
    });

    const body = parseResult(
      await slackGetUsersHandler(ctx)({ users: [{ members_of: channelLink(EXAMPLE_TEAM, DM_ONE) }] }),
    );

    expect(slack.callsTo('conversations.members')[0].params.channel).toBe(DM_ONE);
    expect(body.results[0].status).toBe('ok');
    expect(body.results[0].items).toMatchObject([
      { user_id: USER_ME, display_name: 'Example Me' },
      { user_id: USER_PARTNER, display_name: 'Example Partner' },
    ]);
  });

  it('gives each user the address when asked for email, or null marked not_set, with the entry ok', async () => {
    const withAddress = rawUser({
      id: USER_ME,
      displayName: 'Example Me',
      email: EMAIL_SENTINEL_ADDRESS,
    });
    const withoutAddress = rawUser({ id: USER_PARTNER, displayName: 'Example Partner' });
    const { ctx } = harness({
      routes: { 'users.info': usersInfoRoute([withAddress, withoutAddress]) },
      directory: [withAddress, withoutAddress],
    });

    const body = parseResult(
      await slackGetUsersHandler(ctx)({
        users: [{ user: USER_ME }, { user: USER_PARTNER }],
        fields: ['email'],
      }),
    );

    expect(body.results.map((result: any) => result.status)).toEqual(['ok', 'ok']);
    expect(body.results[0].items[0].email).toBe(EMAIL_SENTINEL_ADDRESS);
    expect(body.results[0].items[0]).not.toHaveProperty('email_unavailable');
    expect(body.results[1].items[0].email).toBeNull();
    expect(body.results[1].items[0].email_unavailable).toBe('not_set');
  });

  it('gives email null marked scope_missing when the token was not granted the email scope, with the entry ok', async () => {
    seedToken({ scopes: ALL_SCOPES.filter((scope) => scope !== 'users:read.email') });
    const { ctx } = harness({
      routes: { 'users.info': usersInfoRoute([ME]) },
      directory: [ME],
    });

    const body = parseResult(
      await slackGetUsersHandler(ctx)({ users: [{ user: USER_ME }], fields: ['email'] }),
    );

    expect(body.results[0].status).toBe('ok');
    expect(body.results[0].items[0].email).toBeNull();
    expect(body.results[0].items[0].email_unavailable).toBe('scope_missing');
  });

  it('rejects the phone field as invalid params before any upstream call', async () => {
    const { slack, ctx } = harness({
      routes: { 'users.info': usersInfoRoute([ME]) },
      directory: [ME],
    });

    await expectInvalidParams(() =>
      slackGetUsersHandler(ctx)({ users: [{ user: USER_ME }], fields: ['phone'] }),
    );

    expect(slack.calls).toHaveLength(0);
    expect(slack.client.getUserDirectory).not.toHaveBeenCalled();
  });
});

const BATCH_CONCURRENCY = 4;
const UPSTREAM_CALL_BUDGET = 50;
const USER_ID_BATCH_CAP = 100;
const OTHER_USER_ITEM_CAP = 20;
const CHANNEL_NAME_BATCH_SIZE = 20;

function statusCounts(results: Array<{ status: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { status } of results) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}

function userIdBatch(count: number): { people: RawUser[]; ids: string[] } {
  const people = Array.from({ length: count }, (_, offset) =>
    rawUser({ id: personId(offset), displayName: `Example Person ${offset}` }),
  );
  return { people, ids: people.map((person) => person.id) };
}

describe('slack_get_users: a batch of user ids is bounded by upstream calls, not by items', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  it.each([60, USER_ID_BATCH_CAP])(
    'serves %i user ids from one directory fetch, every item ok and none left not_attempted',
    async (count) => {
      const { people, ids } = userIdBatch(count);
      const { slack, ctx } = harness({ directory: people });

      const body = parseResult(await slackGetUsersHandler(ctx)({ users: ids.map((user) => ({ user })) }));

      expect(statusCounts(body.results)).toEqual({ ok: count });
      expect(body.results.map((result: any) => result.items[0].user_id)).toEqual(ids);
      expect(slack.client.getUserDirectory).toHaveBeenCalledTimes(1);
      expect(slack.calls).toHaveLength(0);
    },
  );

  it('rejects one id over the cap with batch_too_large before any upstream call', async () => {
    const { people, ids } = userIdBatch(USER_ID_BATCH_CAP + 1);
    const { slack, ctx } = harness({ directory: people });

    await expectSlackError(
      () => slackGetUsersHandler(ctx)({ users: ids.map((user) => ({ user })) }),
      'batch_too_large',
    );

    expect(slack.calls).toHaveLength(0);
    expect(slack.client.getUserDirectory).not.toHaveBeenCalled();
  });

  it('resumes more than twenty not_attempted user ids by cursor alone, without the twenty-item cap', async () => {
    const { people, ids } = userIdBatch(USER_ID_BATCH_CAP);
    const { slack, ctx } = harness({ directory: people });
    slack.client.getUserDirectory.mockRejectedValueOnce(slackFailure('rate_limited', { retry_after_s: 7 }));
    const handler = slackGetUsersHandler(ctx);

    const first = parseResult(await handler({ users: ids.map((user) => ({ user })) }));
    const pending = first.results.filter((result: any) => result.status === 'not_attempted');
    expect(pending.length).toBeGreaterThan(OTHER_USER_ITEM_CAP);
    for (const entry of pending) expect(typeof entry.nextPageToken).toBe('string');

    const resumed = parseResult(await handler({ users: pending.map((entry: any) => ({ cursor: entry.nextPageToken })) }));

    expect(statusCounts(resumed.results)).toEqual({ ok: pending.length });
    expect(resumed.results.map((result: any) => result.items[0].user_id)).toEqual(
      pending.map((entry: any) => ids[entry.index]),
    );
  });
});

describe('slack_get_channels: the call budget counts real upstream calls', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  it('stops starting names once fifty upstream calls are spent and hands every unstarted name a resume cursor', async () => {
    const names = Array.from({ length: CHANNEL_NAME_BATCH_SIZE }, (_, index) => budgetRoomName(index));
    const { slack, ctx } = harness({ routes: nameFallbackRoutes(CHANNEL_NAME_BATCH_SIZE) });
    const handler = slackGetChannelsHandler(ctx);

    const first = parseResult(await handler({ channels: names.map((name) => ({ name })) }));
    const upstreamCallsOfFirst = slack.calls.length;

    const statuses = first.results.map((result: any) => result.status);
    expect(statuses).toContain('ok');
    expect(statuses).toContain('not_attempted');
    for (const entry of first.results.filter((result: any) => result.status === 'not_attempted')) {
      expect(entry.hasMore).toBe(true);
      expect(typeof entry.nextPageToken).toBe('string');
    }
    expect(upstreamCallsOfFirst).toBeGreaterThanOrEqual(UPSTREAM_CALL_BUDGET);
    expect(upstreamCallsOfFirst).toBeLessThanOrEqual(
      UPSTREAM_CALL_BUDGET + BATCH_CONCURRENCY * UPSTREAM_CALLS_PER_NAME,
    );

    const pending = first.results.filter((result: any) => result.status === 'not_attempted');
    const resumed = parseResult(
      await handler({ channels: pending.map((entry: any) => ({ cursor: entry.nextPageToken })) }),
    );

    expect(resumed.results[0].status).toBe('ok');
    expect(resumed.results[0].items.map((item: any) => item.channel_id)).toEqual(
      budgetRoomIds(pending[0].index),
    );
    expect(resumed.results[0].items).toHaveLength(MATCHES_PER_NAME);
  });
});

describe('slack_get_users: a cursor belongs to the target it was issued for', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  const COHORT = [0, 1, 2].map((offset) =>
    rawUser({ id: personId(offset), displayName: `Example Cohort ${offset}` }),
  );

  async function firstQueryPage() {
    const { ctx } = harness({ routes: { 'users.info': usersInfoRoute(COHORT) }, directory: COHORT });
    const handler = slackGetUsersHandler(ctx);
    const first = parseResult(await handler({ users: [{ query: 'example cohort' }], limit: 1 }));
    expect(first.results[0].items.map((item: any) => item.user_id)).toEqual([COHORT[0].id]);
    expect(first.results[0].hasMore).toBe(true);
    return { handler, cursor: first.results[0].nextPageToken as string };
  }

  it('fails an item that names another user but carries a cursor issued for a query, and still serves the rest', async () => {
    const { handler, cursor } = await firstQueryPage();

    const body = parseResult(
      await handler({
        users: [{ user: COHORT[2].id, cursor, ref: 'mismatch' }, { user: COHORT[1].id, ref: 'plain' }],
        limit: 1,
      }),
    );

    expect(body.results[0].ref).toBe('mismatch');
    expect(body.results[0].status).toBe('error');
    expect(body.results[0].error.code).toBe('invalid_cursor');
    expect(body.results[0].items).toBeUndefined();
    expect(body.results[1].status).toBe('ok');
    expect(body.results[1].items[0].user_id).toBe(COHORT[1].id);
  });

  it('continues the same query with its own cursor', async () => {
    const { handler, cursor } = await firstQueryPage();

    const body = parseResult(await handler({ users: [{ query: 'example cohort', cursor }], limit: 1 }));

    expect(body.results[0].status).toBe('ok');
    expect(body.results[0].items.map((item: any) => item.user_id)).toEqual([COHORT[1].id]);
  });
});
