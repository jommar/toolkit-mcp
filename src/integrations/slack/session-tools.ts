import { access } from 'node:fs/promises';
import os from 'node:os';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readAppConfig } from '../../services/slack/app-config.js';
import {
  readCapturedSession,
  readToken,
  removeToken,
  slackPaths,
  writeToken,
  type CapturedSession,
  type SlackPaths,
  type TokenRecord,
} from '../../services/slack/credential-store.js';
import { TOOL_SCOPES } from '../../services/slack/slack-app.js';
import type { createSlackLogin, PendingLoginView } from '../../services/slack/slack-oauth.js';
import type { SlackClient } from '../../services/slack/slack-client.js';

type SlackLogin = ReturnType<typeof createSlackLogin>;

export interface SessionToolContext {
  slack: Pick<SlackClient, 'authTest' | 'authRevoke'>;
  oauth: Pick<SlackLogin, 'startLogin' | 'completeLogin' | 'getPendingLogin' | 'cancelLogin'>;
  now: () => number;
}

export interface LoginArgs {
  workspace?: string;
  redirected_url?: string;
}

export interface LogoutArgs {
  revoke?: boolean;
}

export interface StatusArgs {
  verify?: boolean;
}

export type SessionState =
  | {
      state: 'not_connected';
      app_configured: boolean;
      dashboard_session_available: boolean;
      next_step: string;
    }
  | {
      state: 'pending';
      authorize_url: string;
      expires_at: string;
      completion: 'callback' | 'paste';
      next_step: string;
    }
  | {
      state: 'connected';
      user_id: string;
      team_id: string;
      team_domain: string;
      saved_at: string;
      scopes_missing?: string[];
      next_step: string;
    }
  | { state: 'expired'; team_domain?: string; reason: string; next_step: string }
  | { state: 'unverified'; team_domain: string; next_step: string };

export interface LogoutResult {
  state: 'not_connected';
  revoked: boolean;
  removed: string[];
  next_step: string;
}

type Check = { state: 'connected' } | { state: 'expired'; reason: string } | { state: 'unverified' };

const CHECK_TTL_MS = 60 * 1000;
const REQUIRED_SCOPES: readonly string[] = [...new Set(Object.values(TOOL_SCOPES).flat())];
const LOGIN_STEP = 'Call slack_login to connect a workspace.';
const ADOPT_STEP =
  'Connect Slack in dev-dashboard (it writes ~/.config/slack/session.json), then call slack_login to use ' +
  'that session here.';
const STALE_SESSION_STEP =
  'The captured session no longer works. Reconnect Slack in dev-dashboard, then call slack_login again.';
const READ_STEP =
  'Read Slack with slack_search_messages, slack_get_messages, slack_get_threads or slack_get_channels.';
const CALLBACK_PENDING_STEP =
  'Open authorize_url in a browser and approve the workspace. The login finishes by itself; ' +
  'call slack_get_status to confirm.';
const PASTE_PENDING_STEP =
  'Open authorize_url in a browser and approve the workspace, then call slack_login with redirected_url ' +
  'set to the address the browser lands on.';
const EXPIRED_STEP = 'Call slack_logout, then slack_login to connect again.';
const UNVERIFIED_STEP =
  'Slack could not be reached to check the stored token. Call slack_get_status again, or use a read tool, ' +
  'which reports a rejected session.';
const UNREVOKED_STEP =
  'Slack did not confirm the revoke, so the token may still work there. Remove the app in Slack\'s app ' +
  'settings if needed, then call slack_login.';

// Slack is asked at most once a minute per login; keying on the save time means a new login is always checked.
const checkedTokens = new WeakMap<SessionToolContext, { savedAt: string; checkedAt: number; check: Check }>();

export function slackLoginHandler(ctx: SessionToolContext) {
  return async (args: LoginArgs = {}): Promise<CallToolResult> =>
    jsonResult(await settle(() => login(ctx, slackPaths(os.homedir()), args)));
}

export function slackLogoutHandler(ctx: SessionToolContext) {
  return async (args: LogoutArgs = {}): Promise<CallToolResult> =>
    jsonResult(await settle(() => logout(ctx, slackPaths(os.homedir()), args)));
}

export function slackGetStatusHandler(ctx: SessionToolContext) {
  return async (args: StatusArgs = {}): Promise<CallToolResult> =>
    jsonResult(await sessionStatus(ctx, slackPaths(os.homedir()), args.verify !== false));
}

async function login(ctx: SessionToolContext, paths: SlackPaths, args: LoginArgs): Promise<SessionState> {
  if (args.redirected_url !== undefined) {
    await ctx.oauth.completeLogin({ redirected_url: args.redirected_url });
    return sessionStatus(ctx, paths, false);
  }

  const stored = await readToken(paths);
  if (stored) {
    if (args.workspace !== undefined && !namesWorkspace(args.workspace, stored)) {
      throw slackError(
        'signed_in_elsewhere',
        `The module is signed in to ${stored.team_domain}. Call slack_logout, then slack_login to switch workspace.`,
      );
    }
    return storedSessionState(ctx, stored, true);
  }

  // Nothing of our own is stored, so adopt the web session dev-dashboard already captured, if there is one.
  const captured = await readCapturedSession(paths);
  if (captured) return adoptCapturedSession(ctx, paths, captured, args.workspace);

  const pending = ctx.oauth.getPendingLogin() ?? (await ctx.oauth.startLogin({ workspace: args.workspace }));
  return pendingState(pending);
}

/**
 * Takes the xoxc token and d cookie dev-dashboard captured as this module's login. The copy is verified
 * before it is trusted, and a rejected copy is removed rather than left looking connected.
 */
async function adoptCapturedSession(
  ctx: SessionToolContext,
  paths: SlackPaths,
  captured: CapturedSession,
  workspace: string | undefined,
): Promise<SessionState> {
  if (workspace !== undefined && !namesWorkspace(workspace, captured)) {
    throw slackError(
      'signed_in_elsewhere',
      `The captured Slack session is signed in to ${describeTeam(captured)}. Call slack_login without a ` +
        'workspace to use it, or connect another workspace in dev-dashboard.',
    );
  }

  const adopted: TokenRecord = {
    access_token: captured.token,
    cookie: captured.cookie,
    team_id: captured.team_id,
    team_domain: captured.team_domain,
    team_url: captured.team_domain ? `https://${captured.team_domain}.slack.com/` : '',
    user_id: '',
    saved_at: captured.saved_at,
  };
  await writeToken(paths, adopted);

  let identity: { team_id?: string; user_id?: string; url?: string };
  try {
    identity = await ctx.slack.authTest();
  } catch (error) {
    if (codeOf(error) !== 'session_rejected') {
      return { state: 'unverified', team_domain: adopted.team_domain, next_step: UNVERIFIED_STEP };
    }
    await removeToken(paths);
    return {
      state: 'expired',
      team_domain: adopted.team_domain,
      reason: stringField(error, 'slack_code') ?? codeOf(error),
      next_step: STALE_SESSION_STEP,
    };
  }

  const confirmed: TokenRecord = {
    ...adopted,
    team_id: identity.team_id || adopted.team_id,
    team_domain: domainOfUrl(identity.url) || adopted.team_domain,
    user_id: identity.user_id || adopted.user_id,
  };
  await writeToken(paths, confirmed);
  return connectedState(confirmed);
}

async function logout(ctx: SessionToolContext, paths: SlackPaths, args: LogoutArgs): Promise<LogoutResult> {
  ctx.oauth.cancelLogin();
  const stored = await readToken(paths).catch(() => null);
  const hadToken = stored !== null || (await exists(paths.tokenFile));
  // Slack can revoke an app token it issued; a session adopted from the web client has no such endpoint.
  const attempted = hadToken && !stored?.cookie && args.revoke !== false;
  const revoked = attempted && (await revokeStoredToken(ctx));
  await removeToken(paths);
  return {
    state: 'not_connected',
    revoked,
    removed: hadToken ? ['token.json'] : [],
    next_step: attempted && !revoked ? UNREVOKED_STEP : LOGIN_STEP,
  };
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

// Status never throws: every failure to read or check the session becomes one of its states.
async function sessionStatus(ctx: SessionToolContext, paths: SlackPaths, verify: boolean): Promise<SessionState> {
  let stored: TokenRecord | null;
  try {
    stored = await readToken(paths);
  } catch (error) {
    return { state: 'expired', reason: codeOf(error), next_step: EXPIRED_STEP };
  }
  if (stored) return storedSessionState(ctx, stored, verify);

  const pending = ctx.oauth.getPendingLogin();
  return pending ? pendingState(pending) : notConnectedState(paths);
}

async function storedSessionState(
  ctx: SessionToolContext,
  stored: TokenRecord,
  verify: boolean,
): Promise<SessionState> {
  const check: Check = verify ? await checkStored(ctx, stored) : { state: 'connected' };
  if (check.state === 'expired') {
    return { state: 'expired', team_domain: stored.team_domain, reason: check.reason, next_step: EXPIRED_STEP };
  }
  if (check.state === 'unverified') {
    return { state: 'unverified', team_domain: stored.team_domain, next_step: UNVERIFIED_STEP };
  }
  return connectedState(stored);
}

async function checkStored(ctx: SessionToolContext, stored: TokenRecord): Promise<Check> {
  const cached = checkedTokens.get(ctx);
  if (cached?.savedAt === stored.saved_at && ctx.now() - cached.checkedAt < CHECK_TTL_MS) return cached.check;

  const check = await authCheck(ctx);
  if (check.state !== 'unverified') {
    checkedTokens.set(ctx, { savedAt: stored.saved_at, checkedAt: ctx.now(), check });
  }
  return check;
}

async function authCheck(ctx: SessionToolContext): Promise<Check> {
  try {
    await ctx.slack.authTest();
    return { state: 'connected' };
  } catch (error) {
    if (codeOf(error) !== 'session_rejected') return { state: 'unverified' };
    return { state: 'expired', reason: stringField(error, 'slack_code') ?? codeOf(error) };
  }
}

function connectedState(stored: TokenRecord): SessionState {
  const base = {
    state: 'connected' as const,
    user_id: stored.user_id,
    team_id: stored.team_id,
    team_domain: stored.team_domain,
    saved_at: stored.saved_at,
  };
  // A web session has no granted-scope list: it carries exactly the account's own access.
  if (!stored.scopes) return { ...base, next_step: READ_STEP };
  const granted = new Set<string>(stored.scopes);
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  return { ...base, scopes_missing: missing, next_step: missing.length === 0 ? READ_STEP : scopesStep(missing) };
}

function scopesStep(missing: string[]): string {
  return `Slack did not grant ${missing.join(', ')}. Call slack_logout, then slack_login and approve every scope.`;
}

function pendingState(pending: Omit<PendingLoginView, 'next_step'>): SessionState {
  return {
    state: 'pending',
    authorize_url: pending.authorize_url,
    expires_at: pending.expires_at,
    completion: pending.completion,
    next_step: pending.completion === 'callback' ? CALLBACK_PENDING_STEP : PASTE_PENDING_STEP,
  };
}

async function notConnectedState(paths: SlackPaths): Promise<SessionState> {
  const captured = await readCapturedSession(paths).catch(() => null);
  try {
    await readAppConfig(paths);
    return {
      state: 'not_connected',
      app_configured: true,
      dashboard_session_available: captured !== null,
      next_step: captured ? ADOPT_STEP : LOGIN_STEP,
    };
  } catch (error) {
    const nextStep = stringField(error, 'next_step') ?? `Check ${paths.appFile}, then see docs/slack.md.`;
    return {
      state: 'not_connected',
      app_configured: false,
      dashboard_session_available: captured !== null,
      next_step: captured ? ADOPT_STEP : nextStep,
    };
  }
}

async function revokeStoredToken(ctx: SessionToolContext): Promise<boolean> {
  try {
    await ctx.slack.authRevoke();
    return true;
  } catch {
    return false;
  }
}

// Takes the same forms slack_login takes (team id, domain, host or workspace URL). On a slack.com host the
// first label is the workspace, plain or Enterprise Grid alike.
function namesWorkspace(workspace: string, stored: { team_id: string; team_domain: string }): boolean {
  const value = workspace.trim();
  if (stored.team_id && value === stored.team_id) return true;
  const host = value.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  const domain = /\.slack\.com$/.test(host) ? host.split('.')[0] : host;
  return domain === stored.team_domain;
}

function describeTeam(captured: CapturedSession): string {
  return captured.team_domain || captured.team_id || 'another workspace';
}

// auth.test reports the workspace as a URL; its first label is the domain, Grid hosts included.
function domainOfUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const host = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  if (!host.endsWith('.slack.com')) return undefined;
  return host.split('.')[0] || undefined;
}

async function settle<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw sessionFailure(error);
  }
}

// The login module carries Slack's slack_code on an exchange failure and revoked and next_step on a
// wrong-workspace failure; all of them reach the agent here.
function sessionFailure(error: unknown): McpError {
  const message = error instanceof Error ? error.message : 'The Slack session call failed.';
  const details = (error ?? {}) as { slack_code?: unknown; revoked?: unknown; next_step?: unknown };
  const parts = [message];
  if (typeof details.slack_code === 'string') parts.push(`Slack answered ${details.slack_code}.`);
  if (typeof details.revoked === 'boolean') parts.push(`Revoked with Slack: ${details.revoked ? 'yes' : 'no'}.`);
  if (typeof details.next_step === 'string' && !message.includes(details.next_step)) {
    parts.push(details.next_step);
  }
  return slackError(codeOf(error), parts.join(' '));
}

function slackError(code: string, message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `slack.${code}: ${message}`);
}

function codeOf(error: unknown): string {
  return stringField(error, 'code') ?? 'session_failed';
}

function stringField(source: unknown, field: string): string | undefined {
  const value = ((source ?? {}) as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}
