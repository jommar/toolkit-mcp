import './__fixtures__/tools/home-sandbox.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  SEEDED_SAVED_AT,
  TOKEN_SENTINEL,
  dashboardSessionIntact,
  modeOf,
  readTokenFile,
  removeSandbox,
  resetSandbox,
  sandbox,
  seedAppConfig,
  seedDashboardSession,
  seedToken,
  tokenFileExists,
} from './__fixtures__/tools/home-sandbox.js';
import { FIXTURE_START_ISO, createClock } from './__fixtures__/tools/clock.js';
import { createToolContext } from './__fixtures__/tools/context.js';
import { createFakeOAuth, grantFor } from './__fixtures__/tools/fake-oauth.js';
import { constantRoute, createFakeSlack, slackFailure } from './__fixtures__/tools/fake-slack.js';
import { expectSlackError, parseResult } from './__fixtures__/tools/assertions.js';
import { CHANNEL_ONE, EXAMPLE_TEAM, OTHER_TEAM, USER_ME } from './__fixtures__/tools/ids.js';
import type { AuthTestResponse } from '../../services/slack/slack-client.js';
import { slackGetStatusHandler, slackLoginHandler, slackLogoutHandler } from './session-tools.js';
import { slackGetMessagesHandler } from './read-tools.js';

const AUTH_TEST_BODY: Pick<AuthTestResponse, 'url' | 'team' | 'team_id' | 'user' | 'user_id'> = {
  url: `${EXAMPLE_TEAM.url}/`,
  team: 'Example Team',
  team_id: EXAMPLE_TEAM.id,
  user: 'example-user',
  user_id: USER_ME,
};

const REDIRECTED_ADDRESS = 'http://localhost:8765/slack/oauth/callback?code=fixture-code&state=state-fixture-1';

const FIRST_AUTHORIZE_URL =
  'https://slack.com/oauth/v2/authorize?client_id=CLIENT-ID-FIXTURE&state=state-fixture-1';

let clockOriginHours = 0;

function createHarness() {
  // Each test gets its own clock origin, so nothing keyed on time can carry over between tests.
  clockOriginHours += 1;
  const clock = createClock(
    new Date(Date.parse(FIXTURE_START_ISO) + clockOriginHours * 3_600_000).toISOString(),
  );
  const slack = createFakeSlack({ routes: { 'auth.test': constantRoute(AUTH_TEST_BODY) } });
  const fakeOAuth = createFakeOAuth({ clock });
  const ctx = createToolContext({ slack, clock, oauth: fakeOAuth });
  return { clock, slack, fakeOAuth, ctx };
}

async function statusOf(ctx: unknown, args: Record<string, unknown> = {}) {
  return parseResult(await slackGetStatusHandler(ctx)(args));
}

describe('session tools', () => {
  beforeEach(() => {
    resetSandbox();
  });

  afterAll(() => {
    removeSandbox();
  });

  describe('slack_get_status', () => {
    it('reports not_connected with app_configured false and a step naming the config file and the doc', async () => {
      const { ctx } = createHarness();

      const status = await statusOf(ctx);

      expect(status.state).toBe('not_connected');
      expect(status.app_configured).toBe(false);
      expect(status.next_step).toContain('app.json');
      expect(status.next_step).toContain('docs/slack.md');
    });

    it('reports not_connected with app_configured true and a step naming slack_login', async () => {
      seedAppConfig();
      const { ctx } = createHarness();

      const status = await statusOf(ctx);

      expect(status.state).toBe('not_connected');
      expect(status.app_configured).toBe(true);
      expect(status.next_step).toContain('slack_login');
    });

    it('reports pending with the link, expiry and completion route and a step naming slack_login', async () => {
      seedAppConfig();
      const { ctx, fakeOAuth } = createHarness();
      fakeOAuth.setPending({
        authorize_url: FIRST_AUTHORIZE_URL,
        expires_at: '2031-01-01T00:10:00.000Z',
        completion: 'paste',
      });

      const status = await statusOf(ctx);

      expect(status.state).toBe('pending');
      expect(status.authorize_url).toBe(FIRST_AUTHORIZE_URL);
      expect(status.expires_at).toBe('2031-01-01T00:10:00.000Z');
      expect(status.completion).toBe('paste');
      expect(status.next_step).toContain('slack_login');
    });

    it('reports connected with the workspace, the saved time and no missing scopes', async () => {
      seedToken();
      const { ctx } = createHarness();

      const status = await statusOf(ctx);

      expect(status.state).toBe('connected');
      expect(status.user_id).toBe(USER_ME);
      expect(status.team_id).toBe('T0EXAMPLE1');
      expect(status.team_domain).toBe('example-team');
      expect(status.saved_at).toBe(SEEDED_SAVED_AT);
      expect(status.scopes_missing).toEqual([]);
      expect(status.next_step).toMatch(/slack_(search|get)_[a-z]+/);
    });

    it('lists the required scopes a connected token was not granted', async () => {
      seedToken({ scopes: ALL_SCOPES.filter((scope) => scope !== 'users:read.email') });
      const { ctx } = createHarness();

      const status = await statusOf(ctx);

      expect(status.state).toBe('connected');
      expect(status.scopes_missing).toEqual(['users:read.email']);
    });

    it('reports expired with Slack\'s code when the token was revoked, keeping the token file', async () => {
      seedToken();
      const { ctx, slack } = createHarness();
      slack.setRoute('auth.test', () => {
        throw slackFailure('session_rejected', { slack_code: 'token_revoked' });
      });

      const status = await statusOf(ctx);

      expect(status.state).toBe('expired');
      expect(status.reason).toBe('token_revoked');
      expect(status.next_step).toContain('slack_logout');
      expect(status.next_step).toContain('slack_login');
      expect(tokenFileExists()).toBe(true);
    });

    it('reports unverified when Slack is unreachable, with the token still present', async () => {
      seedToken();
      const { ctx, slack } = createHarness();
      slack.setRoute('auth.test', () => {
        throw slackFailure('unreachable');
      });

      const status = await statusOf(ctx);

      expect(status.state).toBe('unverified');
      expect(typeof status.next_step).toBe('string');
      expect(status.next_step.length).toBeGreaterThan(0);
      expect(tokenFileExists()).toBe(true);
    });

    it('does not throw when the check fails in an unexpected way', async () => {
      seedToken();
      const { ctx, slack } = createHarness();
      slack.setRoute('auth.test', () => {
        throw new TypeError('fixture failure');
      });

      const status = await statusOf(ctx);

      expect(status.state).toBe('unverified');
      expect(status.next_step.length).toBeGreaterThan(0);
    });
  });

  describe('slack_login', () => {
    it('returns the same link and starts one listener when called twice, and a read tool then fails login_pending', async () => {
      seedAppConfig();
      const { ctx, slack, fakeOAuth } = createHarness();
      slack.setRoute('conversations.history', () => {
        throw slackFailure('not_connected');
      });
      const login = slackLoginHandler(ctx);

      const first = parseResult(await login({}));
      const second = parseResult(await login({}));

      expect(first.state).toBe('pending');
      expect(first.authorize_url).toBe(FIRST_AUTHORIZE_URL);
      expect(second.state).toBe('pending');
      expect(second.authorize_url).toBe(FIRST_AUTHORIZE_URL);
      expect(second.expires_at).toBe(first.expires_at);
      expect(second.next_step.length).toBeGreaterThan(0);
      expect(fakeOAuth.oauth.startLogin).toHaveBeenCalledTimes(1);
      expect(fakeOAuth.listenersStarted).toBe(1);

      await expectSlackError(
        () => slackGetMessagesHandler(ctx)({ messages: [{ channel: CHANNEL_ONE }] }),
        'login_pending',
      );
    });

    it('fails signed_in_elsewhere naming the connected workspace when another one is requested', async () => {
      seedToken();
      seedAppConfig();
      const { ctx, fakeOAuth } = createHarness();

      const error = await expectSlackError(
        () => slackLoginHandler(ctx)({ workspace: OTHER_TEAM.domain }),
        'signed_in_elsewhere',
      );

      expect(error.message).toContain(EXAMPLE_TEAM.domain);
      expect(error.message).toContain('slack_logout');
      expect(fakeOAuth.oauth.startLogin).not.toHaveBeenCalled();
    });

    it('treats the Enterprise Grid host of the connected workspace as that same workspace', async () => {
      seedToken();
      seedAppConfig();
      const { ctx, fakeOAuth } = createHarness();

      const status = parseResult(
        await slackLoginHandler(ctx)({ workspace: 'example-team.enterprise.slack.com' }),
      );

      expect(status.state).toBe('connected');
      expect(status.team_domain).toBe(EXAMPLE_TEAM.domain);
      expect(fakeOAuth.oauth.startLogin).not.toHaveBeenCalled();
    });

    it('fails signed_in_elsewhere for the Enterprise Grid host of another workspace', async () => {
      seedToken();
      seedAppConfig();
      const { ctx, fakeOAuth } = createHarness();

      const error = await expectSlackError(
        () => slackLoginHandler(ctx)({ workspace: 'other-team.enterprise.slack.com' }),
        'signed_in_elsewhere',
      );

      expect(error.message).toContain(EXAMPLE_TEAM.domain);
      expect(fakeOAuth.oauth.startLogin).not.toHaveBeenCalled();
    });

    it('revokes the granted token, stores nothing and fails wrong_workspace when the granted team is not the requested one', async () => {
      seedAppConfig();
      const { ctx, fakeOAuth } = createHarness();
      const login = slackLoginHandler(ctx);
      await login({ workspace: OTHER_TEAM.domain });
      fakeOAuth.setOutcome(grantFor(EXAMPLE_TEAM));

      const error = await expectSlackError(
        () => login({ redirected_url: REDIRECTED_ADDRESS }),
        'wrong_workspace',
      );

      expect(error.message).toContain(OTHER_TEAM.domain);
      expect(error.message).toContain(EXAMPLE_TEAM.domain);
      expect(fakeOAuth.revokeGrantedToken).toHaveBeenCalledTimes(1);
      expect(fakeOAuth.revokeGrantedToken).toHaveBeenCalledWith(TOKEN_SENTINEL);
      expect(tokenFileExists()).toBe(false);
    });
  });

  describe('slack_logout', () => {
    it('revokes the token once and only then removes the token file', async () => {
      seedToken();
      seedAppConfig();
      const { ctx, slack } = createHarness();
      let tokenFilePresentWhileRevoking: boolean | undefined;
      slack.client.authRevoke.mockImplementationOnce(async () => {
        tokenFilePresentWhileRevoking = tokenFileExists();
        return { ok: true, revoked: true };
      });

      const result = parseResult(await slackLogoutHandler(ctx)({}));

      expect(slack.client.authRevoke).toHaveBeenCalledTimes(1);
      expect(tokenFilePresentWhileRevoking).toBe(true);
      expect(tokenFileExists()).toBe(false);
      expect(result.state).toBe('not_connected');
      expect(result.revoked).toBe(true);
      expect(result.removed).toContain('token.json');
    });

    it('makes no Slack call when revoke is false and still removes the token file', async () => {
      seedToken();
      const { ctx, slack } = createHarness();

      const result = parseResult(await slackLogoutHandler(ctx)({ revoke: false }));

      for (const method of Object.values(slack.client)) {
        expect(method).not.toHaveBeenCalled();
      }
      expect(tokenFileExists()).toBe(false);
      expect(result.state).toBe('not_connected');
      expect(result.revoked).toBe(false);
    });

    it('still removes the token file and reports revoked false when the revoke fails', async () => {
      seedToken();
      const { ctx, slack } = createHarness();
      slack.client.authRevoke.mockRejectedValueOnce(slackFailure('unreachable'));

      const result = parseResult(await slackLogoutHandler(ctx)({}));

      expect(tokenFileExists()).toBe(false);
      expect(result.state).toBe('not_connected');
      expect(result.revoked).toBe(false);
    });
  });

  describe('dashboard session', () => {
    it('survives login, status and logout untouched', async () => {
      seedAppConfig();
      seedDashboardSession();
      const { ctx, fakeOAuth } = createHarness();
      const login = slackLoginHandler(ctx);

      await login({});
      fakeOAuth.setOutcome(grantFor(EXAMPLE_TEAM));
      const connected = parseResult(await login({ redirected_url: REDIRECTED_ADDRESS }));
      expect(connected.state).toBe('connected');
      expect(connected.team_domain).toBe(EXAMPLE_TEAM.domain);
      expect(modeOf(sandbox.tokenFile)).toBe(0o600);
      expect(readTokenFile()).toMatchObject({
        access_token: TOKEN_SENTINEL,
        team_id: EXAMPLE_TEAM.id,
        team_domain: EXAMPLE_TEAM.domain,
        user_id: USER_ME,
      });
      expect(dashboardSessionIntact()).toBe(true);

      await statusOf(ctx);
      expect(dashboardSessionIntact()).toBe(true);

      await slackLogoutHandler(ctx)({});
      expect(tokenFileExists()).toBe(false);
      expect(dashboardSessionIntact()).toBe(true);
    });
  });
});
