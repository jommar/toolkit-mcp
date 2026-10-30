import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', async () => (await import('./__fixtures__/axios-harness.js')).createAxiosModuleMock());

const childProcessSpies = vi.hoisted(() => ({
  spawn: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
  fork: vi.fn(),
  spawnSync: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({ ...childProcessSpies, default: childProcessSpies }));

import { createSlackLogin } from './slack-oauth.js';
import { OAUTH_REDIRECT_URL, TOOL_SCOPES } from './slack-app.js';
import { axiosHarness, forbidFetch, slackFailure, slackOk, type HarnessReply } from './__fixtures__/axios-harness.js';
import { createTempHome, permissionBits, writeAppConfigFile, type TempHome } from './__fixtures__/temp-home.js';
import { settle } from './__fixtures__/settle.js';
import {
  ALL_USER_SCOPES,
  AUTH_CODE_SENTINEL,
  CLIENT_ID_FIXTURE,
  CLIENT_SECRET_SENTINEL,
  EXAMPLE_TEAM,
  OTHER_TEAM,
  TOKEN_SENTINEL,
  USER_ID,
} from './__fixtures__/synthetic.js';

const LOGIN_TTL_MS = 10 * 60 * 1000;
const FROZEN_NOW = '2026-10-30T12:00:00.000Z';

type CallbackParams = { code?: string; state?: string; error?: string };
interface StartedListener {
  options: { ttlMs?: number; onCallback: (params: CallbackParams) => Promise<{ ok: boolean; code?: string }> };
  close: ReturnType<typeof vi.fn>;
}

function fakeListeners(options: { busy?: boolean } = {}) {
  const started: StartedListener[] = [];
  const startListener = vi.fn(async (listenerOptions: StartedListener['options']) => {
    if (options.busy) return null;
    const close = vi.fn(async () => undefined);
    started.push({ options: listenerOptions, close });
    return { port: 53682, close };
  });
  return { startListener, started };
}

function slackLoginReplies() {
  axiosHarness.respondBySlackMethod({
    'oauth.v2.access': slackOk({
      authed_user: {
        id: USER_ID,
        access_token: TOKEN_SENTINEL,
        scope: 'search:read,channels:history',
        token_type: 'user',
      },
      team: { id: EXAMPLE_TEAM.team_id, name: 'Example Team' },
    }),
    'auth.test': slackOk({
      url: EXAMPLE_TEAM.team_url,
      team: 'Example Team',
      team_id: EXAMPLE_TEAM.team_id,
      user_id: USER_ID,
    }),
  });
}

interface ApprovedTeam {
  team_id: string;
  team_domain: string;
  team_url: string;
  user_id: string;
}

function slackRepliesApprovedBy(team: ApprovedTeam, extraReplies: Record<string, HarnessReply> = {}) {
  axiosHarness.respondBySlackMethod({
    'oauth.v2.access': slackOk({
      authed_user: {
        id: team.user_id,
        access_token: TOKEN_SENTINEL,
        scope: 'search:read,channels:history',
        token_type: 'user',
      },
      team: { id: team.team_id, name: team.team_domain },
    }),
    'auth.test': slackOk({ url: team.team_url, team: team.team_domain, team_id: team.team_id, user_id: team.user_id }),
    'auth.revoke': slackOk({ revoked: true }),
    ...extraReplies,
  });
}

function redirectedUrl(state: string, code = AUTH_CODE_SENTINEL): string {
  return `${OAUTH_REDIRECT_URL}?code=${code}&state=${state}`;
}

function sentParameters(slackMethod: string) {
  const [request] = axiosHarness.requestsFor(slackMethod);
  return { request, sent: { ...request.params, ...request.bodyParams } as Record<string, string> };
}

function codeOf(error: unknown): unknown {
  return (error as { code?: unknown } | undefined)?.code;
}

describe('slack login by link', () => {
  let temp: TempHome;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(FROZEN_NOW));
    forbidFetch();
    axiosHarness.reset();
    slackLoginReplies();
    temp = createTempHome();
    writeAppConfigFile(temp);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    temp.cleanup();
  });

  function newLogin(listenerOptions: { busy?: boolean } = {}) {
    const listeners = fakeListeners(listenerOptions);
    const login = createSlackLogin({ paths: temp.paths, startListener: listeners.startListener } as any);
    return { login, ...listeners };
  }

  async function startedLogin(workspace?: string, listenerOptions: { busy?: boolean } = {}) {
    const harness = newLogin(listenerOptions);
    const pending = await harness.login.startLogin(workspace ? { workspace } : {});
    const link = new URL(pending.authorize_url);
    return { ...harness, pending, link, state: link.searchParams.get('state') as string };
  }

  describe('startLogin', () => {
    it('returns a pending result with the authorize link, the expiry, the callback completion route and a next step', async () => {
      const { pending, started } = await startedLogin();

      expect(pending.state).toBe('pending');
      expect(pending.completion).toBe('callback');
      expect(new Date(pending.expires_at).getTime()).toBe(Date.now() + LOGIN_TTL_MS);
      expect(pending.next_step.length).toBeGreaterThan(0);
      expect(started).toHaveLength(1);
      expect(started[0].options.ttlMs).toBe(LOGIN_TTL_MS);
    });

    it('builds the Slack authorize link with the client id, the scope union, the redirect URL and an S256 challenge', async () => {
      const { link } = await startedLogin();

      expect(`${link.origin}${link.pathname}`).toBe('https://slack.com/oauth/v2/authorize');
      expect(link.searchParams.get('client_id')).toBe(CLIENT_ID_FIXTURE);
      expect(link.searchParams.get('redirect_uri')).toBe(OAUTH_REDIRECT_URL);
      expect(link.searchParams.get('code_challenge_method')).toBe('S256');
      expect(link.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect([...(link.searchParams.get('user_scope') ?? '').split(',')].sort()).toEqual([...ALL_USER_SCOPES].sort());
      expect([...(link.searchParams.get('user_scope') ?? '').split(',')].sort()).toEqual(
        [...new Set(Object.values(TOOL_SCOPES).flat())].sort(),
      );
    });

    it('uses a state of at least 128 bits that differs between logins', async () => {
      const first = await startedLogin();
      const second = await startedLogin();

      expect(Buffer.from(first.state, 'base64url').length).toBeGreaterThanOrEqual(16);
      expect(second.state).not.toBe(first.state);
    });

    it('sends a team hint only when the workspace is a team id', async () => {
      const byId = await startedLogin(EXAMPLE_TEAM.team_id);
      const byDomain = await startedLogin(EXAMPLE_TEAM.team_domain);

      expect(byId.link.searchParams.get('team')).toBe(EXAMPLE_TEAM.team_id);
      expect(byDomain.link.searchParams.has('team')).toBe(false);
    });

    it('returns the same link and starts no second listener while a login is pending', async () => {
      const { login, pending, startListener } = await startedLogin();

      const again = await login.startLogin({});

      expect(again.authorize_url).toBe(pending.authorize_url);
      expect(startListener).toHaveBeenCalledTimes(1);
    });

    it('falls back to paste completion when the loopback port is busy', async () => {
      const { pending, startListener } = await startedLogin(undefined, { busy: true });

      expect(startListener).toHaveBeenCalledTimes(1);
      expect(pending.state).toBe('pending');
      expect(pending.completion).toBe('paste');
      expect(pending.authorize_url).toContain('https://slack.com/oauth/v2/authorize');
    });

    it('fails app_not_configured without starting a listener when there is no app config', async () => {
      fs.rmSync(temp.paths.appFile);
      const { login, startListener } = newLogin();

      const outcome = await settle(() => login.startLogin({}));

      expect(codeOf(outcome.error)).toBe('app_not_configured');
      expect(startListener).not.toHaveBeenCalled();
    });
  });

  describe('the token exchange', () => {
    it('makes one oauth.v2.access call with the code verifier that matches the challenge and no client secret', async () => {
      writeAppConfigFile(temp, { client_id: CLIENT_ID_FIXTURE, client_secret: CLIENT_SECRET_SENTINEL });
      const { login, link, state } = await startedLogin();

      await login.completeLogin({ redirected_url: redirectedUrl(state) });

      expect(axiosHarness.requestsFor('oauth.v2.access')).toHaveLength(1);
      const { request, sent } = sentParameters('oauth.v2.access');
      expect(request.url).toBe('https://slack.com/api/oauth.v2.access');
      expect(sent).toMatchObject({
        client_id: CLIENT_ID_FIXTURE,
        code: AUTH_CODE_SENTINEL,
        redirect_uri: OAUTH_REDIRECT_URL,
      });
      expect(createHash('sha256').update(sent.code_verifier).digest('base64url')).toBe(
        link.searchParams.get('code_challenge'),
      );
      expect(sent).not.toHaveProperty('client_secret');
      expect(Object.keys(request.headers)).not.toContain('authorization');
      expect(JSON.stringify(request)).not.toContain(CLIENT_SECRET_SENTINEL);
      expect(link.toString()).not.toContain(sent.code_verifier);
    });

    it('writes the token record 0600 with the workspace taken from auth.test and returns the connected workspace', async () => {
      const { login, state } = await startedLogin();

      const connected = await login.completeLogin({ redirected_url: redirectedUrl(state) });

      expect(connected).toMatchObject({
        state: 'connected',
        user_id: USER_ID,
        team_id: EXAMPLE_TEAM.team_id,
        team_domain: EXAMPLE_TEAM.team_domain,
      });
      expect(permissionBits(temp.paths.tokenFile)).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(temp.paths.tokenFile, 'utf8'))).toMatchObject({
        access_token: TOKEN_SENTINEL,
        scopes: ['search:read', 'channels:history'],
        team_id: EXAMPLE_TEAM.team_id,
        team_domain: EXAMPLE_TEAM.team_domain,
        team_url: EXAMPLE_TEAM.team_url,
        user_id: USER_ID,
      });
      const [authTest] = axiosHarness.requestsFor('auth.test');
      expect(authTest.headers.authorization).toBe(`Bearer ${TOKEN_SENTINEL}`);
    });
  });

  describe('completion by the callback listener', () => {
    it('exchanges once for the right state, writes a 0600 token file and closes the listener', async () => {
      const { started, state } = await startedLogin();

      const outcome = await started[0].options.onCallback({ code: AUTH_CODE_SENTINEL, state });

      expect(outcome).toMatchObject({ ok: true });
      expect(axiosHarness.requestsFor('oauth.v2.access')).toHaveLength(1);
      expect(permissionBits(temp.paths.tokenFile)).toBe(0o600);
      expect(started[0].close).toHaveBeenCalled();
    });

    it('answers state_mismatch and exchanges nothing for a wrong state', async () => {
      const { started } = await startedLogin();

      const outcome = await started[0].options.onCallback({ code: AUTH_CODE_SENTINEL, state: 'not-the-pending-state' });

      expect(outcome).toMatchObject({ ok: false, code: 'state_mismatch' });
      expect(axiosHarness.requestsFor('oauth.v2.access')).toHaveLength(0);
      expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
    });

    it('answers state_mismatch for a state that was already used and exchanges only once', async () => {
      const { started, state } = await startedLogin();
      await started[0].options.onCallback({ code: AUTH_CODE_SENTINEL, state });

      const replay = await started[0].options.onCallback({ code: AUTH_CODE_SENTINEL, state });

      expect(replay).toMatchObject({ ok: false, code: 'state_mismatch' });
      expect(axiosHarness.requestsFor('oauth.v2.access')).toHaveLength(1);
    });

    it('answers exchange_failed and writes nothing when Slack rejects the code', async () => {
      const { started, state } = await startedLogin();
      axiosHarness.respondBySlackMethod({ 'oauth.v2.access': slackFailure('invalid_code') });

      const outcome = await started[0].options.onCallback({ code: AUTH_CODE_SENTINEL, state });

      expect(outcome).toMatchObject({ ok: false, code: 'exchange_failed' });
      expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
    });
  });

  describe('completion by pasting', () => {
    it('completes from the pasted redirected address', async () => {
      const { login, state } = await startedLogin();

      const connected = await login.completeLogin({ redirected_url: redirectedUrl(state) });

      expect(connected.state).toBe('connected');
      expect(fs.existsSync(temp.paths.tokenFile)).toBe(true);
    });

    it('completes from a pasted bare code while exactly one login is pending', async () => {
      const { login } = await startedLogin(undefined, { busy: true });

      const connected = await login.completeLogin({ redirected_url: AUTH_CODE_SENTINEL });

      expect(connected.state).toBe('connected');
      expect(sentParameters('oauth.v2.access').sent.code).toBe(AUTH_CODE_SENTINEL);
      expect(fs.existsSync(temp.paths.tokenFile)).toBe(true);
    });

    it('fails state_mismatch and exchanges nothing for a pasted address with another state', async () => {
      const { login } = await startedLogin();

      const outcome = await settle(() => login.completeLogin({ redirected_url: redirectedUrl('not-the-pending-state') }));

      expect(codeOf(outcome.error)).toBe('state_mismatch');
      expect(axiosHarness.requestsFor('oauth.v2.access')).toHaveLength(0);
    });

    it('fails state_mismatch when the same address is pasted twice and exchanges only once', async () => {
      const { login, state } = await startedLogin();
      await login.completeLogin({ redirected_url: redirectedUrl(state) });

      const outcome = await settle(() => login.completeLogin({ redirected_url: redirectedUrl(state) }));

      expect(codeOf(outcome.error)).toBe('state_mismatch');
      expect(axiosHarness.requestsFor('oauth.v2.access')).toHaveLength(1);
    });
  });

  describe('the ten minute TTL', () => {
    it('fails a late callback with login_expired and exchanges nothing', async () => {
      const { started, state } = await startedLogin();

      await vi.advanceTimersByTimeAsync(LOGIN_TTL_MS + 1000);
      const outcome = await started[0].options.onCallback({ code: AUTH_CODE_SENTINEL, state });

      expect(outcome).toMatchObject({ ok: false, code: 'login_expired' });
      expect(axiosHarness.requestsFor('oauth.v2.access')).toHaveLength(0);
    });

    it('fails a late paste with login_expired', async () => {
      const { login, state } = await startedLogin();

      await vi.advanceTimersByTimeAsync(LOGIN_TTL_MS + 1000);
      const outcome = await settle(() => login.completeLogin({ redirected_url: redirectedUrl(state) }));

      expect(codeOf(outcome.error)).toBe('login_expired');
      expect(axiosHarness.requestsFor('oauth.v2.access')).toHaveLength(0);
    });
  });

  describe('exchange failures', () => {
    it.each(['invalid_code', 'bad_redirect_uri'])(
      'rejects exchange_failed carrying Slack\'s %s code and writes no token',
      async (slackCode) => {
        const { login, state } = await startedLogin();
        axiosHarness.respondBySlackMethod({ 'oauth.v2.access': slackFailure(slackCode) });

        const outcome = await settle(() => login.completeLogin({ redirected_url: redirectedUrl(state) }));

        expect(outcome.error).toMatchObject({ code: 'exchange_failed', slack_code: slackCode });
        expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
      },
    );

    it('rejects exchange_failed and writes no token when the network fails', async () => {
      const { login, state } = await startedLogin();
      axiosHarness.respond(() => ({ networkError: 'ECONNRESET' }));

      const outcome = await settle(() => login.completeLogin({ redirected_url: redirectedUrl(state) }));

      expect(codeOf(outcome.error)).toBe('exchange_failed');
      expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
    });

    it('clears the pending login, so the next start issues a fresh link and listener', async () => {
      const { login, pending, state, startListener } = await startedLogin();
      axiosHarness.respondBySlackMethod({ 'oauth.v2.access': slackFailure('invalid_code') });
      await settle(() => login.completeLogin({ redirected_url: redirectedUrl(state) }));

      const fresh = await login.startLogin({});

      expect(fresh.authorize_url).not.toBe(pending.authorize_url);
      expect(startListener).toHaveBeenCalledTimes(2);
    });
  });

  describe('a failed identity check after a good exchange', () => {
    const IDENTITY_CHECK_FAILURES: Array<{ failure: string; reply: HarnessReply }> = [
      { failure: 'auth.test answers with an error', reply: slackFailure('invalid_auth') },
      { failure: 'the network fails during auth.test', reply: { networkError: 'ECONNRESET' } },
      {
        failure: 'auth.test omits the workspace url',
        reply: slackOk({ team_id: EXAMPLE_TEAM.team_id, user_id: EXAMPLE_TEAM.user_id }),
      },
      {
        failure: 'auth.test omits the team id',
        reply: slackOk({ url: EXAMPLE_TEAM.team_url, user_id: EXAMPLE_TEAM.user_id }),
      },
      {
        failure: 'auth.test omits the user id',
        reply: slackOk({ url: EXAMPLE_TEAM.team_url, team_id: EXAMPLE_TEAM.team_id }),
      },
    ];
    const FAILED_REVOKES: Array<{ failure: string; reply: HarnessReply }> = [
      { failure: 'Slack answers the revoke with an error', reply: slackFailure('invalid_auth') },
      { failure: 'the network fails during the revoke', reply: { networkError: 'ECONNRESET' } },
    ];

    async function completeWithIdentityCheck(
      identityReply: HarnessReply,
      revokeReply: HarnessReply = slackOk({ revoked: true }),
    ) {
      const harness = await startedLogin();
      slackRepliesApprovedBy(EXAMPLE_TEAM, { 'auth.test': identityReply, 'auth.revoke': revokeReply });
      const outcome = await settle(() => harness.login.completeLogin({ redirected_url: redirectedUrl(harness.state) }));
      return { ...harness, outcome };
    }

    function exposedText(error: any): string {
      return [error.message, JSON.stringify(error)].join('\n');
    }

    it.each(IDENTITY_CHECK_FAILURES)('revokes the new token once and stores nothing when $failure', async ({ reply }) => {
      await completeWithIdentityCheck(reply);

      const revokes = axiosHarness.requestsFor('auth.revoke');
      expect(revokes).toHaveLength(1);
      expect(revokes[0].url).toBe('https://slack.com/api/auth.revoke');
      expect(revokes[0].headers.authorization).toBe(`Bearer ${TOKEN_SENTINEL}`);
      expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
      expect(fs.readdirSync(temp.paths.dir)).toEqual(['app.json']);
    });

    it.each(IDENTITY_CHECK_FAILURES)(
      'fails exchange_failed with revoked true and a next step to log in again, naming no secret, when $failure',
      async ({ reply }) => {
        const { outcome } = await completeWithIdentityCheck(reply);

        expect(outcome.error).toMatchObject({ code: 'exchange_failed', revoked: true });
        expect(outcome.error.next_step).toEqual(expect.stringContaining('slack_login'));
        expect(exposedText(outcome.error)).not.toContain(TOKEN_SENTINEL);
        expect(exposedText(outcome.error)).not.toContain(AUTH_CODE_SENTINEL);
      },
    );

    it('clears the pending login, so the next start issues a fresh link and listener', async () => {
      const { login, pending, startListener } = await completeWithIdentityCheck(slackFailure('invalid_auth'));

      const fresh = await login.startLogin({});

      expect(fresh.authorize_url).not.toBe(pending.authorize_url);
      expect(startListener).toHaveBeenCalledTimes(2);
    });

    it('answers the callback listener exchange_failed after revoking the new token and storing nothing', async () => {
      const { started, state } = await startedLogin();
      slackRepliesApprovedBy(EXAMPLE_TEAM, { 'auth.test': slackFailure('invalid_auth') });

      const outcome = await started[0].options.onCallback({ code: AUTH_CODE_SENTINEL, state });

      expect(outcome).toMatchObject({ ok: false, code: 'exchange_failed' });
      expect(axiosHarness.requestsFor('auth.revoke')).toHaveLength(1);
      expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
    });

    describe('when the revoke itself fails', () => {
      it.each(FAILED_REVOKES)(
        'stores nothing, reports revoked false and tells the user to remove the app authorization when $failure',
        async ({ reply }) => {
          const { outcome } = await completeWithIdentityCheck(slackFailure('invalid_auth'), reply);

          expect(outcome.error).toMatchObject({ code: 'exchange_failed', revoked: false });
          expect(outcome.error.next_step).toEqual(expect.stringMatching(/remove/i));
          expect(axiosHarness.requestsFor('auth.revoke')).not.toHaveLength(0);
          expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
          expect(fs.readdirSync(temp.paths.dir)).toEqual(['app.json']);
          expect(exposedText(outcome.error)).not.toContain(TOKEN_SENTINEL);
          expect(exposedText(outcome.error)).not.toContain(AUTH_CODE_SENTINEL);
        },
      );
    });
  });

  describe('choosing a workspace at login', () => {
    const REQUESTED_EXAMPLE_TEAM_AS = [
      { form: 'team id', workspace: 'T0EXAMPLE1', namedInError: 'T0EXAMPLE1' },
      { form: 'bare domain', workspace: 'example-team', namedInError: 'example-team' },
      { form: 'host', workspace: 'example-team.slack.com', namedInError: 'example-team' },
      { form: 'workspace URL', workspace: 'https://example-team.slack.com/', namedInError: 'example-team' },
      {
        form: 'workspace URL with a path',
        workspace: 'https://example-team.slack.com/archives/C0EXAMPLE01',
        namedInError: 'example-team',
      },
      { form: 'Enterprise Grid host', workspace: 'example-team.enterprise.slack.com', namedInError: 'example-team' },
      {
        form: 'Enterprise Grid workspace URL',
        workspace: 'https://example-team.enterprise.slack.com/',
        namedInError: 'example-team',
      },
    ];

    async function completeApprovedBy(
      team: ApprovedTeam,
      workspace?: string,
      extraReplies: Record<string, HarnessReply> = {},
    ) {
      const harness = await startedLogin(workspace);
      slackRepliesApprovedBy(team, extraReplies);
      const outcome = await settle(() => harness.login.completeLogin({ redirected_url: redirectedUrl(harness.state) }));
      return { ...harness, outcome };
    }

    function textExposedBy(error: any): string {
      return [error.message, JSON.stringify(error)].join('\n');
    }

    describe('when the workspace value does not name a workspace', () => {
      it.each(['not a workspace!', '-leading-hyphen'])(
        'fails invalid_workspace for %j without starting a listener or a pending login',
        async (workspace) => {
          const { login, startListener } = newLogin();

          const outcome = await settle(() => login.startLogin({ workspace }));

          expect(codeOf(outcome.error)).toBe('invalid_workspace');
          expect(startListener).not.toHaveBeenCalled();
          expect(login.getPendingLogin()).toBeNull();
        },
      );
    });

    describe('when the approved team is not the requested workspace', () => {
      it.each(REQUESTED_EXAMPLE_TEAM_AS)(
        'fails wrong_workspace naming both workspaces and no secret when the workspace is given as a $form',
        async ({ workspace, namedInError }) => {
          const { outcome } = await completeApprovedBy(OTHER_TEAM, workspace);

          expect(codeOf(outcome.error)).toBe('wrong_workspace');
          expect(outcome.error.message).toContain(namedInError);
          expect(outcome.error.message).toContain('other-team');
          expect(textExposedBy(outcome.error)).not.toContain(TOKEN_SENTINEL);
          expect(textExposedBy(outcome.error)).not.toContain(AUTH_CODE_SENTINEL);
        },
      );

      it.each(REQUESTED_EXAMPLE_TEAM_AS)(
        'revokes the new token once and stores nothing when the workspace is given as a $form',
        async ({ workspace }) => {
          await completeApprovedBy(OTHER_TEAM, workspace);

          const revokes = axiosHarness.requestsFor('auth.revoke');
          expect(revokes).toHaveLength(1);
          expect(revokes[0].url).toBe('https://slack.com/api/auth.revoke');
          expect(revokes[0].headers.authorization).toBe(`Bearer ${TOKEN_SENTINEL}`);
          expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
          expect(fs.readdirSync(temp.paths.dir)).toEqual(['app.json']);
        },
      );

      it('clears the pending login, so the next start issues a fresh link and listener', async () => {
        const { login, pending, startListener } = await completeApprovedBy(OTHER_TEAM, 'example-team');

        const fresh = await login.startLogin({});

        expect(fresh.authorize_url).not.toBe(pending.authorize_url);
        expect(startListener).toHaveBeenCalledTimes(2);
      });

      it('answers the callback listener wrong_workspace after revoking the new token and storing nothing', async () => {
        const { started, state } = await startedLogin('example-team');
        slackRepliesApprovedBy(OTHER_TEAM);

        const outcome = await started[0].options.onCallback({ code: AUTH_CODE_SENTINEL, state });

        expect(outcome).toMatchObject({ ok: false, code: 'wrong_workspace' });
        expect(axiosHarness.requestsFor('auth.revoke')).toHaveLength(1);
        expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
      });

      it.each([
        { failure: 'Slack answers the revoke with an error', reply: slackFailure('invalid_auth') },
        { failure: 'the network fails during the revoke', reply: { networkError: 'ECONNRESET' } },
      ])('still stores nothing and fails wrong_workspace when $failure', async ({ reply }) => {
        const { outcome } = await completeApprovedBy(OTHER_TEAM, 'example-team', { 'auth.revoke': reply });

        expect(codeOf(outcome.error)).toBe('wrong_workspace');
        expect(axiosHarness.requestsFor('auth.revoke')).not.toHaveLength(0);
        expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
        expect(fs.readdirSync(temp.paths.dir)).toEqual(['app.json']);
        expect(textExposedBy(outcome.error)).not.toContain(TOKEN_SENTINEL);
        expect(textExposedBy(outcome.error)).not.toContain(AUTH_CODE_SENTINEL);
      });
    });

    describe('when the approved team is the requested workspace', () => {
      it.each(REQUESTED_EXAMPLE_TEAM_AS)(
        'writes the token with the auth.test team fields and never revokes when the workspace is given as a $form',
        async ({ workspace }) => {
          const { outcome } = await completeApprovedBy(EXAMPLE_TEAM, workspace);

          expect(outcome.threw).toBe(false);
          expect(JSON.parse(fs.readFileSync(temp.paths.tokenFile, 'utf8'))).toMatchObject({
            access_token: TOKEN_SENTINEL,
            team_id: 'T0EXAMPLE1',
            team_domain: 'example-team',
            team_url: 'https://example-team.slack.com/',
            user_id: 'U0EXAMPLE01',
          });
          expect(axiosHarness.requestsFor('auth.revoke')).toHaveLength(0);
        },
      );
    });

    describe('when no workspace is given', () => {
      it.each([
        {
          approved: 'example-team',
          team: EXAMPLE_TEAM,
          stored: { team_id: 'T0EXAMPLE1', team_domain: 'example-team', team_url: 'https://example-team.slack.com/' },
        },
        {
          approved: 'other-team',
          team: OTHER_TEAM,
          stored: { team_id: 'T0EXAMPLE2', team_domain: 'other-team', team_url: 'https://other-team.slack.com/' },
        },
      ])('writes the token for the approved team $approved and never revokes', async ({ team, stored }) => {
        const { outcome } = await completeApprovedBy(team);

        expect(outcome.threw).toBe(false);
        expect(JSON.parse(fs.readFileSync(temp.paths.tokenFile, 'utf8'))).toMatchObject({
          access_token: TOKEN_SENTINEL,
          ...stored,
        });
        expect(axiosHarness.requestsFor('auth.revoke')).toHaveLength(0);
      });
    });
  });

  describe('no child process', () => {
    it('calls spawn, exec, execFile and fork zero times across a whole login', async () => {
      const { login, state } = await startedLogin();
      await login.completeLogin({ redirected_url: redirectedUrl(state) });

      for (const spy of Object.values(childProcessSpies)) expect(spy).not.toHaveBeenCalled();
    });

    it.each(['slack-oauth.ts', 'oauth-callback-server.ts', 'app-config.ts'])('%s does not import node:child_process', (file) => {
      const source = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');

      expect(source).not.toMatch(/(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]/);
    });
  });
});
