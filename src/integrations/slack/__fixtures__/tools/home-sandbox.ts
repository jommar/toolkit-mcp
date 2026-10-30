// Importing this module redirects the home directory to a fresh temp directory.
// It must be the first import of a test file, so that it runs before the module
// under test is evaluated and nothing ever resolves the real home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXAMPLE_TEAM, USER_ME, type FixtureTeam } from './ids.js';

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-tools-red-'));
process.env.HOME = sandboxHome;
delete process.env.XDG_CONFIG_HOME;
process.on('exit', () => fs.rmSync(sandboxHome, { recursive: true, force: true }));

export const TOKEN_SENTINEL = ['xoxp', 'synthetic', 'sentinel'].join('-');
export const CLIENT_ID_FIXTURE = 'CLIENT-ID-FIXTURE';
export const DASHBOARD_SESSION_CONTENT = '{"session":"OTHER-TOOL-SESSION-SENTINEL"}\n';

export const ALL_SCOPES: readonly string[] = [
  'search:read',
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'users:read.email',
  'chat:write',
  'reactions:write',
  'files:write',
];

export const sandbox = {
  home: sandboxHome,
  slackDir: path.join(sandboxHome, '.config', 'slack'),
  moduleDir: path.join(sandboxHome, '.config', 'slack', 'toolkit-mcp'),
  tokenFile: path.join(sandboxHome, '.config', 'slack', 'toolkit-mcp', 'token.json'),
  appFile: path.join(sandboxHome, '.config', 'slack', 'toolkit-mcp', 'app.json'),
  dashboardSessionFile: path.join(sandboxHome, '.config', 'slack', 'session.json'),
};

/** Fails fast if the redirect did not take, before any test writes a file. */
export function assertSandboxed(): void {
  if (os.homedir() !== sandboxHome) {
    throw new Error(`home directory is ${os.homedir()}, expected the sandbox ${sandboxHome}`);
  }
}

export function resetSandbox(): void {
  assertSandboxed();
  fs.rmSync(path.join(sandboxHome, '.config'), { recursive: true, force: true });
}

export function removeSandbox(): void {
  fs.rmSync(sandboxHome, { recursive: true, force: true });
}

export interface SeedTokenOptions {
  team?: FixtureTeam;
  scopes?: readonly string[];
  accessToken?: string;
  savedAt?: string;
  userId?: string;
}

export const SEEDED_SAVED_AT = '2031-01-01T00:00:00.000Z';

function ensureModuleDir(): void {
  fs.mkdirSync(sandbox.moduleDir, { recursive: true });
  fs.chmodSync(sandbox.moduleDir, 0o700);
}

export function seedToken(options: SeedTokenOptions = {}) {
  assertSandboxed();
  const team = options.team ?? EXAMPLE_TEAM;
  const record = {
    access_token: options.accessToken ?? TOKEN_SENTINEL,
    scopes: [...(options.scopes ?? ALL_SCOPES)],
    team_id: team.id,
    team_domain: team.domain,
    team_url: team.url,
    user_id: options.userId ?? USER_ME,
    saved_at: options.savedAt ?? SEEDED_SAVED_AT,
  };
  ensureModuleDir();
  fs.writeFileSync(sandbox.tokenFile, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(sandbox.tokenFile, 0o600);
  return record;
}

export function seedAppConfig(clientId: string = CLIENT_ID_FIXTURE): void {
  assertSandboxed();
  ensureModuleDir();
  fs.writeFileSync(sandbox.appFile, JSON.stringify({ client_id: clientId }), { mode: 0o600 });
  fs.chmodSync(sandbox.appFile, 0o600);
}

export function seedDashboardSession(): void {
  assertSandboxed();
  fs.mkdirSync(sandbox.slackDir, { recursive: true });
  fs.writeFileSync(sandbox.dashboardSessionFile, DASHBOARD_SESSION_CONTENT, { mode: 0o600 });
}

export function dashboardSessionIntact(): boolean {
  return (
    fs.existsSync(sandbox.dashboardSessionFile) &&
    fs.readFileSync(sandbox.dashboardSessionFile, 'utf8') === DASHBOARD_SESSION_CONTENT
  );
}

export function tokenFileExists(): boolean {
  return fs.existsSync(sandbox.tokenFile);
}

export function readTokenFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(sandbox.tokenFile, 'utf8')) as Record<string, unknown>;
}

export function modeOf(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}
