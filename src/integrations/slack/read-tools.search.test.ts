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

  it('returns default file metadata and hasAttachments for search independently of requested fields', async () => {
    const matches = [
      { ...rawSearchMatch({ ts: tsFor(400), channelId: CHANNEL_ONE, text: 'EXAMPLE-search-message' }), files: [
        { id: 'F0EXAMPLE01', name: 'EXAMPLE-notes.txt', size: 0, mimetype: 'text/plain' },
        { id: 'F0EXAMPLE02' },
      ] },
      rawSearchMatch({ ts: tsFor(300), channelId: CHANNEL_ONE, text: 'EXAMPLE-search-message' }),
    ];
    for (const fields of [undefined, [], ['text']]) {
      const slack = createFakeSlack({ routes: { 'search.messages': () => ({ messages: { total: 2, matches } }) } });
      const handler = slackSearchMessagesHandler(createToolContext({ slack, clock: clockAtPageOne() }));
      const body = parseResult(await handler({ queries: [{ query: 'EXAMPLE-attachments' }], fields }));
      expect(body.results[0].status).toBe('ok');
      const items = body.results[0].items;
      expect(items.map((item: any) => item.ts)).toEqual([tsFor(400), tsFor(300)]);
      expect(items.map((item: any) => item.hasAttachments)).toEqual([true, false]);
      expect(items[0].attachments).toEqual([
        { file_id: 'F0EXAMPLE01', name: 'EXAMPLE-notes.txt', size: 0, type: 'text/plain' },
        { file_id: 'F0EXAMPLE02' },
      ]);
      expect(items[1]).not.toHaveProperty('attachments');
      for (const item of items) {
        if (fields?.includes('text')) expect(item.text).toBe('EXAMPLE-search-message');
        else expect(item).not.toHaveProperty('text');
        for (const key of ['files', 'author_name', 'channel_name', 'email', 'mrkdwn']) expect(item).not.toHaveProperty(key);
      }
      expect(slack.calls.map((call) => call.method)).toEqual(['search.messages']);
      expect(slack.client.getUserDirectory).not.toHaveBeenCalled();
    }
  });

  it('returns false without files including unfurl-only search messages and preserves previous data', async () => {
    const extras = [{}, { files: [] }, { attachments: [{ title: 'EXAMPLE-unfurl', text: 'EXAMPLE-preview' }] }];
    const matches = extras.map((extra, index) => ({
      ...rawSearchMatch({ ts: tsFor(400 - index), channelId: CHANNEL_ONE }), ...extra,
    }));
    const slack = createFakeSlack({ routes: { 'search.messages': () => ({ messages: { total: 3, matches } }) } });
    const handler = slackSearchMessagesHandler(createToolContext({ slack, clock: clockAtPageOne() }));
    const body = parseResult(await handler({ queries: [{ query: 'EXAMPLE-unfurls' }] }));
    expect(body.results[0].status).toBe('ok');
    const items = body.results[0].items;
    expect(items.map((item: any) => item.ts)).toEqual([tsFor(400), tsFor(399), tsFor(398)]);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual([
        'at', 'author_id', 'channel_id', 'hasAttachments', 'is_bot', 'is_top_level',
        'permalink', 'reply_count', 'thread_ts', 'ts',
      ].sort());
      expect(item).toMatchObject({
        channel_id: 'C0EXAMPLE01', author_id: 'U0EXAMPLE01', reply_count: 0,
        is_top_level: true, is_bot: false, hasAttachments: false, at: ({
          '1700000400.000100': '2023-11-14T22:20:00.000Z',
          '1700000399.000100': '2023-11-14T22:19:59.000Z',
          '1700000398.000100': '2023-11-14T22:19:58.000Z',
        } as Record<string, string>)[item.ts],
      });
    }
    expect(slack.calls.map((call) => call.method)).toEqual(['search.messages']);
  });

  it('keeps sparse metadata and file presence separate from usable IDs in search results', async () => {
    const extras = [
      { files: [null, [], 1, { id: 'F0EXAMPLE01', name: 1, size: -1, mimetype: false }, { id: 'F0EXAMPLE02', size: 0 }] },
      { files: [{}, { id: 'not-a-file' }] },
      { files: null },
      { files: 'EXAMPLE-not-a-list' },
      { files: [null, [], 1, false] },
      {},
    ];
    const matches = extras.map((extra, index) => ({
      ...rawSearchMatch({ ts: tsFor(400 - index), channelId: CHANNEL_ONE }), ...extra,
    }));
    const slack = createFakeSlack({ routes: { 'search.messages': () => ({ messages: { total: 6, matches } }) } });
    const handler = slackSearchMessagesHandler(createToolContext({ slack, clock: clockAtPageOne() }));
    const body = parseResult(await handler({ queries: [{ query: 'EXAMPLE-sparse' }] }));
    expect(body.results[0].status).toBe('ok');
    const items = body.results[0].items;
    expect(items.map((item: any) => item.ts)).toEqual([tsFor(400), tsFor(399), tsFor(398), tsFor(397), tsFor(396), tsFor(395)]);
    expect(items.map((item: any) => item.hasAttachments)).toEqual([true, true, false, false, false, false]);
    expect(items[0].attachments).toEqual([{ file_id: 'F0EXAMPLE01' }, { file_id: 'F0EXAMPLE02', size: 0 }]);
    for (const item of items.slice(1)) expect(item).not.toHaveProperty('attachments');
    for (const item of items) {
      expect(item).not.toHaveProperty('files');
      expect(item).not.toHaveProperty('text');
    }
    expect(slack.calls.map((call) => call.method)).toEqual(['search.messages']);
  });

  it('preserves attachment metadata and flags on search continuation', async () => {
    const slack = createFakeSlack({ routes: { 'search.messages': (params) => params.cursor === '*'
      ? {
          messages: { total: 4, matches: [
            { ...rawSearchMatch({ ts: tsFor(400), channelId: CHANNEL_ONE }), files: [
              { id: 'F0EXAMPLE01', name: 'EXAMPLE-notes.txt', size: 0, mimetype: 'text/plain' }, { id: 'F0EXAMPLE02' },
            ] },
            rawSearchMatch({ ts: tsFor(300), channelId: CHANNEL_ONE }),
          ] },
          response_metadata: { next_cursor: 'EXAMPLE-ATTACHMENTS-NEXT' },
        }
      : {
          messages: { total: 4, matches: [
            { ...rawSearchMatch({ ts: tsFor(200), channelId: CHANNEL_ONE }), files: [{ id: 'F0EXAMPLE03', size: 12 }] },
            rawSearchMatch({ ts: tsFor(100), channelId: CHANNEL_ONE }),
          ] },
          response_metadata: {},
        },
    } });
    const handler = slackSearchMessagesHandler(createToolContext({ slack, clock: clockAtPageOne() }));
    const first = parseResult(await handler({ queries: [{ query: 'EXAMPLE-pages' }], limit: 2 }));
    expect(first.results[0].status).toBe('ok');
    expect(first.results[0].hasMore).toBe(true);
    expect(typeof first.results[0].nextPageToken).toBe('string');
    const second = parseResult(await handler({ queries: [{ cursor: first.results[0].nextPageToken }], limit: 2 }));
    expect(second.results[0].status).toBe('ok');
    expect(second.results[0].hasMore).toBe(false);
    expect(second.results[0].nextPageToken).toBeUndefined();
    expect(first.truncated).toBe(false);
    expect(second.truncated).toBe(false);
    const items = [...first.results[0].items, ...second.results[0].items];
    expect(items.map((item: any) => item.ts)).toEqual([tsFor(400), tsFor(300), tsFor(200), tsFor(100)]);
    expect(items.map((item: any) => item.hasAttachments)).toEqual([true, false, true, false]);
    expect(items[0].attachments).toEqual([
      { file_id: 'F0EXAMPLE01', name: 'EXAMPLE-notes.txt', size: 0, type: 'text/plain' }, { file_id: 'F0EXAMPLE02' },
    ]);
    expect(items[2].attachments).toEqual([{ file_id: 'F0EXAMPLE03', size: 12 }]);
    for (const item of [items[1], items[3]]) expect(item).not.toHaveProperty('attachments');
    for (const item of items) expect(item).not.toHaveProperty('text');
    expect(slack.calls.map((call) => [call.method, call.params.cursor])).toEqual([
      ['search.messages', '*'], ['search.messages', 'EXAMPLE-ATTACHMENTS-NEXT'],
    ]);
    expect(slack.calls[1].params.query).toBe(slack.calls[0].params.query);
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
