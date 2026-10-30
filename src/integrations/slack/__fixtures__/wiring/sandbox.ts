import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ALL_USER_SCOPES,
  CAPTURED_COOKIE_SENTINEL,
  CAPTURED_TOKEN_SENTINEL,
  CLIENT_ID,
  CLIENT_SECRET_SENTINEL,
  EXAMPLE,
  TOKEN_SENTINEL,
} from './sentinels.js';

const sandboxRoot = mkdtempSync(join(tmpdir(), 'slack-wiring-'));

export const sandboxHome = join(sandboxRoot, 'home');
export const uploadDirectory = join(sandboxRoot, 'uploads');
export const slackConfigRoot = join(sandboxHome, '.config', 'slack');
export const moduleConfigDirectory = join(slackConfigRoot, 'toolkit-mcp');
export const appConfigPath = join(moduleConfigDirectory, 'app.json');
export const tokenPath = join(moduleConfigDirectory, 'token.json');
export const dashboardSessionPath = join(slackConfigRoot, 'session.json');

mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;

export function resetSandbox(): void {
  rmSync(join(sandboxHome, '.config'), { recursive: true, force: true });
  rmSync(uploadDirectory, { recursive: true, force: true });
  mkdirSync(uploadDirectory, { recursive: true });
}

export function removeSandbox(): void {
  rmSync(sandboxRoot, { recursive: true, force: true });
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
  chmodSync(slackConfigRoot, 0o700);
  chmodSync(directory, 0o700);
}

export interface AppConfigOptions {
  clientSecret?: string | null;
  fileMode?: number;
}

export function writeAppConfig(options: AppConfigOptions = {}): void {
  const clientSecret = options.clientSecret === undefined ? CLIENT_SECRET_SENTINEL : options.clientSecret;
  ensurePrivateDirectory(moduleConfigDirectory);
  const body: Record<string, string> = { client_id: CLIENT_ID };
  if (clientSecret !== null) body.client_secret = clientSecret;
  writeFileSync(appConfigPath, JSON.stringify(body));
  chmodSync(appConfigPath, options.fileMode ?? 0o600);
}

export interface TokenOptions {
  scopes?: readonly string[];
  teamDomain?: string;
  teamId?: string;
}

export function writeToken(options: TokenOptions = {}): void {
  ensurePrivateDirectory(moduleConfigDirectory);
  const teamDomain = options.teamDomain ?? EXAMPLE.teamDomain;
  writeFileSync(
    tokenPath,
    JSON.stringify({
      access_token: TOKEN_SENTINEL,
      scopes: [...(options.scopes ?? ALL_USER_SCOPES)],
      team_id: options.teamId ?? EXAMPLE.teamId,
      team_domain: teamDomain,
      team_url: `https://${teamDomain}.slack.com/`,
      user_id: EXAMPLE.meId,
      saved_at: new Date().toISOString(),
    }),
  );
  chmodSync(tokenPath, 0o600);
}

export function tokenFileExists(): boolean {
  return existsSync(tokenPath);
}

/** Writes the Slack web session dev-dashboard captures: an xoxc token and its xoxd cookie. */
export function writeCapturedSession(): void {
  mkdirSync(slackConfigRoot, { recursive: true });
  chmodSync(slackConfigRoot, 0o700);
  writeFileSync(
    dashboardSessionPath,
    JSON.stringify({
      token: CAPTURED_TOKEN_SENTINEL,
      cookie: CAPTURED_COOKIE_SENTINEL,
      teamId: EXAMPLE.teamId,
      teamDomain: EXAMPLE.teamDomain,
      savedAt: new Date().toISOString(),
    }),
  );
  chmodSync(dashboardSessionPath, 0o600);
}

export function readCapturedSessionText(): string {
  return readFileSync(dashboardSessionPath, 'utf8');
}

export function readTokenFileText(): string {
  return readFileSync(tokenPath, 'utf8');
}

export function writeUploadFile(name: string, content: string): string {
  mkdirSync(uploadDirectory, { recursive: true });
  const path = join(uploadDirectory, name);
  writeFileSync(path, content);
  return path;
}
