import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

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
  writeCapturedSession,
  writeToken,
  writeUploadFile,
} from './__fixtures__/wiring/sandbox.js';
import {
  SLACK_SIDE_FILE_NAME,
  fakeSlackApi,
  hostedFileObject,
  streamFailingAfter,
  streamOf,
  type Reply,
} from './__fixtures__/wiring/fake-slack-api.js';
import { callTool, observedText, resultJson, type ToolHandlers, type ToolOutcome } from './__fixtures__/wiring/harness.js';
import {
  ALL_USER_SCOPES,
  CAPTURED_COOKIE_SENTINEL,
  CAPTURED_TOKEN_SENTINEL,
  EXAMPLE,
  FILE_BYTES_SENTINEL,
  TOKEN_SENTINEL,
  messageLink,
} from './__fixtures__/wiring/sentinels.js';
import { SlackModule } from './index.js';
import { SlackClient } from '../../services/slack/slack-client.js';
import { oneShotSha256 } from '../../services/slack/__fixtures__/bytes.js';
import { rawMessage } from './__fixtures__/tools/fake-slack.js';

const TOOL = 'slack_download_file';
const FILE_HOSTS = ['files.slack.com', 'files-origin.slack.com'];
const OCTET_STREAM = { 'content-type': 'application/octet-stream' };
const SIGN_IN_MARKER = 'SIGN-IN-PAGE-EXAMPLE';
const SIGN_IN_PAGE = `<html><body>${SIGN_IN_MARKER}</body></html>`;
const REPORTED_SIZE = 20;

let handlers: ToolHandlers;

beforeEach(() => {
  resetSandbox();
  writeAppConfig();
  writeToken();
  fakeSlackApi.reset();
  handlers = new SlackModule().createToolHandlers({ slack: new SlackClient() }) as ToolHandlers;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(removeSandbox);

function download(args: Record<string, unknown>): Promise<ToolOutcome> {
  return callTool(handlers, TOOL, args);
}

function pathInDirectory(name: string): string {
  return join(realpathSync(uploadDirectory), name);
}

function filesInDirectory(): string[] {
  return readdirSync(uploadDirectory).sort();
}

function expectRefusal(outcome: ToolOutcome, code: string): void {
  expect(outcome.thrown, `expected slack.${code}, got a result: ${outcome.text}`).toBeDefined();
  expect(outcome.thrown?.message).toContain(`slack.${code}:`);
}

function answerInfo(overrides: Record<string, unknown>): void {
  fakeSlackApi.onMethod('files.info', () => ({ data: { ok: true, file: hostedFileObject(overrides) } }));
}

function serve(body: () => ReturnType<typeof streamOf>, headers: Record<string, string> = OCTET_STREAM): void {
  fakeSlackApi.onFileHost(() => ({ data: body(), status: 200, headers }));
}

function addressOf(address: string): Record<string, unknown> {
  return { url_private: address, url_private_download: address };
}

async function loginWithBrowserSession(): Promise<void> {
  resetSandbox();
  writeAppConfig();
  writeCapturedSession();
  const login = await callTool(handlers, 'slack_login');
  expect(resultJson(login).state).toBe('connected');
}

function redirectTo(location: string): Reply {
  return { data: streamOf(), status: 302, headers: { location } };
}

describe('slack_download_file: saving a file', () => {
  it('downloads the attachment ID returned by a default message read', async () => {
    const content = Buffer.from(`${FILE_BYTES_SENTINEL}\n`);
    const file = hostedFileObject({ id: 'F0EXAMPLE01', size: content.length });
    fakeSlackApi.onMethod('conversations.history', () => ({
      data: {
        ok: true,
        messages: [{ ...rawMessage({ ts: EXAMPLE.rootTs, user: EXAMPLE.peerId }), subtype: 'file_share', files: [file] }],
      },
    }));
    fakeSlackApi.onMethod('files.info', () => ({ data: { ok: true, file } }));
    serve(() => streamOf(content));

    const read = await callTool(handlers, 'slack_get_messages', { messages: [{ channel: EXAMPLE.channelId }] });

    expect(read.thrown, observedText(read)).toBeUndefined();
    expect(fakeSlackApi.requests.map((request) => request.apiMethod ?? request.host)).toEqual(['conversations.history']);
    expect(fakeSlackApi.requestsFor('files.info')).toEqual([]);
    expect(fakeSlackApi.fileHostRequests()).toEqual([]);
    const message = resultJson(read).results[0].items[0];
    expect(message.hasAttachments).toBe(true);
    expect(message.attachments).toEqual([
      { file_id: 'F0EXAMPLE01', name: 'EXAMPLE-slack-side-name.txt', size: 20, type: 'text/plain' },
    ]);
    expect(message).not.toHaveProperty('text');
    const path = pathInDirectory('discovered-copy.txt');

    const outcome = await download({ file: message.attachments[0].file_id, path });

    expect(outcome.thrown, observedText(outcome)).toBeUndefined();
    expect(resultJson(outcome)).toEqual({
      path,
      name: 'discovered-copy.txt',
      size: 20,
      type: 'text/plain',
      sha256: oneShotSha256(content),
    });
    expect(readFileSync(path).equals(content)).toBe(true);
    expect(filesInDirectory()).toEqual(['discovered-copy.txt']);
    const infoRequests = fakeSlackApi.requestsFor('files.info');
    expect(infoRequests).toHaveLength(1);
    expect(fakeSlackApi.fieldsOf(infoRequests[0]).file).toBe('F0EXAMPLE01');
    const byteRequests = fakeSlackApi.fileHostRequests();
    expect(byteRequests).toHaveLength(1);
    expect(byteRequests[0].httpMethod).toBe('GET');
    expect(outcome.text).not.toContain(SLACK_SIDE_FILE_NAME);
    expect(outcome.text).not.toContain(FILE_BYTES_SENTINEL);
    expect(outcome.text).not.toContain(EXAMPLE.fileUrl);
  });

  it('saves a hosted file by id and returns only its path, name, size, type and sha256', async () => {
    const chunks = [`${FILE_BYTES_SENTINEL}-first part\n`, 'second part\n', 'third part\n'].map((text) => Buffer.from(text));
    const content = Buffer.concat(chunks);
    answerInfo({ size: content.length });
    serve(() => streamOf(...chunks));
    const path = pathInDirectory('saved-copy.txt');

    const outcome = await download({ file: EXAMPLE.fileId, path });

    expect(outcome.thrown, observedText(outcome)).toBeUndefined();
    expect(resultJson(outcome)).toEqual({
      path,
      name: 'saved-copy.txt',
      size: content.length,
      type: 'text/plain',
      sha256: oneShotSha256(content),
    });
    expect(readFileSync(path).equals(content)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(outcome.text).not.toContain(FILE_BYTES_SENTINEL);
    expect(outcome.text).not.toContain(SLACK_SIDE_FILE_NAME);
    expect(filesInDirectory()).toEqual(['saved-copy.txt']);
    expect(fakeSlackApi.requests.map((request) => request.apiMethod ?? request.host)).toEqual([
      'files.info',
      'files.slack.com',
    ]);
    expect(fakeSlackApi.fieldsOf(fakeSlackApi.requests[0]).file).toBe(EXAMPLE.fileId);
    expect(fakeSlackApi.requests[1].httpMethod).toBe('GET');
    expect(fakeSlackApi.requests[1].url).toBe(EXAMPLE.fileUrl);
    expect(fakeSlackApi.requests[1].headers.authorization).toBe(`Bearer ${TOKEN_SENTINEL}`);
  });

  it('saves a hosted file to a valid long destination filename', async () => {
    const name = 'a'.repeat(242);
    const path = pathInDirectory(name);
    writeFileSync(path, 'valid filesystem path');
    expect(readFileSync(path, 'utf8')).toBe('valid filesystem path');
    rmSync(path);

    const outcome = await download({ file: EXAMPLE.fileId, path });

    expect(outcome.thrown, observedText(outcome)).toBeUndefined();
    expect(resultJson(outcome)).toEqual({
      path,
      name,
      size: Buffer.byteLength(FILE_BYTES_SENTINEL),
      type: 'text/plain',
      sha256: oneShotSha256(Buffer.from(FILE_BYTES_SENTINEL)),
    });
    expect(readFileSync(path, 'utf8')).toBe(FILE_BYTES_SENTINEL);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(filesInDirectory()).toEqual([name]);
  });

  it('accepts a file link of the connected workspace', async () => {
    const link = `https://${EXAMPLE.teamHost}/files/${EXAMPLE.meId}/${EXAMPLE.fileId}/notes.txt`;
    const path = pathInDirectory('from-link.txt');

    const outcome = await download({ file: link, path });

    expect(outcome.thrown, observedText(outcome)).toBeUndefined();
    expect(resultJson(outcome).path).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe(FILE_BYTES_SENTINEL);
    const asked = fakeSlackApi.requestsFor('files.info');
    expect(asked).toHaveLength(1);
    expect(fakeSlackApi.fieldsOf(asked[0]).file).toBe(EXAMPLE.fileId);
  });

  it.each([
    [
      'a file link of another workspace',
      'wrong_workspace',
      `https://${EXAMPLE.otherTeamDomain}.slack.com/files/${EXAMPLE.meId}/${EXAMPLE.fileId}/notes.txt`,
    ],
    ['a message link', 'wrong_link_kind', messageLink(EXAMPLE.channelId, EXAMPLE.rootTs)],
    ['text that is no link', 'unrecognized_link', 'not a slack link'],
  ])(
    'refuses a link from another workspace or that is not a file link, before any Slack call (%s)',
    async (_label, code, file) => {
      const outcome = await download({ file, path: pathInDirectory('refused.txt') });

      expectRefusal(outcome, code);
      expect(fakeSlackApi.requests).toEqual([]);
      expect(filesInDirectory()).toEqual([]);
    },
  );
});

describe('slack_download_file: the target path', () => {
  it('refuses an existing target unless overwrite is true, before any Slack call', async () => {
    const path = writeUploadFile('existing.txt', 'original bytes');

    const outcome = await download({ file: EXAMPLE.fileId, path });

    expectRefusal(outcome, 'target_exists');
    expect(outcome.thrown?.message).toContain('overwrite');
    expect(fakeSlackApi.requests).toEqual([]);
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
    expect(filesInDirectory()).toEqual(['existing.txt']);
  });

  it('replaces an existing regular file when overwrite is true', async () => {
    const path = writeUploadFile('replace-me.txt', 'old bytes');

    const outcome = await download({ file: EXAMPLE.fileId, path, overwrite: true });

    expect(outcome.thrown, observedText(outcome)).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(FILE_BYTES_SENTINEL);
    expect(resultJson(outcome)).toMatchObject({
      size: Buffer.byteLength(FILE_BYTES_SENTINEL),
      sha256: oneShotSha256(Buffer.from(FILE_BYTES_SENTINEL)),
    });
    expect(filesInDirectory()).toEqual(['replace-me.txt']);
  });

  it('refuses to replace a symlink created during an overwriting download', async () => {
    const referent = writeUploadFile('referent.txt', 'original referent bytes');
    const path = pathInDirectory('racing-target.txt');
    expect(existsSync(path)).toBe(false);
    serve(() => {
      symlinkSync(referent, path);
      return streamOf(Buffer.from(FILE_BYTES_SENTINEL));
    });

    const outcome = await download({ file: EXAMPLE.fileId, path, overwrite: true });

    expect(fakeSlackApi.fileHostRequests()).toHaveLength(1);
    expect.soft(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(referent, 'utf8')).toBe('original referent bytes');
    expect(filesInDirectory()).toEqual(['racing-target.txt', 'referent.txt']);
    expectRefusal(outcome, 'not_a_file');
  });

  it.each([
    [
      'a directory',
      (target: string) => {
        mkdirSync(target);
        writeFileSync(join(target, 'inside.txt'), 'inside');
        return () => {
          expect(lstatSync(target).isDirectory()).toBe(true);
          expect(readdirSync(target)).toEqual(['inside.txt']);
        };
      },
    ],
    [
      'a symlink',
      (target: string) => {
        const real = writeUploadFile('real-target.txt', 'real bytes');
        symlinkSync(real, target);
        return () => {
          expect(lstatSync(target).isSymbolicLink()).toBe(true);
          expect(readFileSync(real, 'utf8')).toBe('real bytes');
        };
      },
    ],
  ])('refuses to replace a directory or a symlink even with overwrite (%s)', async (_label, arrange) => {
    const target = pathInDirectory('not-a-regular-file');
    const expectUntouched = arrange(target);

    const outcome = await download({ file: EXAMPLE.fileId, path: target, overwrite: true });

    expectRefusal(outcome, 'not_a_file');
    expectUntouched();
  });

  it.each([
    ['a relative path', 'path_not_absolute', () => 'relative-download-copy.txt'],
    ['a missing directory', 'path_not_found', () => join(uploadDirectory, 'missing-directory', 'copy.txt')],
  ])('refuses a relative path and a missing directory before any Slack call (%s)', async (_label, code, pathOf) => {
    try {
      const outcome = await download({ file: EXAMPLE.fileId, path: pathOf() });

      expectRefusal(outcome, code);
      expect(fakeSlackApi.requests).toEqual([]);
      expect(filesInDirectory()).toEqual([]);
      expect(existsSync(resolve('relative-download-copy.txt'))).toBe(false);
    } finally {
      rmSync(resolve('relative-download-copy.txt'), { force: true });
    }
  });
});

describe('slack_download_file: a transfer that goes wrong', () => {
  const TRANSFER_FAILURES: Array<[string, () => ReturnType<typeof streamOf>]> = [
    ['an error after the first chunk', () => streamFailingAfter(Buffer.alloc(8, 'a'), new Error('transfer interrupted'))],
    ['a body shorter than the reported size', () => streamOf(Buffer.alloc(8, 'a'), Buffer.alloc(4, 'b'))],
    ['a body longer than the reported size', () => streamOf(Buffer.alloc(16, 'a'), Buffer.alloc(16, 'b'))],
  ];

  it.each(TRANSFER_FAILURES)('leaves no file behind when the transfer fails or the size is wrong (%s)', async (_label, body) => {
    answerInfo({ size: REPORTED_SIZE });
    serve(body);
    const path = pathInDirectory('partial.bin');

    const outcome = await download({ file: EXAMPLE.fileId, path });

    expectRefusal(outcome, 'download_failed');
    expect(existsSync(path)).toBe(false);
    expect(filesInDirectory()).toEqual([]);
  });

  it.each(TRANSFER_FAILURES)('keeps the original file when an overwriting download fails (%s)', async (_label, body) => {
    answerInfo({ size: REPORTED_SIZE });
    serve(body);
    const path = writeUploadFile('keep-me.bin', 'original bytes');

    const outcome = await download({ file: EXAMPLE.fileId, path, overwrite: true });

    expectRefusal(outcome, 'download_failed');
    expect(readFileSync(path, 'utf8')).toBe('original bytes');
    expect(filesInDirectory()).toEqual(['keep-me.bin']);
  });

  it('rejects a sign-in page served in place of the file', async () => {
    answerInfo({ mimetype: 'image/png', size: Buffer.byteLength(SIGN_IN_PAGE) });
    serve(() => streamOf(Buffer.from(SIGN_IN_PAGE)), { 'content-type': 'text/html; charset=utf-8' });
    const path = pathInDirectory('picture.png');

    const outcome = await download({ file: EXAMPLE.fileId, path });

    expectRefusal(outcome, 'download_not_authorized');
    expect(existsSync(path)).toBe(false);
    expect(filesInDirectory()).toEqual([]);
    expect(observedText(outcome)).not.toContain(SIGN_IN_MARKER);
    expect(observedText(outcome)).not.toContain('<html');
  });
});

describe('slack_download_file: where the token may go', () => {
  it('follows a redirect between the Slack file hosts, sending the token to each and nowhere else', async () => {
    const content = Buffer.from('bytes from the second host');
    answerInfo({ size: content.length });
    fakeSlackApi.onFileHost((_fields, request) =>
      request.host === 'files.slack.com'
        ? redirectTo(EXAMPLE.fileRedirectUrl)
        : { data: streamOf(content), status: 200, headers: OCTET_STREAM },
    );
    const path = pathInDirectory('redirected.txt');

    const outcome = await download({ file: EXAMPLE.fileId, path });

    expect(outcome.thrown, observedText(outcome)).toBeUndefined();
    expect(readFileSync(path).equals(content)).toBe(true);
    const fileRequests = fakeSlackApi.fileHostRequests();
    expect(fileRequests.map((request) => request.host)).toEqual(FILE_HOSTS);
    for (const request of fileRequests) {
      expect(request.headers.authorization, request.host).toBe(`Bearer ${TOKEN_SENTINEL}`);
      expect(request.headers.cookie, request.host).toBeUndefined();
    }
    for (const request of fakeSlackApi.requests) {
      expect(['slack.com', ...FILE_HOSTS], request.url).toContain(request.host);
      expect(request.headers.cookie, request.url).toBeUndefined();
    }
  });

  it.each([
    [
      'a redirect to another host',
      'download_not_authorized',
      1,
      () => fakeSlackApi.onFileHost(() => redirectTo('https://sign-in.example.invalid/')),
    ],
    [
      'an address that is not https',
      'file_not_downloadable',
      0,
      () => answerInfo(addressOf('http://files.slack.com/files-pri/T0EXAMPLE1-F0EXAMPLE01/download/example.txt')),
    ],
    [
      'an address on a lookalike host',
      'file_not_downloadable',
      0,
      () =>
        answerInfo(addressOf('https://files.slack.com.example.invalid/files-pri/T0EXAMPLE1-F0EXAMPLE01/download/example.txt')),
    ],
  ])(
    'refuses a download address or redirect outside the Slack file hosts without sending the token there (%s)',
    async (_label, code, fileHostRequestCount, arrange) => {
      arrange();

      const outcome = await download({ file: EXAMPLE.fileId, path: pathInDirectory('refused.txt') });

      expectRefusal(outcome, code);
      expect(fakeSlackApi.fileHostRequests()).toHaveLength(fileHostRequestCount);
      for (const request of fakeSlackApi.requests) {
        expect(['slack.com', ...FILE_HOSTS], request.url).toContain(request.host);
        expect(request.url.startsWith('https://'), request.url).toBe(true);
      }
      expect(filesInDirectory()).toEqual([]);
    },
  );

  it('downloads with a browser-session login, sending its token and cookie to the Slack file hosts only', async () => {
    const content = Buffer.from('bytes from the second host');
    answerInfo({ size: content.length });
    fakeSlackApi.onFileHost((_fields, request) =>
      request.host === 'files.slack.com'
        ? redirectTo(EXAMPLE.fileRedirectUrl)
        : { data: streamOf(content), status: 200, headers: OCTET_STREAM },
    );
    await loginWithBrowserSession();
    const path = pathInDirectory('session-copy.txt');

    const outcome = await download({ file: EXAMPLE.fileId, path });

    expect(outcome.thrown, observedText(outcome)).toBeUndefined();
    expect(resultJson(outcome)).toEqual({
      path,
      name: 'session-copy.txt',
      size: content.length,
      type: 'text/plain',
      sha256: oneShotSha256(content),
    });
    expect(readFileSync(path).equals(content)).toBe(true);
    expect(fakeSlackApi.requestsFor('files.info').map((request) => request.host)).toEqual(['app.slack.com']);
    const fileRequests = fakeSlackApi.fileHostRequests();
    expect(fileRequests.map((request) => request.host)).toEqual(FILE_HOSTS);
    for (const request of fileRequests) {
      expect(request.headers.authorization, request.host).toBe(`Bearer ${CAPTURED_TOKEN_SENTINEL}`);
      expect(request.headers.cookie, request.host).toBe(`d=${CAPTURED_COOKIE_SENTINEL}`);
    }
    for (const request of fakeSlackApi.requests) {
      expect(['app.slack.com', ...FILE_HOSTS], request.url).toContain(request.host);
    }
  });

  it('refuses a redirect outside the Slack file hosts for a browser session, sending neither its token nor its cookie there', async () => {
    await loginWithBrowserSession();
    fakeSlackApi.onFileHost(() => redirectTo('https://sign-in.example.invalid/'));

    const outcome = await download({ file: EXAMPLE.fileId, path: pathInDirectory('session-refused.bin') });

    expectRefusal(outcome, 'download_not_authorized');
    expect(fakeSlackApi.requests.filter((request) => request.host === 'sign-in.example.invalid')).toEqual([]);
    expect(fakeSlackApi.fileHostRequests()).toHaveLength(1);
    for (const request of fakeSlackApi.requests) {
      expect(['app.slack.com', ...FILE_HOSTS], request.url).toContain(request.host);
    }
    expect(filesInDirectory()).toEqual([]);
  });
});

describe('slack_download_file: a browser session served a sign-in page', () => {
  it('names the browser session when a sign-in page is served to it', async () => {
    answerInfo({ mimetype: 'image/png', size: Buffer.byteLength(SIGN_IN_PAGE) });
    serve(() => streamOf(Buffer.from(SIGN_IN_PAGE)), { 'content-type': 'text/html; charset=utf-8' });
    await loginWithBrowserSession();
    const path = pathInDirectory('session-picture.png');

    const outcome = await download({ file: EXAMPLE.fileId, path });

    expectRefusal(outcome, 'download_not_authorized');
    expect(outcome.thrown?.message).toContain('browser session');
    expect(outcome.thrown?.message).toContain('SLACK_SESSION_FILE');
    expect(existsSync(path)).toBe(false);
    expect(filesInDirectory()).toEqual([]);
    expect(observedText(outcome)).not.toContain(SIGN_IN_MARKER);
    expect(observedText(outcome)).not.toContain('<html');
  });
});

describe('slack_download_file: files Slack does not host', () => {
  it.each([
    ['an external file', { mode: 'external', is_external: true }, /external/i],
    ['a deleted file', { is_deleted: true }, /deleted/i],
    ['a tombstoned file', { is_tombstoned: true }, /tombstone/i],
    ['a post', { mode: 'post' }, /post/i],
  ])('refuses files Slack does not host or that are gone (%s)', async (_label, overrides, reason) => {
    answerInfo(overrides);

    const outcome = await download({ file: EXAMPLE.fileId, path: pathInDirectory('refused.bin') });

    expectRefusal(outcome, 'file_not_downloadable');
    expect(outcome.thrown?.message).toMatch(reason);
    expect(fakeSlackApi.fileHostRequests()).toEqual([]);
    expect(filesInDirectory()).toEqual([]);
  });
});

describe('slack_download_file: the login and its scope', () => {
  it('reports a missing files:read scope before any Slack call', async () => {
    writeToken({ scopes: ALL_USER_SCOPES.filter((scope) => scope !== 'files:read') });

    const outcome = await download({ file: EXAMPLE.fileId, path: pathInDirectory('refused.bin') });

    expectRefusal(outcome, 'scope_missing');
    expect(outcome.thrown?.message).toContain('files:read');
    expect(fakeSlackApi.requests).toEqual([]);
    expect(filesInDirectory()).toEqual([]);
  });

  it('reports a Slack missing_scope answer as slack_error', async () => {
    fakeSlackApi.failSlack('files.info', 'missing_scope');

    const outcome = await download({ file: EXAMPLE.fileId, path: pathInDirectory('refused.bin') });

    expectRefusal(outcome, 'slack_error');
    expect(outcome.thrown?.message).toContain('missing_scope');
    expect(fakeSlackApi.fileHostRequests()).toEqual([]);
    expect(filesInDirectory()).toEqual([]);
  });
});

describe('slack_download_file: Slack failures', () => {
  it.each([
    [
      'files.info answers file_not_found',
      'slack_error',
      'file_not_found',
      () => fakeSlackApi.failSlack('files.info', 'file_not_found'),
    ],
    [
      'the file host answers HTTP 404',
      'slack_error',
      '404',
      () =>
        fakeSlackApi.onFileHost(() => ({
          data: streamOf(Buffer.from('not found')),
          status: 404,
          headers: { 'content-type': 'text/html' },
        })),
    ],
    [
      'the file host answers HTTP 429 with Retry-After 7',
      'rate_limited',
      '7 seconds',
      () =>
        fakeSlackApi.onFileHost(() => ({
          data: streamOf(Buffer.from('slow down')),
          status: 429,
          headers: { 'retry-after': '7' },
        })),
    ],
  ])('reports Slack failures with their code and writes nothing (%s)', async (_label, code, detail, arrange) => {
    arrange();

    const outcome = await download({ file: EXAMPLE.fileId, path: pathInDirectory('failed.bin') });

    expectRefusal(outcome, code);
    expect(outcome.thrown?.message).toContain(detail);
    expect(filesInDirectory()).toEqual([]);
  });
});
