// The home sandbox must stay the first import so that nothing resolves the real home.
import { removeSandbox, resetSandbox, seedToken } from './__fixtures__/tools/home-sandbox.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClock } from './__fixtures__/tools/clock.js';
import { createToolContext } from './__fixtures__/tools/context.js';
import { parseResult } from './__fixtures__/tools/assertions.js';
import {
  createFakeSlack,
  rawSearchMatch,
  slackFailure,
  type Route,
} from './__fixtures__/tools/fake-slack.js';
import { CHANNEL_ONE, CHANNEL_TWO, EXAMPLE_TEAM, USER_PARTNER, channelLink, tsFor } from './__fixtures__/tools/ids.js';
import {
  FIRST_PAGE_OFFSETS,
  LATE_POST_OFFSET,
  SECOND_PAGE_OFFSETS,
  cursorNamesItsQuerySearchRoute,
  upstreamCursorFor,
} from './__fixtures__/tools/fix2-search-routes.js';
import { slackSearchMessagesHandler } from './read-tools.js';

const PAGE_ONE_EPOCH_SECONDS = 1_700_000_500;

function clockAtPageOne() {
  return createClock(new Date(PAGE_ONE_EPOCH_SECONDS * 1000).toISOString());
}

function matchesOf(...timestamps: string[]) {
  return timestamps.map((ts) => rawSearchMatch({ ts, channelId: CHANNEL_ONE }));
}

describe('slack_search_messages', () => {
  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  it('returns one result per query, each with its own cursor', async () => {
    const searchRoute: Route = (params) => {
      const query = String(params.query);
      if (query.includes('alpha')) {
        return {
          messages: { total: 9, matches: matchesOf(tsFor(30), tsFor(20)) },
          response_metadata: { next_cursor: 'CURSOR-MARK-ALPHA-NEXT' },
        };
      }
      if (query.includes('beta')) {
        return {
          messages: { total: 7, matches: matchesOf(tsFor(25), tsFor(15)) },
          response_metadata: { next_cursor: 'CURSOR-MARK-BETA-NEXT' },
        };
      }
      throw slackFailure('slack_error', { slack_code: 'fixture_unexpected_query' });
    };
    const slack = createFakeSlack({ routes: { 'search.messages': searchRoute } });
    const handler = slackSearchMessagesHandler(createToolContext({ slack, clock: clockAtPageOne() }));

    const body = parseResult(
      await handler({ queries: [{ query: 'alpha', ref: 'first' }, { query: 'beta', ref: 'second' }] }),
    );

    expect(body.results).toHaveLength(2);
    expect(body.results.map((result: any) => [result.index, result.ref, result.status])).toEqual([
      [0, 'first', 'ok'],
      [1, 'second', 'ok'],
    ]);
    expect(body.results[0].items.map((entry: any) => entry.ts)).toEqual([tsFor(30), tsFor(20)]);
    expect(body.results[1].items.map((entry: any) => entry.ts)).toEqual([tsFor(25), tsFor(15)]);
    expect(body.results.map((result: any) => result.hasMore)).toEqual([true, true]);
    const [alphaToken, betaToken] = body.results.map((result: any) => result.nextPageToken);
    expect(typeof alphaToken).toBe('string');
    expect(typeof betaToken).toBe('string');
    expect(alphaToken.length).toBeGreaterThan(0);
    expect(betaToken.length).toBeGreaterThan(0);
    expect(alphaToken).not.toBe(betaToken);
    expect(slack.callsTo('search.messages').map((recorded) => recorded.params.cursor)).toEqual(['*', '*']);
  });

  it('quotes exact phrases and turns an id and a link in in_channels into in: modifiers', async () => {
    const slack = createFakeSlack({
      routes: { 'search.messages': () => ({ messages: { total: 0, matches: [] }, response_metadata: {} }) },
    });
    const handler = slackSearchMessagesHandler(createToolContext({ slack, clock: clockAtPageOne() }));

    const body = parseResult(
      await handler({
        queries: [
          {
            exact_phrases: ['launch plan'],
            in_channels: [CHANNEL_ONE, channelLink(EXAMPLE_TEAM, CHANNEL_TWO)],
          },
        ],
      }),
    );

    expect(body.results[0].status).toBe('ok');
    const searchCalls = slack.callsTo('search.messages');
    expect(searchCalls).toHaveLength(1);
    const query = String(searchCalls[0].params.query);
    expect(query).toContain('"launch plan"');
    expect(query).toContain('in:<#C0EXAMPLE01>');
    expect(query).toContain('in:<#C0EXAMPLE02>');
  });

  it('does not repeat a message when a post arrives between page one and page two', async () => {
    const clock = clockAtPageOne();
    const newPostTs = tsFor(560);
    const searchRoute: Route = (params) => {
      if (params.cursor === '*') {
        return {
          messages: { total: 4, matches: matchesOf(tsFor(400), tsFor(300)) },
          response_metadata: { next_cursor: 'CURSOR-MARK-PAGE-TWO' },
        };
      }
      if (params.cursor === 'CURSOR-MARK-PAGE-TWO') {
        return {
          messages: { total: 5, matches: matchesOf(newPostTs, tsFor(200), tsFor(100)) },
          response_metadata: {},
        };
      }
      throw slackFailure('slack_error', { slack_code: 'fixture_unexpected_cursor' });
    };
    const slack = createFakeSlack({ routes: { 'search.messages': searchRoute } });
    const handler = slackSearchMessagesHandler(createToolContext({ slack, clock }));

    const pageOne = parseResult(await handler({ queries: [{ query: 'roadmap' }] }));
    clock.advance(60_000);
    const pageTwo = parseResult(
      await handler({ queries: [{ cursor: pageOne.results[0].nextPageToken }] }),
    );

    const pageOneTimestamps = pageOne.results[0].items.map((entry: any) => entry.ts);
    const pageTwoTimestamps = pageTwo.results[0].items.map((entry: any) => entry.ts);
    expect(pageOneTimestamps).toEqual([tsFor(400), tsFor(300)]);
    expect(pageTwoTimestamps).toEqual([tsFor(200), tsFor(100)]);
    expect(pageTwoTimestamps).not.toContain(newPostTs);
    expect(slack.callsTo('search.messages').map((recorded) => recorded.params.cursor)).toEqual([
      '*',
      'CURSOR-MARK-PAGE-TWO',
    ]);
  });

  it('reports hasMore false and no next cursor on the last page', async () => {
    const searchRoute: Route = (params) =>
      params.cursor === '*'
        ? {
            messages: { total: 3, matches: matchesOf(tsFor(90), tsFor(80)) },
            response_metadata: { next_cursor: 'CURSOR-MARK-LAST' },
          }
        : { messages: { total: 3, matches: matchesOf(tsFor(70)) }, response_metadata: {} };
    const slack = createFakeSlack({ routes: { 'search.messages': searchRoute } });
    const handler = slackSearchMessagesHandler(createToolContext({ slack, clock: clockAtPageOne() }));

    const pageOne = parseResult(await handler({ queries: [{ query: 'retro' }] }));
    const lastPage = parseResult(
      await handler({ queries: [{ cursor: pageOne.results[0].nextPageToken }] }),
    );

    expect(pageOne.results[0].hasMore).toBe(true);
    expect(lastPage.results[0].status).toBe('ok');
    expect(lastPage.results[0].items.map((entry: any) => entry.ts)).toEqual([tsFor(70)]);
    expect(lastPage.results[0].hasMore).toBe(false);
    expect(lastPage.results[0].nextPageToken).toBeUndefined();
  });
});

describe('slack_search_messages: a cursor belongs to the search it was issued for', () => {
  const firstPageTimestamps = FIRST_PAGE_OFFSETS.map(tsFor);
  const secondPageTimestamps = SECOND_PAGE_OFFSETS.map(tsFor);

  beforeEach(() => {
    resetSandbox();
    seedToken();
  });

  afterAll(() => {
    removeSandbox();
  });

  function searchSlack() {
    return createFakeSlack({ routes: { 'search.messages': cursorNamesItsQuerySearchRoute() } });
  }

  async function cursorIssuedFor(
    handler: ReturnType<typeof slackSearchMessagesHandler>,
    item: Record<string, unknown>,
  ) {
    const pageOne = parseResult(await handler({ queries: [item] } as any));
    expect(pageOne.results[0].status).toBe('ok');
    expect(pageOne.results[0].items.map((entry: any) => entry.ts)).toEqual(firstPageTimestamps);
    expect(pageOne.results[0].hasMore).toBe(true);
    return pageOne.results[0].nextPageToken as string;
  }

  it.each([
    ['a different query', { query: 'alpha' }, { query: 'beta' }],
    ['a different channel scope', { query: 'alpha', in_channels: [CHANNEL_ONE] }, { query: 'alpha', in_channels: [CHANNEL_TWO] }],
    ['a channel scope it was not issued with', { query: 'alpha' }, { query: 'alpha', in_channels: [CHANNEL_ONE] }],
    ['a sender filter it was not issued with', { query: 'alpha' }, { query: 'alpha', from_users: [USER_PARTNER] }],
    ['the top-level-only filter it was not issued with', { query: 'alpha' }, { query: 'alpha', top_level_only: true }],
  ])(
    'fails only the item that carries a cursor issued for %s, with no upstream search for it',
    async (_label, issuedFor, carriedBy) => {
      const slack = searchSlack();
      const handler = slackSearchMessagesHandler(createToolContext({ slack, clock: clockAtPageOne() }));
      const cursorIssuedForOther = await cursorIssuedFor(handler, issuedFor);
      const callsBefore = slack.calls.length;

      const body = parseResult(
        await handler({
          queries: [{ ...carriedBy, cursor: cursorIssuedForOther, ref: 'mismatch' }, { query: 'gamma', ref: 'plain' }],
        } as any),
      );

      expect(body.results[0].ref).toBe('mismatch');
      expect(body.results[0].status).toBe('error');
      expect(body.results[0].error.code).toBe('invalid_cursor');
      expect(body.results[0].items).toBeUndefined();
      expect(body.results[1].ref).toBe('plain');
      expect(body.results[1].status).toBe('ok');
      expect(body.results[1].items.map((entry: any) => entry.ts)).toEqual(firstPageTimestamps);
      const returnedTimestamps = body.results.flatMap((result: any) => (result.items ?? []).map((entry: any) => entry.ts));
      for (const ts of secondPageTimestamps) expect(returnedTimestamps).not.toContain(ts);
      const callsAfter = slack.calls.slice(callsBefore);
      expect(callsAfter.map((recorded) => [recorded.method, recorded.params.cursor])).toEqual([['search.messages', '*']]);
      expect(String(callsAfter[0].params.query)).toBe('gamma');
    },
  );

  it('continues an item that names its own query and filters with the cursor issued for them, under the frozen upper bound', async () => {
    const clock = clockAtPageOne();
    const slack = searchSlack();
    const handler = slackSearchMessagesHandler(createToolContext({ slack, clock }));
    const item = { query: 'alpha', in_channels: [CHANNEL_ONE] };
    const cursorForItem = await cursorIssuedFor(handler, { ...item, ref: 'first' });
    clock.advance(60_000);

    const body = parseResult(await handler({ queries: [{ ...item, cursor: cursorForItem, ref: 'again' }] } as any));

    expect(body.results[0].ref).toBe('again');
    expect(body.results[0].status).toBe('ok');
    expect(body.results[0].items.map((entry: any) => entry.ts)).toEqual(secondPageTimestamps);
    expect(body.results[0].items.map((entry: any) => entry.ts)).not.toContain(tsFor(LATE_POST_OFFSET));
    expect(body.results[0].hasMore).toBe(false);
    const [pageOneCall, pageTwoCall] = slack.callsTo('search.messages');
    expect(String(pageOneCall.params.query)).toBe(`alpha in:<#${CHANNEL_ONE}>`);
    expect(pageTwoCall.params.cursor).toBe(upstreamCursorFor(String(pageOneCall.params.query)));
    expect(pageTwoCall.params.query).toBe(pageOneCall.params.query);
  });
});
