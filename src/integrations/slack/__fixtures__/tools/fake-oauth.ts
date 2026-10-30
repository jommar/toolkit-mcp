import { vi } from 'vitest';
import { createClock, type FakeClock } from './clock.js';
import { slackFailure } from './fake-slack.js';
import { EXAMPLE_TEAM, USER_ME, type FixtureTeam } from './ids.js';
import { ALL_SCOPES, TOKEN_SENTINEL, seedToken as writeTokenFile } from './home-sandbox.js';

const LOGIN_TTL_MS = 10 * 60 * 1000;

export interface PendingLoginView {
  state: 'pending';
  authorize_url: string;
  expires_at: string;
  completion: 'callback' | 'paste';
}

export interface ConnectedLoginView {
  state: 'connected';
  user_id: string;
  team_id: string;
  team_domain: string;
  next_step: string;
}

/** What Slack hands the login module on approval; it never leaves the module. */
export interface SlackGrant {
  access_token: string;
  scopes: string[];
  team: FixtureTeam;
  user_id: string;
}

export function grantFor(team: FixtureTeam = EXAMPLE_TEAM, accessToken: string = TOKEN_SENTINEL): SlackGrant {
  return {
    access_token: accessToken,
    scopes: [...ALL_SCOPES],
    team,
    user_id: USER_ME,
  };
}

function namesTeam(workspace: string, team: FixtureTeam): boolean {
  return [team.id, team.domain, new URL(team.url).host, team.url].includes(workspace);
}

/**
 * A login module that finishes a login the way a real one does: it writes the token file
 * itself and hands its caller only a non-secret status, and a grant for a team other than the
 * requested workspace is revoked and never stored. It starts a listener on every `startLogin`
 * call and never deduplicates, so a caller that must not start a second listener has to check
 * `getPendingLogin` itself.
 */
export function createFakeOAuth(options: { clock?: FakeClock } = {}) {
  const clock = options.clock ?? createClock();
  let pending: (PendingLoginView & { workspace?: string }) | null = null;
  let listenersStarted = 0;
  let loginsStarted = 0;
  let outcome: SlackGrant | Error = grantFor();

  const startLogin = vi.fn(async (input: { workspace?: string } = {}): Promise<PendingLoginView> => {
    loginsStarted += 1;
    listenersStarted += 1;
    pending = {
      state: 'pending',
      authorize_url: `https://slack.com/oauth/v2/authorize?client_id=CLIENT-ID-FIXTURE&state=state-fixture-${loginsStarted}`,
      expires_at: new Date(clock.now() + LOGIN_TTL_MS).toISOString(),
      completion: 'callback',
      workspace: input.workspace,
    };
    return viewOf(pending);
  });

  const getPendingLogin = vi.fn((): PendingLoginView | null => (pending ? viewOf(pending) : null));

  const cancelLogin = vi.fn(() => {
    pending = null;
  });

  // The login module revokes a wrong-workspace grant itself; the client revokes only the stored token.
  const revokeGrantedToken = vi.fn(async (_accessToken: string): Promise<void> => {});

  const completeLogin = vi.fn(async (_input: { redirected_url: string }): Promise<ConnectedLoginView> => {
    const requestedWorkspace = pending?.workspace;
    pending = null;
    if (outcome instanceof Error) throw outcome;
    const { access_token, scopes, team, user_id } = outcome;
    if (requestedWorkspace && !namesTeam(requestedWorkspace, team)) {
      await revokeGrantedToken(access_token);
      throw slackFailure('wrong_workspace', {
        message: `Slack approved ${team.domain} but ${requestedWorkspace} was requested.`,
      });
    }
    writeTokenFile({ team, scopes, accessToken: access_token, userId: user_id, savedAt: clock.iso() });
    return {
      state: 'connected',
      user_id,
      team_id: team.id,
      team_domain: team.domain,
      next_step: 'Search or read messages with slack_search_messages or slack_get_messages.',
    };
  });

  function viewOf(source: PendingLoginView & { workspace?: string }): PendingLoginView {
    return {
      state: source.state,
      authorize_url: source.authorize_url,
      expires_at: source.expires_at,
      completion: source.completion,
    };
  }

  return {
    oauth: { startLogin, getPendingLogin, cancelLogin, completeLogin },
    revokeGrantedToken,
    setOutcome: (next: SlackGrant | Error) => {
      outcome = next;
    },
    setPending: (view: Partial<PendingLoginView> = {}) => {
      loginsStarted += 1;
      pending = {
        state: 'pending',
        authorize_url: view.authorize_url ?? 'https://slack.com/oauth/v2/authorize?client_id=CLIENT-ID-FIXTURE&state=state-preset',
        expires_at: view.expires_at ?? new Date(clock.now() + LOGIN_TTL_MS).toISOString(),
        completion: view.completion ?? 'callback',
      };
    },
    get listenersStarted() {
      return listenersStarted;
    },
  };
}

export type FakeOAuth = ReturnType<typeof createFakeOAuth>;
