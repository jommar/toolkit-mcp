import fs from 'node:fs';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', async () => (await import('./__fixtures__/axios-harness.js')).createAxiosModuleMock());

import { SlackClient, type SlackArguments } from './slack-client.js';
import {
  axiosHarness,
  forbidFetch,
  slackFailure,
  slackOk,
  type HarnessReply,
} from './__fixtures__/axios-harness.js';
import { createTempHome, writeTokenFile, type TempHome } from './__fixtures__/temp-home.js';
import { settle } from './__fixtures__/settle.js';
import { recordDefaultAxiosRequestConfigs } from './__fixtures__/fix1-request-configs.js';
import { settleWithRetryClock, useRealAxiosInstances } from './__fixtures__/fix1-retry-axios.js';
import {
  CAPTURED_COOKIE_SENTINEL,
  CAPTURED_TOKEN_SENTINEL,
  CHANNEL_ID,
  EXAMPLE_TEAM,
  FILE_ID,
  ROOT_TS,
  TOKEN_SENTINEL,
  tokenRecord,
  USER_ID,
} from './__fixtures__/synthetic.js';

const UPLOAD_URL = 'https://example-team.slack.com/upload/EXAMPLE-UPLOAD-ID';

const SLACK_API_CALLS: Array<[string, string, (client: SlackClient) => Promise<unknown>]> = [
  ['authTest', 'auth.test', (client) => client.authTest()],
  ['authRevoke', 'auth.revoke', (client) => client.authRevoke()],
  ['conversationsInfo', 'conversations.info', (client) => client.conversationsInfo({ channel: CHANNEL_ID })],
  [
    'conversationsHistory',
    'conversations.history',
    (client) => client.conversationsHistory({ channel: CHANNEL_ID, limit: 20 }),
  ],
  [
    'conversationsReplies',
    'conversations.replies',
    (client) => client.conversationsReplies({ channel: CHANNEL_ID, ts: ROOT_TS }),
  ],
  [
    'conversationsList',
    'conversations.list',
    (client) => client.conversationsList({ types: 'public_channel', limit: 20 }),
  ],
  [
    'conversationsMembers',
    'conversations.members',
    (client) => client.conversationsMembers({ channel: CHANNEL_ID, limit: 20 }),
  ],
  [
    'usersConversations',
    'users.conversations',
    (client) => client.usersConversations({ types: 'public_channel', limit: 20 }),
  ],
  ['usersInfo', 'users.info', (client) => client.usersInfo({ user: USER_ID })],
  ['searchMessages', 'search.messages', (client) => client.searchMessages({ query: 'fixture', cursor: '*', count: 20 })],
  ['postMessage', 'chat.postMessage', (client) => client.postMessage({ channel: CHANNEL_ID, text: 'hello' })],
  [
    'addReaction',
    'reactions.add',
    (client) => client.addReaction({ channel: CHANNEL_ID, timestamp: ROOT_TS, name: 'eyes' }),
  ],
  [
    'getUploadUrl',
    'files.getUploadURLExternal',
    (client) => client.getUploadUrl({ filename: 'notes.txt', length: 11 }),
  ],
  [
    'completeUpload',
    'files.completeUploadExternal',
    (client) => client.completeUpload({ files: [{ id: FILE_ID, title: 'notes' }], channel_id: CHANNEL_ID }),
  ],
  ['getUserDirectory', 'users.list', (client) => client.getUserDirectory()],
];

const REFUSED_UPLOAD_URLS: Array<[label: string, uploadUrl: string]> = [
  ['a plain http URL on a Slack host', 'http://example-team.slack.com/upload/EXAMPLE-UPLOAD-ID'],
  ['a non-web scheme on a Slack host', 'ftp://example-team.slack.com/upload/EXAMPLE-UPLOAD-ID'],
  ['a host outside slack.com', 'https://upload.example.invalid/upload/EXAMPLE-UPLOAD-ID'],
  [
    'a Slack host name used as the front of another domain',
    'https://example-team.slack.com.example.invalid/upload/EXAMPLE-UPLOAD-ID',
  ],
  ['a domain that only ends in the letters slack.com', 'https://exampleslack.com/upload/EXAMPLE-UPLOAD-ID'],
  [
    'a Slack host name placed in the credentials part',
    'https://example-team.slack.com@upload.example.invalid/upload/EXAMPLE-UPLOAD-ID',
  ],
  ['a text that is not a URL', 'not-a-url'],
];

const NO_ANSWER_CODES = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET'];

const WRITES_THAT_MUST_NOT_REPEAT: Array<[string, string, (client: SlackClient) => Promise<unknown>]> = [
  ['postMessage', 'chat.postMessage', (client) => client.postMessage({ channel: CHANNEL_ID, text: 'hello' })],
  [
    'completeUpload',
    'files.completeUploadExternal',
    (client) => client.completeUpload({ files: [{ id: FILE_ID, title: 'notes' }], channel_id: CHANNEL_ID }),
  ],
];

const RETRIED_READ_FAILURES: Array<[label: string, firstReply: HarnessReply]> = [
  ['a 429 with a Retry-After of 1', { status: 429, headers: { 'retry-after': '1' }, data: { ok: false, error: 'ratelimited' } }],
  ['a 403', { status: 403, data: { ok: false, error: 'forbidden' } }],
  ['a 500', { status: 500, data: { ok: false, error: 'fatal_error' } }],
];

const PAGE_CURSOR = 'CURSOR-FIXTURE';
const NEXT_PAGE_CURSOR = 'NEXT-CURSOR-FIXTURE';
const ROOM_NAME = 'fixture-room';

type PagedRead = [
  name: string,
  slackMethod: string,
  params: SlackArguments,
  replyBody: Record<string, unknown>,
  invoke: (client: SlackClient, params: SlackArguments) => Promise<unknown>,
];

const PAGED_READS: PagedRead[] = [
  [
    'conversationsList',
    'conversations.list',
    { types: 'public_channel,private_channel', exclude_archived: true, limit: 50, cursor: PAGE_CURSOR },
    {
      channels: [{ id: CHANNEL_ID, name: ROOM_NAME }],
      response_metadata: { next_cursor: NEXT_PAGE_CURSOR },
    },
    (client, params) => client.conversationsList(params),
  ],
  [
    'conversationsMembers',
    'conversations.members',
    { channel: CHANNEL_ID, limit: 50, cursor: PAGE_CURSOR },
    { members: [USER_ID], response_metadata: { next_cursor: NEXT_PAGE_CURSOR } },
    (client, params) => client.conversationsMembers(params),
  ],
  [
    'usersConversations',
    'users.conversations',
    { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 50, cursor: PAGE_CURSOR },
    {
      channels: [{ id: CHANNEL_ID, name: ROOM_NAME }],
      response_metadata: { next_cursor: NEXT_PAGE_CURSOR },
    },
    (client, params) => client.usersConversations(params),
  ],
];

const FAILURE_REPLIES: Array<[label: string, reply: HarnessReply, errorCode: string]> = [
  ['a rejected token', slackFailure('token_revoked'), 'session_rejected'],
  [
    'a rate limit',
    { status: 429, headers: { 'Retry-After': '11' }, data: { ok: false, error: 'ratelimited' } },
    'rate_limited',
  ],
  ['a network failure', { networkError: 'ECONNRESET' }, 'unreachable'],
  ['an ordinary Slack error', slackFailure('channel_not_found'), 'slack_error'],
];

function everythingPrintedAbout(error: unknown): string {
  return inspect(error, { depth: 10 });
}

const directoryPage = slackOk({
  members: [{ id: USER_ID, name: 'fixture-user' }],
  response_metadata: { next_cursor: '' },
});

function happyReplies() {
  axiosHarness.respondBySlackMethod({
    'auth.test': slackOk({ url: EXAMPLE_TEAM.team_url, team_id: EXAMPLE_TEAM.team_id, user_id: USER_ID }),
    'conversations.info': slackOk({ channel: { id: CHANNEL_ID } }),
    'conversations.history': slackOk({ messages: [], response_metadata: { next_cursor: '' } }),
    'conversations.replies': slackOk({ messages: [], response_metadata: { next_cursor: '' } }),
    'users.info': slackOk({ user: { id: USER_ID } }),
    'search.messages': slackOk({ messages: { matches: [], paging: { pages: 1 } } }),
    'chat.postMessage': slackOk({ channel: CHANNEL_ID, ts: ROOT_TS }),
    'files.getUploadURLExternal': slackOk({ upload_url: UPLOAD_URL, file_id: FILE_ID }),
    'files.completeUploadExternal': slackOk({ files: [{ id: FILE_ID }] }),
    'users.list': directoryPage,
  });
}

describe('SlackClient', () => {
  let temp: TempHome;

  beforeEach(() => {
    forbidFetch();
    axiosHarness.reset();
    temp = createTempHome();
    happyReplies();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    temp.cleanup();
  });

  describe('every method', () => {
    it.each(SLACK_API_CALLS)(
      '%s calls the official Web API host with a Bearer token and no cookie',
      async (_name, slackMethod, invoke) => {
        writeTokenFile(temp);
        const client = new SlackClient(temp.paths);

        await invoke(client);

        const requests = axiosHarness.requestsFor(slackMethod);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe(`https://slack.com/api/${slackMethod}`);
        expect(requests[0].headers.authorization).toBe(`Bearer ${TOKEN_SENTINEL}`);
        expect(Object.keys(requests[0].headers)).not.toContain('cookie');
      },
    );

    it('calls the web client host with the d cookie when the session was adopted', async () => {
      writeTokenFile(temp, tokenRecord({ access_token: CAPTURED_TOKEN_SENTINEL, cookie: CAPTURED_COOKIE_SENTINEL }));
      const client = new SlackClient(temp.paths);

      await client.authTest();

      const [request] = axiosHarness.requestsFor('auth.test');
      expect(request.url).toBe('https://app.slack.com/api/auth.test');
      expect(request.headers.authorization).toBe(`Bearer ${CAPTURED_TOKEN_SENTINEL}`);
      expect(request.headers.cookie).toBe(`d=${CAPTURED_COOKIE_SENTINEL}`);
    });

    it('returns Slack\'s response body for a successful call', async () => {
      writeTokenFile(temp);
      const client = new SlackClient(temp.paths);

      const result = await client.authTest();

      expect(result).toMatchObject({ team_id: EXAMPLE_TEAM.team_id, user_id: USER_ID });
    });

    it('installs the shared retry interceptor on the axios instance it creates', () => {
      writeTokenFile(temp);

      new SlackClient(temp.paths);

      const registered = axiosHarness.instances.some((instance) =>
        instance.interceptors.response.use.mock.calls.some(
          ([onFulfilled, onRejected]: unknown[]) => onFulfilled === undefined && typeof onRejected === 'function',
        ),
      );
      expect(registered).toBe(true);
    });
  });

  describe('without a token', () => {
    it.each(SLACK_API_CALLS)('%s fails not_connected and makes no request', async (_name, _slackMethod, invoke) => {
      const client = new SlackClient(temp.paths);

      const outcome = await settle(() => invoke(client));

      expect(outcome.threw).toBe(true);
      expect(outcome.error).toMatchObject({ code: 'not_connected' });
      expect(axiosHarness.requests).toHaveLength(0);
    });
  });

  describe('the workspace url', () => {
    it('is the team url of the stored token, read without calling Slack', async () => {
      writeTokenFile(temp);
      const client = new SlackClient(temp.paths);

      expect(await client.teamUrl()).toBe(EXAMPLE_TEAM.team_url);
      expect(axiosHarness.requests).toHaveLength(0);
    });

    it('fails not_connected when no token is stored', async () => {
      const client = new SlackClient(temp.paths);

      const outcome = await settle(() => client.teamUrl());

      expect(outcome.threw).toBe(true);
      expect(outcome.error).toMatchObject({ code: 'not_connected' });
    });
  });

  describe('a token Slack no longer accepts', () => {
    it.each(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'])(
      'maps %s to session_rejected carrying Slack\'s code and keeps the token file',
      async (slackCode) => {
        writeTokenFile(temp);
        const before = fs.readFileSync(temp.paths.tokenFile, 'utf8');
        axiosHarness.respond(() => slackFailure(slackCode));
        const client = new SlackClient(temp.paths);

        const outcome = await settle(() => client.conversationsInfo({ channel: CHANNEL_ID }));

        expect(outcome.threw).toBe(true);
        expect(outcome.error).toMatchObject({ code: 'session_rejected', slack_code: slackCode });
        expect(fs.readFileSync(temp.paths.tokenFile, 'utf8')).toBe(before);
      },
    );
  });

  describe('a rate limit that survives the retries', () => {
    it('maps a 429 with retry-after 7 to rate_limited with retry_after_s 7', async () => {
      writeTokenFile(temp);
      axiosHarness.respond(() => ({ status: 429, headers: { 'Retry-After': '7' }, data: { ok: false, error: 'ratelimited' } }));
      const client = new SlackClient(temp.paths);

      const outcome = await settle(() => client.conversationsHistory({ channel: CHANNEL_ID, limit: 20 }));

      expect(outcome.threw).toBe(true);
      expect(outcome.error).toMatchObject({ code: 'rate_limited', retry_after_s: 7 });
    });
  });

  describe('a network failure', () => {
    it('maps it to unreachable', async () => {
      writeTokenFile(temp);
      axiosHarness.respond(() => ({ networkError: 'ECONNRESET' }));
      const client = new SlackClient(temp.paths);

      const outcome = await settle(() => client.authTest());

      expect(outcome.threw).toBe(true);
      expect(outcome.error).toMatchObject({ code: 'unreachable' });
    });
  });

  describe('channel listing and membership reads', () => {
    describe.each(PAGED_READS)('%s', (_name, slackMethod, params, replyBody, invoke) => {
      it('sends a GET with no request body', async () => {
        writeTokenFile(temp);
        const client = new SlackClient(temp.paths);

        await invoke(client, params);

        const requests = axiosHarness.requestsFor(slackMethod);
        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe('get');
        expect(requests[0].body).toBeUndefined();
      });

      it('passes cursor, limit and its other parameters through as query parameters', async () => {
        writeTokenFile(temp);
        const client = new SlackClient(temp.paths);

        await invoke(client, params);

        expect(axiosHarness.requestsFor(slackMethod)[0].params).toEqual(params);
      });

      it('returns Slack\'s whole response body and fetches a single page', async () => {
        writeTokenFile(temp);
        axiosHarness.respondBySlackMethod({ [slackMethod]: slackOk(replyBody) });
        const client = new SlackClient(temp.paths);

        const result = await invoke(client, params);

        expect(result).toEqual({ ok: true, ...replyBody });
        expect(axiosHarness.requestsFor(slackMethod)).toHaveLength(1);
      });

      it('maps a token Slack no longer accepts to session_rejected and keeps the token file', async () => {
        writeTokenFile(temp);
        const before = fs.readFileSync(temp.paths.tokenFile, 'utf8');
        axiosHarness.respond(() => slackFailure('token_revoked'));
        const client = new SlackClient(temp.paths);

        const outcome = await settle(() => invoke(client, params));

        expect(outcome.threw).toBe(true);
        expect(outcome.error).toMatchObject({ code: 'session_rejected', slack_code: 'token_revoked' });
        expect(fs.readFileSync(temp.paths.tokenFile, 'utf8')).toBe(before);
      });

      it('maps a 429 with retry-after 11 to rate_limited with retry_after_s 11', async () => {
        writeTokenFile(temp);
        axiosHarness.respond(() => ({ status: 429, headers: { 'Retry-After': '11' }, data: { ok: false, error: 'ratelimited' } }));
        const client = new SlackClient(temp.paths);

        const outcome = await settle(() => invoke(client, params));

        expect(outcome.threw).toBe(true);
        expect(outcome.error).toMatchObject({ code: 'rate_limited', retry_after_s: 11 });
      });

      it('maps a network failure to unreachable', async () => {
        writeTokenFile(temp);
        axiosHarness.respond(() => ({ networkError: 'ECONNRESET' }));
        const client = new SlackClient(temp.paths);

        const outcome = await settle(() => invoke(client, params));

        expect(outcome.threw).toBe(true);
        expect(outcome.error).toMatchObject({ code: 'unreachable' });
      });

      it.each(FAILURE_REPLIES)('keeps the token out of the error for %s', async (_label, reply, errorCode) => {
        writeTokenFile(temp);
        axiosHarness.respond(() => reply);
        const client = new SlackClient(temp.paths);

        const outcome = await settle(() => invoke(client, params));

        expect(outcome.threw).toBe(true);
        expect(outcome.error).toMatchObject({ code: errorCode });
        expect(everythingPrintedAbout(outcome.error)).not.toContain(TOKEN_SENTINEL);
      });
    });
  });

  describe('the user directory', () => {
    it('is fetched once and served from cache for 10 minutes, then fetched again', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
      writeTokenFile(temp);
      const client = new SlackClient(temp.paths);

      const first = await client.getUserDirectory();
      const second = await client.getUserDirectory();
      expect(second).toEqual(first);
      expect(JSON.stringify(first)).toContain(USER_ID);
      expect(axiosHarness.requestsFor('users.list')).toHaveLength(1);

      vi.setSystemTime(new Date('2026-10-30T12:09:59.000Z'));
      await client.getUserDirectory();
      expect(axiosHarness.requestsFor('users.list')).toHaveLength(1);

      vi.setSystemTime(new Date('2026-10-30T12:10:01.000Z'));
      await client.getUserDirectory();
      expect(axiosHarness.requestsFor('users.list')).toHaveLength(2);
    });
  });

  describe('sending file bytes to the upload URL', () => {
    it('POSTs a stream body with Content-Length equal to the frozen size and no credentials', async () => {
      writeTokenFile(temp);
      const bytes = Buffer.from('hello world');
      const client = new SlackClient(temp.paths);

      await client.sendUploadBytes(UPLOAD_URL, Readable.from([bytes]), bytes.length);

      const requests = axiosHarness.requests.filter((request) => request.url === UPLOAD_URL);
      expect(requests).toHaveLength(1);
      const [request] = requests;
      expect(request.method).toBe('post');
      expect(typeof (request.body as { pipe?: unknown }).pipe).toBe('function');
      expect(request.streamedBytes).toBe(bytes.length);
      expect(Number(request.headers['content-length'])).toBe(bytes.length);
      expect(Object.keys(request.headers)).not.toContain('authorization');
      expect(Object.keys(request.headers)).not.toContain('cookie');
    });

    it.each(REFUSED_UPLOAD_URLS)('refuses %s before any byte is sent', async (_label, uploadUrl) => {
      writeTokenFile(temp);
      const bytes = Buffer.from('hello world');
      const body = Readable.from([bytes]);
      const client = new SlackClient(temp.paths);

      const outcome = await settle(() => client.sendUploadBytes(uploadUrl, body, bytes.length));

      expect(outcome.threw).toBe(true);
      expect(outcome.error).toMatchObject({ code: 'invalid_upload_url' });
      expect(axiosHarness.requests).toHaveLength(0);
      expect(body.readableDidRead).toBe(false);
    });

    it('sends the bytes with redirects disabled and fails a redirect answer instead of following it', async () => {
      writeTokenFile(temp);
      const bytes = Buffer.from('hello world');
      const sentConfigs = recordDefaultAxiosRequestConfigs();
      axiosHarness.respond(() => ({ status: 302, headers: { location: 'https://example-team.slack.com/elsewhere' } }));
      const client = new SlackClient(temp.paths);

      const outcome = await settle(() => client.sendUploadBytes(UPLOAD_URL, Readable.from([bytes]), bytes.length));

      expect(sentConfigs.filter((config) => config.url === UPLOAD_URL)).toEqual([
        expect.objectContaining({ maxRedirects: 0 }),
      ]);
      expect(outcome.threw).toBe(true);
      expect(outcome.error).toMatchObject({ code: 'slack_error', http_status: 302 });
      expect(axiosHarness.requests.filter((request) => request.url === UPLOAD_URL)).toHaveLength(1);
    });
  });

  describe('a request that got no answer', () => {
    let network: Awaited<ReturnType<typeof useRealAxiosInstances>> | undefined;

    afterEach(() => {
      network?.restore();
      network = undefined;
    });

    describe.each(WRITES_THAT_MUST_NOT_REPEAT)('%s', (_name, slackMethod, invoke) => {
      it.each(NO_ANSWER_CODES)('is attempted exactly once and surfaces as unreachable when it fails with %s', async (code) => {
        writeTokenFile(temp);
        network = await useRealAxiosInstances(() => ({ networkError: code }));
        const client = new SlackClient(temp.paths);

        const outcome = await settleWithRetryClock(() => invoke(client));

        expect(network.calls.filter((call) => call.slackMethod === slackMethod)).toHaveLength(1);
        expect(outcome.error).toMatchObject({ code: 'unreachable' });
      });
    });

    it.each(RETRIED_READ_FAILURES)('still retries a GET once after %s and returns the later answer', async (_label, firstReply) => {
      writeTokenFile(temp);
      let answers = 0;
      network = await useRealAxiosInstances(() => (answers++ === 0 ? firstReply : slackOk({ channel: { id: CHANNEL_ID } })));
      const client = new SlackClient(temp.paths);

      const outcome = await settleWithRetryClock(() => client.conversationsInfo({ channel: CHANNEL_ID }));

      expect(outcome.threw).toBe(false);
      expect(network.calls.filter((call) => call.slackMethod === 'conversations.info')).toHaveLength(2);
    });
  });
});
