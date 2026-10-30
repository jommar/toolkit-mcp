import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi, describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';

vi.mock('axios', async () => {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  const { createAxiosModule, fakeSlackApi } = await import('./__fixtures__/wiring/fake-slack-api.js');
  return createAxiosModule(actual, fakeSlackApi);
});

// Every importer of the callback port and redirect address follows this override, so no run binds the production port.
vi.mock('../../services/slack/slack-app.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/slack/slack-app.js')>(
    '../../services/slack/slack-app.js',
  );
  const { pickFreePort } = await import('./__fixtures__/wiring/fix1-ports.js');
  const port = await pickFreePort();
  return {
    ...actual,
    OAUTH_CALLBACK_PORT: port,
    OAUTH_REDIRECT_URL: `http://localhost:${port}${actual.OAUTH_CALLBACK_PATH}`,
  };
});

import {
  removeSandbox,
  resetSandbox,
  tokenFileExists,
  writeAppConfig,
  writeToken,
  writeUploadFile,
} from './__fixtures__/wiring/sandbox.js';
import { fakeSlackApi, type RecordedRequest } from './__fixtures__/wiring/fake-slack-api.js';
import {
  callTool,
  captureConsole,
  eventually,
  loopbackRequest,
  observedText,
  renderRequest,
  resultJson,
  type ConsoleCapture,
  type ToolHandlers,
  type ToolOutcome,
} from './__fixtures__/wiring/harness.js';
import { READ_CALLS, postItem, reactItem, uploadItem } from './__fixtures__/wiring/calls.js';
import { PRODUCTION_CALLBACK_PORT, holdProductionPort } from './__fixtures__/wiring/fix1-ports.js';
import {
  AUTH_CODE_SENTINEL,
  CLIENT_SECRET_SENTINEL,
  EXAMPLE,
  FILE_BYTES_SENTINEL,
  TOKEN_SENTINEL,
} from './__fixtures__/wiring/sentinels.js';
import { SlackModule } from './index.js';
import { SlackClient } from '../../services/slack/slack-client.js';

const SECRETS: Array<[string, string]> = [
  ['access token', TOKEN_SENTINEL],
  ['client secret', CLIENT_SECRET_SENTINEL],
  ['authorization code', AUTH_CODE_SENTINEL],
  ['file bytes', FILE_BYTES_SENTINEL],
];

const VERIFICATION_CACHE_MS = 60 * 1000;
const TOKEN_LITERAL = /xox[a-z]-[0-9A-Za-z]{8}/;
const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

let handlers: ToolHandlers;
let logs: ConsoleCapture;
let observations: string[];

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const outcome = await callTool(handlers, name, args);
  observations.push(observedText(outcome));
  return outcome;
}

function expectAbsent(texts: string[], forbidden: Array<[string, string]>, label: string): void {
  const all = texts.join('\n');
  for (const [name, value] of forbidden) {
    expect(all.includes(value), `${label}: ${name}`).toBe(false);
  }
}

function isUploadHostRequest(request: RecordedRequest): boolean {
  return request.apiMethod === undefined;
}

function expectSecretsOnlyWhereTheyBelong(requests: RecordedRequest[]): void {
  for (const request of requests) {
    const where = `${request.httpMethod} ${request.host}${request.path}`;
    const rendered = renderRequest(request);

    expect(`${request.url}\n${request.body}`.includes(TOKEN_SENTINEL), `${where}: token in url or body`).toBe(false);
    const headersWithToken = Object.entries(request.headers)
      .filter(([, value]) => value.includes(TOKEN_SENTINEL))
      .map(([name]) => name);
    if (headersWithToken.length > 0) {
      expect(headersWithToken, `${where}: token header`).toEqual(['authorization']);
      expect(isUploadHostRequest(request), `${where}: token sent to a non-api host`).toBe(false);
    }

    expect(rendered.includes(CLIENT_SECRET_SENTINEL), `${where}: client secret`).toBe(false);
    if (request.apiMethod !== 'oauth.v2.access') {
      expect(rendered.includes(AUTH_CODE_SENTINEL), `${where}: authorization code`).toBe(false);
    }
    if (!isUploadHostRequest(request)) {
      expect(rendered.includes(FILE_BYTES_SENTINEL), `${where}: file bytes`).toBe(false);
    }
    expect(Object.keys(request.headers), `${where}: cookie header`).not.toContain('cookie');
  }
}

function expectCleanRun(label: string): void {
  expectAbsent([...observations, ...logs.lines()], SECRETS, label);
  expectSecretsOnlyWhereTheyBelong(fakeSlackApi.requests);
}

async function startLogin(args: Record<string, unknown> = {}) {
  const outcome = await call('slack_login', args);
  const pending = resultJson(outcome);
  expect(pending.state).toBe('pending');
  const authorizeUrl = new URL(pending.authorize_url);
  return {
    pending,
    state: authorizeUrl.searchParams.get('state') as string,
    redirect: new URL(authorizeUrl.searchParams.get('redirect_uri') as string),
  };
}

function redirectedAddress(redirect: URL, params: Record<string, string>): string {
  return `${redirect.origin}${redirect.pathname}?${new URLSearchParams(params)}`;
}

function exchangeVerifier(): string {
  const exchanges = fakeSlackApi.requestsFor('oauth.v2.access');
  expect(exchanges).toHaveLength(1);
  const verifier = fakeSlackApi.fieldsOf(exchanges[0]).code_verifier as string;
  expect(verifier.length).toBeGreaterThanOrEqual(43);
  return verifier;
}

function advancePastVerificationCache(): void {
  vi.setSystemTime(new Date(Date.now() + VERIFICATION_CACHE_MS + 1000));
}

function sourceFilesOutsideTests(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesOutsideTests(path);
    return path.endsWith('.test.ts') ? [] : [path];
  });
}

beforeEach(() => {
  resetSandbox();
  writeAppConfig();
  fakeSlackApi.reset();
  handlers = new SlackModule().createToolHandlers({ slack: new SlackClient() }) as ToolHandlers;
  logs = captureConsole();
  observations = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await callTool(handlers, 'slack_logout', { revoke: false });
  logs.restore();
  vi.unstubAllGlobals();
});

afterAll(removeSandbox);

describe('login by link', () => {
  it('keeps secrets out of a login completed through the loopback listener', async () => {
    const { pending, state, redirect } = await startLogin();
    expect(pending.completion).toBe('callback');

    const page = await loopbackRequest(
      Number(redirect.port),
      `${redirect.pathname}?${new URLSearchParams({ code: AUTH_CODE_SENTINEL, state })}`,
    );
    observations.push(page.body);

    expect(page.status).toBe(200);
    const status = await eventually(
      () => call('slack_get_status', { verify: false }),
      (outcome) => !outcome.thrown && resultJson(outcome).state === 'connected',
    );
    expect(resultJson(status).state).toBe('connected');
    expectAbsent([...observations, ...logs.lines()], [['code verifier', exchangeVerifier()]], 'callback login');
    expectCleanRun('callback login');
  });

  it('completes a login on its own free port while another process holds the production port', async () => {
    const decoy = await holdProductionPort();
    try {
      const { pending, state, redirect } = await startLogin();
      expect(pending.completion).toBe('callback');
      expect(redirect.port).not.toBe(String(PRODUCTION_CALLBACK_PORT));

      const page = await loopbackRequest(
        Number(redirect.port),
        `${redirect.pathname}?${new URLSearchParams({ code: AUTH_CODE_SENTINEL, state })}`,
      );
      observations.push(page.body);

      expect(decoy.requests, 'requests that reached the other listener').toEqual([]);
      expect(page.status).toBe(200);
      const status = await eventually(
        () => call('slack_get_status', { verify: false }),
        (outcome) => !outcome.thrown && resultJson(outcome).state === 'connected',
      );
      expect(resultJson(status).state).toBe('connected');
      const exchanges = fakeSlackApi.requestsFor('oauth.v2.access');
      expect(exchanges).toHaveLength(1);
      expect(fakeSlackApi.fieldsOf(exchanges[0]).redirect_uri).toBe(redirect.href);
      expectCleanRun('login beside a busy production port');
    } finally {
      await decoy.release();
    }
  });

  it('keeps secrets out of what the listener answers to a wrong state and to stray requests', async () => {
    const { state, redirect } = await startLogin();
    const port = Number(redirect.port);
    const query = (stateValue: string) =>
      `?${new URLSearchParams({ code: AUTH_CODE_SENTINEL, state: stateValue })}`;

    const otherPath = await loopbackRequest(port, `/elsewhere${query(state)}`);
    const otherMethod = await loopbackRequest(port, `${redirect.pathname}${query(state)}`, 'POST');
    const wrongState = await loopbackRequest(port, `${redirect.pathname}${query('wrong-state-value')}`);
    observations.push(otherPath.body, otherMethod.body, wrongState.body);

    expect(otherPath.status).toBe(404);
    expect(otherMethod.status).toBe(404);
    expect(wrongState.body.length).toBeGreaterThan(0);
    expect(fakeSlackApi.requestsFor('oauth.v2.access')).toHaveLength(0);
    expectCleanRun('listener refusals');
  });

  it('keeps secrets out of a login completed by pasting the redirected address', async () => {
    const { state, redirect } = await startLogin();

    const completed = await call('slack_login', {
      redirected_url: redirectedAddress(redirect, { code: AUTH_CODE_SENTINEL, state }),
    });

    expect(resultJson(completed).team_id).toBe(EXAMPLE.teamId);
    expect(tokenFileExists()).toBe(true);
    expectAbsent([...observations, ...logs.lines()], [['code verifier', exchangeVerifier()]], 'paste login');
    expectCleanRun('paste login');
  });

  it('keeps secrets out of a login completed by pasting the bare code', async () => {
    await startLogin();

    const completed = await call('slack_login', { redirected_url: AUTH_CODE_SENTINEL });

    expect(resultJson(completed).team_id).toBe(EXAMPLE.teamId);
    expectCleanRun('bare code login');
  });

  it('does not echo a pasted address or code when the state is unknown or nothing is pending', async () => {
    const { redirect } = await startLogin();
    const unknownState = await call('slack_login', {
      redirected_url: redirectedAddress(redirect, { code: AUTH_CODE_SENTINEL, state: 'unknown-state-value' }),
    });
    await call('slack_logout', { revoke: false });
    await call('slack_login', { redirected_url: AUTH_CODE_SENTINEL });

    expect(unknownState.thrown?.message).toContain('state_mismatch');
    expect(tokenFileExists()).toBe(false);
    expect(fakeSlackApi.requestsFor('oauth.v2.access')).toHaveLength(0);
    expectCleanRun('refused pastes');
  });

  it('keeps secrets out of a code that Slack refuses and out of an unreachable exchange', async () => {
    fakeSlackApi.failSlack('oauth.v2.access', 'invalid_code');
    const first = await startLogin();
    const refused = await call('slack_login', {
      redirected_url: redirectedAddress(first.redirect, { code: AUTH_CODE_SENTINEL, state: first.state }),
    });

    fakeSlackApi.failNetwork('oauth.v2.access');
    const second = await startLogin();
    const unreachable = await call('slack_login', {
      redirected_url: redirectedAddress(second.redirect, { code: AUTH_CODE_SENTINEL, state: second.state }),
    });

    expect(refused.thrown?.message).toContain('exchange_failed');
    expect(refused.thrown?.message).toContain('invalid_code');
    expect(unreachable.thrown?.message).toContain('exchange_failed');
    expect(tokenFileExists()).toBe(false);
    expectCleanRun('failed exchanges');
  });

  it('refuses an app config readable by others without echoing its content', async () => {
    writeAppConfig({ fileMode: 0o644 });

    const login = await call('slack_login');
    const status = await call('slack_get_status');

    expect(login.thrown?.message).toContain('app_not_configured');
    expect(resultJson(status).state).toBe('not_connected');
    expect(resultJson(status).app_configured).toBe(false);
    expectCleanRun('unsafe app config');
  });
});

describe('status', () => {
  it('keeps secrets out of every state', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });

    const notConnected = await call('slack_get_status');
    writeToken();
    const connected = await call('slack_get_status');
    advancePastVerificationCache();
    fakeSlackApi.failSlack('auth.test', 'invalid_auth');
    const expired = await call('slack_get_status');
    advancePastVerificationCache();
    fakeSlackApi.failNetwork('auth.test');
    const unverified = await call('slack_get_status');
    const offline = await call('slack_get_status', { verify: false });

    expect(resultJson(notConnected).state).toBe('not_connected');
    expect(resultJson(connected).state).toBe('connected');
    expect(resultJson(expired).state).toBe('expired');
    expect(resultJson(unverified).state).toBe('unverified');
    expect(resultJson(offline).state).toBe('connected');
    expectCleanRun('status states');
  });
});

describe('reads', () => {
  beforeEach(() => {
    writeToken();
  });

  it('keeps secrets out of successful results', async () => {
    for (const { label, tool, args } of READ_CALLS) {
      const outcome = await call(tool, args);
      expect(outcome.thrown, `${tool} (${label})`).toBeUndefined();
    }

    expectCleanRun('successful reads');
  });

  it('keeps secrets out of the error for a rejected session', async () => {
    fakeSlackApi.failEverySlackMethod('token_revoked');

    for (const { label, tool, args } of READ_CALLS) {
      const outcome = await call(tool, args);
      expect(outcome.thrown?.message, `${tool} (${label})`).toContain('session_rejected');
    }

    expectCleanRun('rejected session');
  });

  it('keeps secrets out of rate-limit and unreachable errors', async () => {
    fakeSlackApi.failHttp('search.messages', 429, { 'retry-after': '7' });
    fakeSlackApi.failHttp('conversations.history', 429, { 'retry-after': '7' });
    const limited = [
      await call('slack_search_messages', { queries: [{ query: 'EXAMPLE' }] }),
      await call('slack_get_messages', { messages: [{ channel: EXAMPLE.channelId }] }),
    ];
    fakeSlackApi.failNetwork('search.messages');
    fakeSlackApi.failNetwork('conversations.history');
    const unreachable = [
      await call('slack_search_messages', { queries: [{ query: 'EXAMPLE' }] }),
      await call('slack_get_messages', { messages: [{ channel: EXAMPLE.channelId }] }),
    ];

    for (const outcome of limited) expect(observedText(outcome)).toContain('rate_limited');
    for (const outcome of unreachable) expect(observedText(outcome)).toContain('unreachable');
    expectCleanRun('failing reads');
  });
});

describe('writes', () => {
  beforeEach(() => {
    writeToken();
  });

  async function prepareAndConfirm(items: Record<string, unknown>[]): Promise<ToolOutcome> {
    const prepared = await call('slack_prepare_write', { items });
    return call('slack_confirm_write', { confirmation_token: resultJson(prepared).confirmation_token });
  }

  it('sends file bytes only to the upload host and keeps every secret out of the results', async () => {
    const path = writeUploadFile('note.txt', `${FILE_BYTES_SENTINEL}\n`);

    const confirmed = await prepareAndConfirm([postItem('hello'), reactItem(), uploadItem(path)]);

    expect(confirmed.thrown).toBeUndefined();
    const uploads = fakeSlackApi.uploadHostRequests();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].body.includes(FILE_BYTES_SENTINEL)).toBe(true);
    expectCleanRun('confirmed writes');
  });

  it('keeps file bytes out of the error when Slack rejects the upload at any step', async () => {
    const path = writeUploadFile('note.txt', `${FILE_BYTES_SENTINEL}\n`);

    fakeSlackApi.failSlack('files.getUploadURLExternal', 'not_allowed_token_type');
    const rejectedUrl = await prepareAndConfirm([uploadItem(path)]);
    fakeSlackApi.resetHandlers();
    fakeSlackApi.failUploadHost(500);
    const rejectedBytes = await prepareAndConfirm([uploadItem(path)]);
    fakeSlackApi.resetHandlers();
    fakeSlackApi.failSlack('files.completeUploadExternal', 'invalid_arguments');
    const rejectedComplete = await prepareAndConfirm([uploadItem(path)]);

    for (const outcome of [rejectedUrl, rejectedBytes, rejectedComplete]) {
      expect(observedText(outcome)).toContain('upload_rejected');
    }
    expectCleanRun('upload rejections');
  });

  it('keeps file bytes out of the error when the file changed after the preview', async () => {
    const path = writeUploadFile('note.txt', `${FILE_BYTES_SENTINEL}-A\n`);
    const prepared = await call('slack_prepare_write', { items: [uploadItem(path)] });
    writeFileSync(path, `${FILE_BYTES_SENTINEL}-B\n`);
    const sameSize = await call('slack_confirm_write', {
      confirmation_token: resultJson(prepared).confirmation_token,
    });

    const preparedAgain = await call('slack_prepare_write', { items: [uploadItem(path)] });
    rmSync(path);
    const removed = await call('slack_confirm_write', {
      confirmation_token: resultJson(preparedAgain).confirmation_token,
    });

    expect(observedText(sameSize)).toContain('file_changed');
    expect(observedText(removed)).toContain('file_changed');
    expectCleanRun('changed files');
  });

  it('keeps secrets out of a post or a reaction that Slack refuses', async () => {
    fakeSlackApi.failSlack('chat.postMessage', 'not_in_channel');
    fakeSlackApi.failSlack('reactions.add', 'already_reacted');

    const confirmed = await prepareAndConfirm([postItem('hello'), reactItem()]);

    expect(observedText(confirmed)).toContain('not_in_channel');
    expectCleanRun('refused writes');
  });
});

describe('logout', () => {
  beforeEach(() => {
    writeToken();
  });

  it('keeps secrets out of a revoking logout, a failed revoke and a local-only logout', async () => {
    const revoked = await call('slack_logout');
    expect(resultJson(revoked).revoked).toBe(true);
    expect(tokenFileExists()).toBe(false);

    writeToken();
    fakeSlackApi.failNetwork('auth.revoke');
    const failedRevoke = await call('slack_logout');
    expect(resultJson(failedRevoke).revoked).toBe(false);
    expect(tokenFileExists()).toBe(false);

    writeToken();
    const requestsBefore = fakeSlackApi.requests.length;
    await call('slack_logout', { revoke: false });
    expect(fakeSlackApi.requests.length).toBe(requestsBefore);

    expectCleanRun('logout');
  });
});

describe('source', () => {
  it('holds no real-looking access token outside tests', () => {
    const files = sourceFilesOutsideTests(SOURCE_ROOT);

    expect(files.some((file) => file.endsWith(join('services', 'slack', 'slack-client.ts')))).toBe(true);
    for (const file of files) {
      expect(TOKEN_LITERAL.test(readFileSync(file, 'utf8')), relative(SOURCE_ROOT, file)).toBe(false);
    }
  });
});
