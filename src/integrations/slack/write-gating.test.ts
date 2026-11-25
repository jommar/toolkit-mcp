import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { MockInstance } from 'vitest';

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  const { createAxiosModule, fakeSlackApi } = await import('./__fixtures__/wiring/fake-slack-api.js');
  return createAxiosModule(actual, fakeSlackApi);
});

import { removeSandbox, resetSandbox, writeAppConfig, writeToken, writeUploadFile } from './__fixtures__/wiring/sandbox.js';
import { fakeSlackApi } from './__fixtures__/wiring/fake-slack-api.js';
import { callTool, resultJson, type ToolHandlers, type ToolOutcome } from './__fixtures__/wiring/harness.js';
import { EXAMPLE, FILE_BYTES_SENTINEL, messageLink } from './__fixtures__/wiring/sentinels.js';
import { postItem, reactItem, uploadItem } from './__fixtures__/wiring/calls.js';
import { McpServer } from '@modelcontextprotocol/server';
import type { Client } from '@modelcontextprotocol/client';
import { SlackModule } from './index.js';
import { registerModuleTools } from '../register.js';
import { connectInMemory, contentText, rawToolHandlers } from '../../__fixtures__/mcp.js';
import { SlackClient } from '../../services/slack/slack-client.js';

const WRITE_METHODS = ['postMessage', 'addReaction', 'getUploadUrl', 'sendUploadBytes', 'completeUpload'] as const;
type WriteMethod = (typeof WRITE_METHODS)[number];
type WriteCounts = Record<WriteMethod, number>;

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

let handlers: ToolHandlers;
let client: SlackClient;
let methodSpies: Record<WriteMethod, MockInstance>;

function zeroCounts(): WriteCounts {
  return { postMessage: 0, addReaction: 0, getUploadUrl: 0, sendUploadBytes: 0, completeUpload: 0 };
}

function clientCounts(): WriteCounts {
  const counts = zeroCounts();
  for (const method of WRITE_METHODS) counts[method] = methodSpies[method].mock.calls.length;
  return counts;
}

function wireCounts(): WriteCounts {
  return {
    postMessage: fakeSlackApi.requestsFor('chat.postMessage').length,
    addReaction: fakeSlackApi.requestsFor('reactions.add').length,
    getUploadUrl: fakeSlackApi.requestsFor('files.getUploadURLExternal').length,
    sendUploadBytes: fakeSlackApi.uploadHostRequests().length,
    completeUpload: fakeSlackApi.requestsFor('files.completeUploadExternal').length,
  };
}

function expectWrites(expected: Partial<WriteCounts>, label: string): void {
  const full = { ...zeroCounts(), ...expected };
  expect(clientCounts(), `${label}: client methods`).toEqual(full);
  expect(wireCounts(), `${label}: requests on the wire`).toEqual(full);
}

const uploadNote = () => uploadItem(writeUploadFile('note.txt', `${FILE_BYTES_SENTINEL}\n`));

async function prepare(items: Record<string, unknown>[]): Promise<string> {
  const outcome = await callTool(handlers, 'slack_prepare_write', { items });
  const token = resultJson(outcome).confirmation_token;
  expect(typeof token, 'a preview with no item error issues a token').toBe('string');
  return token;
}

function confirm(token: string): Promise<ToolOutcome> {
  return callTool(handlers, 'slack_confirm_write', { confirmation_token: token });
}

beforeEach(() => {
  resetSandbox();
  writeAppConfig();
  writeToken();
  fakeSlackApi.reset();
  client = new SlackClient();
  methodSpies = Object.fromEntries(
    WRITE_METHODS.map((method) => [method, vi.spyOn(client as never, method as never)]),
  ) as unknown as Record<WriteMethod, MockInstance>;
  handlers = rawToolHandlers(new SlackModule(), { slack: client }) as ToolHandlers;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await callTool(handlers, 'slack_logout', { revoke: false });
});

afterAll(removeSandbox);

describe('before a token is redeemed', () => {
  it('no tool other than slack_confirm_write reaches a write or upload method', async () => {
    const callsOtherThanConfirm: Array<[string, Record<string, unknown>]> = [
      ['slack_get_status', {}],
      ['slack_get_status', { verify: false }],
      ['slack_search_messages', { queries: [{ query: 'EXAMPLE' }] }],
      ['slack_get_messages', { messages: [{ channel: EXAMPLE.channelId }] }],
      ['slack_get_threads', { threads: [{ thread: messageLink(EXAMPLE.channelId, EXAMPLE.rootTs) }] }],
      ['slack_get_channels', { channels: [{ channel: EXAMPLE.channelId }] }],
      ['slack_get_users', { users: [{ user: EXAMPLE.peerId }] }],
      ['slack_prepare_write', { items: [postItem('hello'), reactItem(), uploadNote()] }],
      ['slack_prepare_write', { items: [{ action: 'post', destination: EXAMPLE.channelId, text: 'no guard' }] }],
      [
        'slack_prepare_write',
        { items: [{ action: 'post', destination: EXAMPLE.channelId, expected_destination: 'wrong-name', text: 'x' }] },
      ],
      ['slack_login', {}],
      ['slack_login', { workspace: EXAMPLE.otherTeamDomain }],
      ['slack_logout', { revoke: false }],
    ];

    for (const [tool, args] of callsOtherThanConfirm) {
      await callTool(handlers, tool, args);
      expectWrites({}, `after ${tool} ${JSON.stringify(Object.keys(args))}`);
    }
  });

  it('a prepared token sends nothing until it is redeemed', async () => {
    await prepare([postItem('hello'), reactItem(), uploadNote()]);

    expectWrites({}, 'after prepare');
  });
});

describe('redeeming a token', () => {
  it('sends the post, the reaction and the three upload steps once each', async () => {
    const token = await prepare([postItem('hello'), reactItem(), uploadNote()]);

    const outcome = await confirm(token);

    expect(outcome.thrown).toBeUndefined();
    expectWrites(
      { postMessage: 1, addReaction: 1, getUploadUrl: 1, sendUploadBytes: 1, completeUpload: 1 },
      'after confirm',
    );
  });

  it('sends once per item, in proportion to the items of that token', async () => {
    const token = await prepare([postItem('first'), postItem('second'), reactItem()]);

    await confirm(token);

    expectWrites({ postMessage: 2, addReaction: 1 }, 'two posts and one reaction');
  });

  it('sends nothing more when the same token is redeemed again', async () => {
    const token = await prepare([postItem('hello'), reactItem()]);
    await confirm(token);

    const replay = await confirm(token);

    expect(replay.thrown).toBeUndefined();
    expectWrites({ postMessage: 1, addReaction: 1 }, 'after replay');
  });

  it('sends only the items of the redeemed token, not of another prepared one', async () => {
    const first = await prepare([postItem('first list')]);
    const second = await prepare([postItem('second list')]);

    await confirm(first);
    expectWrites({ postMessage: 1 }, 'after the first token');

    await confirm(second);
    expectWrites({ postMessage: 2 }, 'after the second token');
  });

  it('still attempts every item once when one of them fails at send time', async () => {
    fakeSlackApi.failSlack('chat.postMessage', 'channel_not_found');
    const token = await prepare([postItem('doomed'), reactItem()]);

    await confirm(token);

    expectWrites({ postMessage: 1, addReaction: 1 }, 'after a failed post');
  });
});

describe('tokens that cannot be redeemed', () => {
  it('an unknown token sends nothing and is named as unknown', async () => {
    const outcome = await confirm('token-that-was-never-issued');

    expect(outcome.thrown?.message).toContain('confirmation_unknown');
    expectWrites({}, 'after an unknown token');
  });

  it('a token older than ten minutes sends nothing and is named as expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const token = await prepare([postItem('hello'), reactItem()]);
    vi.setSystemTime(new Date(Date.now() + TOKEN_LIFETIME_MS + 1000));

    const outcome = await confirm(token);

    expect(outcome.thrown?.message).toContain('confirmation_expired');
    expectWrites({}, 'after an expired token');
  });
});

describe('write gate across connections', () => {
  let connections: Client[] = [];

  // One set of module handlers (so one WriteGate) registered on two servers, as the stdio factory does per connection.
  async function connectTwice(): Promise<[Client, Client]> {
    const slackModule = new SlackModule();
    const shared = slackModule.createToolHandlers({ slack: client });
    const descriptors = slackModule.getToolDescriptors();
    const connect = async () => {
      const server = new McpServer({ name: 'toolkit-mcp-test', version: '0.0.0' });
      registerModuleTools(server, descriptors, shared, { debug: () => {} });
      return connectInMemory(server);
    };
    connections = [await connect(), await connect()];
    return connections as [Client, Client];
  }

  async function prepareOn(connection: Client, items: Record<string, unknown>[]): Promise<string> {
    const prepared = await connection.callTool({ name: 'slack_prepare_write', arguments: { items } });
    expect(prepared.isError, contentText(prepared)).toBeFalsy();
    const token = JSON.parse(contentText(prepared)).confirmation_token;
    expect(typeof token, 'a preview with no item error issues a token').toBe('string');
    return token;
  }

  function confirmOn(connection: Client, token: string) {
    return connection.callTool({ name: 'slack_confirm_write', arguments: { confirmation_token: token } });
  }

  afterEach(async () => {
    await Promise.all(connections.map((connection) => connection.close()));
    connections = [];
  });

  it('sends a post prepared on one connection and confirmed on another exactly once', async () => {
    const [first, second] = await connectTwice();
    const token = await prepareOn(first, [postItem('hello')]);
    expectWrites({}, 'after prepare on the first connection');

    const confirmed = await confirmOn(second, token);

    expect(confirmed.isError, contentText(confirmed)).toBeFalsy();
    expect(JSON.parse(contentText(confirmed)).already_sent).toBe(false);
    expectWrites({ postMessage: 1 }, 'after confirm on the second connection');
  });

  it('reports already_sent and sends nothing more when the second connection confirms again', async () => {
    const [first, second] = await connectTwice();
    const token = await prepareOn(first, [postItem('hello')]);
    await confirmOn(second, token);

    const replay = await confirmOn(second, token);

    expect(replay.isError, contentText(replay)).toBeFalsy();
    expect(JSON.parse(contentText(replay)).already_sent).toBe(true);
    expectWrites({ postMessage: 1 }, 'after the replay');
  });

  it('returns an isError result and sends nothing for a token no connection issued', async () => {
    const [, second] = await connectTwice();

    const outcome = await confirmOn(second, 'token-that-was-never-issued');

    expect(outcome.isError).toBe(true);
    expect(contentText(outcome)).toContain('slack.confirmation_unknown:');
    expectWrites({}, 'after an unknown token');
  });

  it('refuses a structurally invalid write item in SDK validation, before the handler runs', async () => {
    const [first] = await connectTwice();

    const outcome = await first.callTool({
      name: 'slack_prepare_write',
      arguments: { items: [{ action: 'delete', destination: messageLink(EXAMPLE.channelId, EXAMPLE.rootTs) }] },
    });

    expect(outcome.isError).toBe(true);
    expect(contentText(outcome)).toContain('items');
    expect(contentText(outcome)).not.toContain('confirmation_token');
    expectWrites({}, 'after an invalid item');
  });

  it('refuses eleven write items in SDK validation, against the published cap of ten, and sends nothing', async () => {
    const [first] = await connectTwice();
    const items = Array.from({ length: 11 }, (_, index) => postItem(`reply number ${index}`));

    const outcome = await first.callTool({ name: 'slack_prepare_write', arguments: { items } });

    expect(outcome.isError).toBe(true);
    expect(contentText(outcome)).toContain('items');
    expect(contentText(outcome)).not.toContain('slack.batch_too_large');
    expect(contentText(outcome)).not.toContain('confirmation_token');
    expectWrites({}, 'after eleven items');
  });

  it('applies the slack.<code> checks after SDK validation passes', async () => {
    const [first] = await connectTwice();
    resetSandbox();

    const outcome = await first.callTool({ name: 'slack_prepare_write', arguments: { items: [postItem('reply text')] } });

    expect(outcome.isError).toBe(true);
    expect(contentText(outcome)).toMatch(/^slack\.not_connected: /);
    expect(contentText(outcome)).not.toContain('confirmation_token');
    expectWrites({}, 'without a stored token');
  });
});
