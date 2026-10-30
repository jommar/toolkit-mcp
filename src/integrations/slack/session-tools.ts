import { access } from 'node:fs/promises';
import os from 'node:os';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readAppConfig } from '../../services/slack/app-config.js';
import {
  readToken,
  removeToken,
  slackPaths,
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
  | { state: 'not_connected'; app_configured: boolean; next_step: string }
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
      scopes_missing: string[];
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

  const pending = ctx.oauth.getPendingLogin() ?? (await ctx.oauth.startLogin({ workspace: args.workspace }));
  return pendingState(pending);
}

async function logout(ctx: SessionToolContext, paths: SlackPaths, args: LogoutArgs): Promise<LogoutResult> {
  ctx.oauth.cancelLogin();
  const hadToken = await access(paths.tokenFile).then(
    () => true,
    () => false,
  );
  const attempted = hadToken && args.revoke !== false;
  const revoked = attempted && (await revokeStoredToken(ctx));
  await removeToken(paths);
  return {
    state: 'not_connected',
    revoked,
    removed: hadToken ? ['token.json'] : [],
    next_step: attempted && !revoked ? UNREVOKED_STEP : LOGIN_STEP,
  };
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
  const granted = new Set<string>(stored.scopes);
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  return {
    state: 'connected',
    user_id: stored.user_id,
    team_id: stored.team_id,
    team_domain: stored.team_domain,
    saved_at: stored.saved_at,
    scopes_missing: missing,
    next_step: missing.length === 0 ? READ_STEP : scopesStep(missing),
  };
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
  try {
    await readAppConfig(paths);
    return { state: 'not_connected', app_configured: true, next_step: LOGIN_STEP };
  } catch (error) {
    const nextStep = stringField(error, 'next_step') ?? `Check ${paths.appFile}, then see docs/slack.md.`;
    return { state: 'not_connected', app_configured: false, next_step: nextStep };
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
function namesWorkspace(workspace: string, stored: TokenRecord): boolean {
  const value = workspace.trim();
  if (value === stored.team_id) return true;
  const host = value.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  const domain = /\.slack\.com$/.test(host) ? host.split('.')[0] : host;
  return domain === stored.team_domain;
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
