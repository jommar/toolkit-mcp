import { createHash, randomBytes } from 'node:crypto';
import axios from 'axios';
import { readAppConfig } from './app-config.js';
import { writeToken, type SlackPaths, type TokenRecord } from './credential-store.js';
import {
  startCallbackListener,
  type CallbackListener,
  type CallbackOutcome,
  type RedirectParams,
} from './oauth-callback-server.js';
import { OAUTH_REDIRECT_URL, TOOL_SCOPES } from './slack-app.js';

// The authorization code itself lives ten minutes on Slack's side.
const LOGIN_TTL_MS = 10 * 60 * 1000;
const SLACK_API_URL = 'https://slack.com/api/';
const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_REQUEST_TIMEOUT_MS = 15 * 1000;
const STATE_BYTES = 32;
const CODE_VERIFIER_BYTES = 32;
const LOGIN_USER_SCOPES = [...new Set(Object.values(TOOL_SCOPES).flat())];
const TEAM_ID_PATTERN = /^T[A-Z0-9]+$/;
const TEAM_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SLACK_HOST_SUFFIX_PATTERN = /\.slack\.com$/i;
const PASTED_QUERY_PATTERN = /[?=]/;
const PASTE_BASE_URL = 'http://localhost';

const CALLBACK_NEXT_STEP =
  'Open authorize_url in a browser and approve the workspace. ' +
  'The login finishes when Slack redirects to the local listener.';
const PASTE_NEXT_STEP =
  'Open authorize_url in a browser and approve the workspace, then call slack_login with redirected_url ' +
  'set to the address the browser lands on.';
const CONNECTED_NEXT_STEP = 'Use slack_search_messages, slack_get_messages or slack_get_channels to read Slack.';
const RETRY_LOGIN_NEXT_STEP = 'Call slack_login again and approve the workspace you asked for.';
const REMOVE_APP_NEXT_STEP =
  'Ask the user to remove this app from the approved workspace in Slack, because the new token could not be ' +
  'revoked, then call slack_login again.';

export interface StartLoginInput {
  workspace?: string;
}

export interface CompleteLoginInput {
  redirected_url: string;
}

export interface PendingLoginView {
  state: 'pending';
  authorize_url: string;
  expires_at: string;
  completion: 'callback' | 'paste';
  next_step: string;
}

export interface ConnectedLoginView {
  state: 'connected';
  user_id: string;
  team_id: string;
  team_domain: string;
  next_step: string;
}

export interface SlackLoginOptions {
  paths: SlackPaths;
  startListener?: typeof startCallbackListener;
}

interface WorkspaceRef {
  team_id?: string;
  team_domain?: string;
  label: string;
}

interface PendingLogin {
  state: string;
  codeVerifier: string;
  clientId: string;
  authorizeUrl: string;
  expiresAt: number;
  workspace?: WorkspaceRef;
  listener: CallbackListener | null;
}

interface SlackReply {
  ok: boolean;
  error?: string;
}

interface OAuthAccessReply extends SlackReply {
  authed_user?: { access_token?: string; scope?: string };
}

interface AuthTestReply extends SlackReply {
  url?: string;
  team_id?: string;
  user_id?: string;
}

export function createSlackLogin({ paths, startListener = startCallbackListener }: SlackLoginOptions) {
  const slack = axios.create({ baseURL: SLACK_API_URL, timeout: SLACK_REQUEST_TIMEOUT_MS });
  let pending: PendingLogin | null = null;

  async function startLogin({ workspace }: StartLoginInput = {}): Promise<PendingLoginView> {
    const live = livePending();
    if (live) return pendingView(live);

    const { client_id: clientId } = await readAppConfig(paths);
    const requestedWorkspace = workspace === undefined ? undefined : parseWorkspace(workspace);
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const codeVerifier = randomBytes(CODE_VERIFIER_BYTES).toString('base64url');
    const authorizeUrl = buildAuthorizeUrl({
      clientId,
      state,
      codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      teamId: requestedWorkspace?.team_id,
    });
    const listener = await startListener({ ttlMs: LOGIN_TTL_MS, onCallback: finishFromCallback });
    pending = {
      state,
      codeVerifier,
      clientId,
      authorizeUrl,
      expiresAt: Date.now() + LOGIN_TTL_MS,
      workspace: requestedWorkspace,
      listener,
    };
    return pendingView(pending);
  }

  async function completeLogin({ redirected_url: redirectedUrl }: CompleteLoginInput): Promise<ConnectedLoginView> {
    const input = redirectedUrl.trim();
    if (!PASTED_QUERY_PATTERN.test(input)) return finishLogin({ code: input, state: pending?.state });

    const query = new URL(input, PASTE_BASE_URL).searchParams;
    return finishLogin({
      code: query.get('code') ?? undefined,
      state: query.get('state') ?? undefined,
      error: query.get('error') ?? undefined,
    });
  }

  function getPendingLogin(): PendingLoginView | null {
    const live = livePending();
    return live ? pendingView(live) : null;
  }

  function cancelLogin(): void {
    dropPending();
  }

  function livePending(): PendingLogin | null {
    if (pending && Date.now() >= pending.expiresAt) dropPending();
    return pending;
  }

  function dropPending(): void {
    const dropped = pending;
    pending = null;
    void dropped?.listener?.close();
  }

  async function finishFromCallback(params: RedirectParams): Promise<CallbackOutcome> {
    try {
      await finishLogin(params);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: codeOf(error) };
    }
  }

  async function finishLogin(redirect: RedirectParams): Promise<ConnectedLoginView> {
    const login = pending;
    if (!login) throw failure('state_mismatch', 'No login is pending. Start one with slack_login.');
    if (Date.now() >= login.expiresAt) {
      dropPending();
      throw failure('login_expired', 'The login link expired. Start a new login with slack_login.');
    }
    if (redirect.state !== login.state) {
      throw failure('state_mismatch', 'The redirect does not belong to the pending login. Nothing was exchanged.');
    }

    dropPending();
    if (redirect.error) throw exchangeFailed('Slack ended the login without approval.', redirect.error);
    const code = redirect.code;
    if (!code) throw failure('no_authorization_code', 'The redirect carries no authorization code.');

    const exchange = await callSlack<OAuthAccessReply>(
      'oauth.v2.access',
      new URLSearchParams({
        client_id: login.clientId,
        code,
        redirect_uri: OAUTH_REDIRECT_URL,
        code_verifier: login.codeVerifier,
      }),
    );
    const userToken = exchange.authed_user?.access_token;
    if (!exchange.ok || !userToken) throw exchangeFailed('Slack did not complete the login.', exchange.error);

    const identity = await callSlack<AuthTestReply>('auth.test', undefined, userToken);
    if (!identity.ok || !identity.url || !identity.team_id || !identity.user_id) {
      const revoked = await revokeToken(userToken);
      throw exchangeFailed('Slack did not complete the login.', identity.error, revokeOutcome(revoked));
    }

    const record: TokenRecord = {
      access_token: userToken,
      scopes: splitScopes(exchange.authed_user?.scope),
      team_id: identity.team_id,
      team_domain: teamDomainOf(identity.url),
      team_url: identity.url,
      user_id: identity.user_id,
      saved_at: new Date().toISOString(),
    };
    if (login.workspace && !isRequestedWorkspace(login.workspace, record)) {
      const revoked = await revokeToken(userToken);
      throw wrongWorkspace(login.workspace, record.team_domain, revoked);
    }

    await writeToken(paths, record);
    return connectedView(record);
  }

  // The axios error carries the request body, which holds the code and the verifier, so it is not rethrown.
  async function callSlack<T extends SlackReply>(
    method: string,
    body?: URLSearchParams,
    accessToken?: string,
  ): Promise<T> {
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    try {
      const response = await slack.post<T>(method, body, { headers });
      return response.data;
    } catch {
      return { ok: false } as T;
    }
  }

  // Best effort: a token Slack does not revoke is reported to the agent, never stored.
  async function revokeToken(accessToken: string): Promise<boolean> {
    return (await callSlack<SlackReply>('auth.revoke', undefined, accessToken)).ok;
  }

  return { startLogin, completeLogin, getPendingLogin, cancelLogin };
}

interface AuthorizeUrlParts {
  clientId: string;
  state: string;
  codeChallenge: string;
  teamId?: string;
}

function buildAuthorizeUrl(options: AuthorizeUrlParts): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('user_scope', LOGIN_USER_SCOPES.join(','));
  url.searchParams.set('redirect_uri', OAUTH_REDIRECT_URL);
  url.searchParams.set('state', options.state);
  url.searchParams.set('code_challenge', options.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.teamId) url.searchParams.set('team', options.teamId);
  return url.toString();
}

function parseWorkspace(input: string): WorkspaceRef {
  const value = input.trim();
  if (TEAM_ID_PATTERN.test(value)) return { team_id: value, label: value };

  const host = value.replace(/^https?:\/\//i, '').split('/')[0];
  // The first label names the workspace on every slack.com host, Enterprise Grid hosts included.
  const domain = (SLACK_HOST_SUFFIX_PATTERN.test(host) ? host.split('.')[0] : host).toLowerCase();
  if (!TEAM_DOMAIN_PATTERN.test(domain)) {
    throw failure('invalid_workspace', 'Name the workspace by team id (T...), domain, host or workspace URL.');
  }
  return { team_domain: domain, label: domain };
}

function isRequestedWorkspace(requested: WorkspaceRef, approved: TokenRecord): boolean {
  return requested.team_id === undefined
    ? requested.team_domain === approved.team_domain
    : requested.team_id === approved.team_id;
}

function teamDomainOf(teamUrl: string): string {
  return new URL(teamUrl).hostname.split('.')[0];
}

function splitScopes(scope: string | undefined): string[] {
  return (scope ?? '').split(',').filter((name) => name.length > 0);
}

function pendingView(login: PendingLogin): PendingLoginView {
  const completion = login.listener ? 'callback' : 'paste';
  return {
    state: 'pending',
    authorize_url: login.authorizeUrl,
    expires_at: new Date(login.expiresAt).toISOString(),
    completion,
    next_step: completion === 'callback' ? CALLBACK_NEXT_STEP : PASTE_NEXT_STEP,
  };
}

function connectedView(record: TokenRecord): ConnectedLoginView {
  return {
    state: 'connected',
    user_id: record.user_id,
    team_id: record.team_id,
    team_domain: record.team_domain,
    next_step: CONNECTED_NEXT_STEP,
  };
}

function wrongWorkspace(requested: WorkspaceRef, approvedDomain: string, revoked: boolean): Error {
  return failure('wrong_workspace', `Slack approved ${approvedDomain}, not ${requested.label}. Nothing was stored.`, {
    ...revokeOutcome(revoked),
  });
}

function exchangeFailed(message: string, slackCode?: string, details: Record<string, unknown> = {}): Error {
  return failure('exchange_failed', message, { slack_code: slackCode, ...details });
}

function revokeOutcome(revoked: boolean): { revoked: boolean; next_step: string } {
  return { revoked, next_step: revoked ? RETRY_LOGIN_NEXT_STEP : REMOVE_APP_NEXT_STEP };
}

function failure(code: string, message: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...details });
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'login_failed';
}
