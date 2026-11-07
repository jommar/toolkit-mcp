import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  const { createAxiosModule, fakeSlackApi } = await import('./__fixtures__/wiring/fake-slack-api.js');
  return createAxiosModule(actual, fakeSlackApi);
});

import {
  removeSandbox,
  resetSandbox,
  uploadDirectory,
  writeAppConfig,
  writeToken,
  writeUploadFile,
} from './__fixtures__/wiring/sandbox.js';
import { SLACK_SIDE_FILE_NAME, fakeSlackApi, hostedFileObject, streamOf } from './__fixtures__/wiring/fake-slack-api.js';
import {
  callTool,
  captureConsole,
  collectKeys,
  observedText,
  resultJson,
  type ConsoleCapture,
  type ToolHandlers,
  type ToolOutcome,
} from './__fixtures__/wiring/harness.js';
import {
  EXAMPLE,
  FILE_BYTES_SENTINEL,
  FIXTURE_EMAIL,
  FIXTURE_EMAIL_DOMAIN,
  MESSAGE_BODY_SENTINEL,
  PHONE_SENTINEL,
  REAL_NAME_SENTINEL,
  TITLE_SENTINEL,
  messageLink,
} from './__fixtures__/wiring/sentinels.js';
import { READ_CALLS, postItem, uploadItem } from './__fixtures__/wiring/calls.js';
import { SlackModule } from './index.js';
import { SlackClient } from '../../services/slack/slack-client.js';

const PERSONAL_KEYS = ['text', 'email', 'title', 'phone', 'real_name'];
const PERSONAL_VALUES = [FIXTURE_EMAIL_DOMAIN, PHONE_SENTINEL, TITLE_SENTINEL, REAL_NAME_SENTINEL, MESSAGE_BODY_SENTINEL];
const PROFILE_KEYS = ['email', 'title', 'phone', 'real_name'];
const PROFILE_VALUES = [FIXTURE_EMAIL_DOMAIN, PHONE_SENTINEL, TITLE_SENTINEL, REAL_NAME_SENTINEL];

let handlers: ToolHandlers;
let logs: ConsoleCapture;
let observations: string[];

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const outcome = await callTool(handlers, name, args);
  observations.push(observedText(outcome));
  return outcome;
}

function expectNoneOf(texts: string[], forbidden: string[], label: string): void {
  const all = texts.join('\n');
  for (const value of forbidden) {
    expect(all.includes(value), `${label}: ${value}`).toBe(false);
  }
}

function expectNoKeys(value: unknown, forbidden: string[], label: string): void {
  const keys = collectKeys(value);
  for (const key of forbidden) {
    expect(keys.has(key), `${label}: key ${key}`).toBe(false);
  }
}

function itemsOf(outcome: ToolOutcome): any[] {
  const body = resultJson(outcome);
  return body.results.flatMap((entry: { items: unknown[] }) => entry.items);
}

beforeEach(() => {
  resetSandbox();
  writeAppConfig();
  writeToken();
  fakeSlackApi.reset();
  handlers = new SlackModule().createToolHandlers({ slack: new SlackClient() }) as ToolHandlers;
  logs = captureConsole();
  observations = [];
});

afterEach(() => {
  logs.restore();
  vi.unstubAllGlobals();
});

afterAll(removeSandbox);

describe('default read output', () => {
  for (const { label, tool, args } of READ_CALLS) {
    it(`${tool} (${label}) carries no personal key or value`, async () => {
      const outcome = await call(tool, args);

      const items = itemsOf(outcome);
      expect(items.length).toBeGreaterThan(0);
      expectNoKeys(resultJson(outcome), PERSONAL_KEYS, tool);
      expectNoneOf([outcome.text], PERSONAL_VALUES, tool);
    });
  }

  it('keeps every personal value out of the logs', async () => {
    for (const { tool, args } of READ_CALLS) await call(tool, args);
    expectNoneOf(logs.lines(), PERSONAL_VALUES, 'logs');
  });
});

describe('email as an optional user field', () => {
  it('adds email to the user entries of a call that lists it, and nothing else personal', async () => {
    const outcome = await call('slack_get_users', { users: [{ user: EXAMPLE.peerId }], fields: ['email'] });

    const items = itemsOf(outcome);
    expect(items.length).toBe(1);
    expect(items[0].email).toBe(FIXTURE_EMAIL);
    expectNoKeys(items, ['phone', 'title', 'real_name', 'text'], 'email request');
    expectNoneOf([outcome.text], [PHONE_SENTINEL, TITLE_SENTINEL, REAL_NAME_SENTINEL], 'email request');
  });

  it('keeps the address out of every other tool, with and without a fields list', async () => {
    const otherCalls: Array<[string, Record<string, unknown>]> = [
      ['slack_search_messages', { queries: [{ query: 'EXAMPLE' }], fields: ['email'] }],
      ['slack_get_messages', { messages: [{ channel: EXAMPLE.channelId }], fields: ['email'] }],
      ['slack_get_messages', { messages: [{ channel: EXAMPLE.channelId }], fields: ['text', 'author_name', 'channel_name'] }],
      ['slack_get_threads', { threads: [{ thread: messageLink(EXAMPLE.channelId, EXAMPLE.rootTs) }], fields: ['email'] }],
      ['slack_get_channels', { channels: [{ channel: EXAMPLE.dmId }], fields: ['email'] }],
      ['slack_get_channels', { channels: [{ channel: EXAMPLE.dmId }] }],
    ];

    for (const [tool, args] of otherCalls) await call(tool, args);

    expectNoneOf(observations, [FIXTURE_EMAIL_DOMAIN], 'other tools');
    expectNoneOf(logs.lines(), [FIXTURE_EMAIL_DOMAIN], 'logs');
  });

  it('never makes the phone number reachable', async () => {
    const refused = await call('slack_get_users', { users: [{ user: EXAMPLE.peerId }], fields: ['phone'] });
    const allowed = await call('slack_get_users', {
      users: [{ user: EXAMPLE.peerId }],
      fields: ['real_name', 'title', 'tz', 'email'],
    });

    expect(refused.thrown?.code).toBe(ErrorCode.InvalidParams);
    const items = itemsOf(allowed);
    expect(items.length).toBe(1);
    expect(items[0].real_name).toBe(REAL_NAME_SENTINEL);
    expect(items[0].title).toBe(TITLE_SENTINEL);
    expectNoKeys(items, ['phone'], 'allowed fields');
    expectNoneOf(observations, [PHONE_SENTINEL], 'phone');
  });
});

describe('write previews', () => {
  it('shows a mention by id and display name without any profile detail', async () => {
    const outcome = await call('slack_prepare_write', {
      items: [postItem(`ping <@${EXAMPLE.peerId}>`)],
    });

    const preview = resultJson(outcome);
    expect(typeof preview.confirmation_token).toBe('string');
    expect(preview.items[0].mentions[0].id).toBe(EXAMPLE.peerId);
    expect(preview.items[0].mentions[0].display_name).toBe(EXAMPLE.peerHandle);
    expectNoKeys(preview, PROFILE_KEYS, 'post preview');
    expectNoneOf([outcome.text], PROFILE_VALUES, 'post preview');
  });

  it('shows an upload by fingerprint and never by content', async () => {
    const content = `${FILE_BYTES_SENTINEL}\nsecond line of the note\n`;
    const path = writeUploadFile('note.txt', content);

    const outcome = await call('slack_prepare_write', {
      items: [uploadItem(path, 'see attached')],
    });

    const file = resultJson(outcome).items[0].file;
    expect(file.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(file.size).toBe(Buffer.byteLength(content));
    expect(file.name).toBe('note.txt');
    expect(file.resolved_path.endsWith('/note.txt')).toBe(true);
    expectNoneOf([outcome.text], [FILE_BYTES_SENTINEL, 'second line of the note'], 'upload preview');
    expectNoKeys(resultJson(outcome), PROFILE_KEYS, 'upload preview');
  });
});

describe('file downloads', () => {
  // The private file address is a capability, so it stays out of results, errors and logs like the bytes do.
  const DOWNLOAD_FORBIDDEN = [
    ...PERSONAL_VALUES,
    FILE_BYTES_SENTINEL,
    SLACK_SIDE_FILE_NAME,
    new URL(EXAMPLE.fileUrl).pathname,
  ];

  it('returns the path, name, size, type and hash of the saved file, and no personal key, value or file content', async () => {
    const outcome = await call('slack_download_file', {
      file: EXAMPLE.fileId,
      path: join(uploadDirectory, 'saved.txt'),
    });

    const result = resultJson(outcome);
    expect(Object.keys(result).sort()).toEqual(['name', 'path', 'sha256', 'size', 'type']);
    expectNoKeys(result, PERSONAL_KEYS, 'download result');
    expectNoneOf([outcome.text], DOWNLOAD_FORBIDDEN, 'download result');
    expectNoneOf(logs.lines(), DOWNLOAD_FORBIDDEN, 'logs');
  });

  it('keeps personal values and file content out of the errors of a download that is refused or fails', async () => {
    const path = join(uploadDirectory, 'refused.txt');
    const refusals: Array<() => void> = [
      () => fakeSlackApi.failEverySlackMethod('invalid_auth'),
      () => fakeSlackApi.failSlack('files.info', 'file_not_found'),
      () =>
        fakeSlackApi.onMethod('files.info', () => ({
          data: { ok: true, file: hostedFileObject({ mode: 'external', is_external: true }) },
        })),
      () =>
        fakeSlackApi.onFileHost(() => ({
          data: streamOf(Buffer.from(`${FILE_BYTES_SENTINEL} ${SLACK_SIDE_FILE_NAME}`)),
          status: 404,
          headers: { 'content-type': 'text/html' },
        })),
    ];

    for (const refuse of refusals) {
      fakeSlackApi.resetHandlers();
      refuse();
      const outcome = await call('slack_download_file', { file: EXAMPLE.fileId, path });
      expect(outcome.thrown, 'a refused download throws').toBeDefined();
    }

    expectNoneOf(observations, DOWNLOAD_FORBIDDEN, 'download errors');
    expectNoneOf(logs.lines(), DOWNLOAD_FORBIDDEN, 'logs');
  });
});

describe('errors and logs', () => {
  it('keeps personal values out of errors when Slack rejects every call', async () => {
    fakeSlackApi.failEverySlackMethod('invalid_auth');

    for (const { label, tool, args } of READ_CALLS) {
      const outcome = await call(tool, args);
      expect(outcome.thrown, `${tool} (${label})`).toBeDefined();
    }

    expectNoneOf(observations, PERSONAL_VALUES, 'rejected session');
    expectNoneOf(logs.lines(), PERSONAL_VALUES, 'logs');
  });

  it('keeps personal values out of per-item errors and an unreachable workspace', async () => {
    await call('slack_get_users', { users: [{ user: EXAMPLE.missingUserId }] });
    fakeSlackApi.failNetwork('users.info');
    await call('slack_get_users', { users: [{ user: EXAMPLE.peerId }], fields: ['email'] });
    await call('slack_prepare_write', {
      items: [postItem(`ping <@${EXAMPLE.peerId}>`)],
    });

    expectNoneOf(observations, [PHONE_SENTINEL, TITLE_SENTINEL, REAL_NAME_SENTINEL], 'failure paths');
    expectNoneOf(logs.lines(), PERSONAL_VALUES, 'logs');
  });
});
