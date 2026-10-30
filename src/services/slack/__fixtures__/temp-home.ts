import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLIENT_ID_FIXTURE,
  DASHBOARD_SESSION_SENTINEL,
  capturedSession,
  tokenRecord,
  type TokenRecordFixture,
} from './synthetic.js';

export interface TempSlackPaths {
  dir: string;
  tokenFile: string;
  appFile: string;
  sourceFile: string;
}

export interface TempHome {
  home: string;
  paths: TempSlackPaths;
  slackConfigDir: string;
  dashboardSessionFile: string;
  cleanup(): void;
}

export function createTempHome(): TempHome {
  const base = fs.realpathSync(os.tmpdir());
  const home = fs.mkdtempSync(path.join(base, 'slack-mcp-home-'));
  const slackConfigDir = path.join(home, '.config', 'slack');
  const dir = path.join(slackConfigDir, 'toolkit-mcp');
  const dashboardSessionFile = path.join(slackConfigDir, 'session.json');
  return {
    home,
    paths: {
      dir,
      tokenFile: path.join(dir, 'token.json'),
      appFile: path.join(dir, 'app.json'),
      sourceFile: dashboardSessionFile,
    },
    slackConfigDir,
    dashboardSessionFile,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

export function writeDashboardSession(temp: TempHome): void {
  fs.mkdirSync(temp.slackConfigDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp.dashboardSessionFile, JSON.stringify({ session: DASHBOARD_SESSION_SENTINEL }), {
    mode: 0o600,
  });
}

/** Writes the session dev-dashboard captures: an xoxc token and an xoxd cookie. */
export function writeCapturedSession(temp: TempHome, overrides: Record<string, unknown> = {}): void {
  fs.mkdirSync(temp.slackConfigDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp.dashboardSessionFile, JSON.stringify(capturedSession(overrides)), { mode: 0o600 });
}

export function writeAppConfigFile(
  temp: TempHome,
  contents: Record<string, unknown> = { client_id: CLIENT_ID_FIXTURE },
  modes: { dir?: number; file?: number } = {},
): void {
  fs.mkdirSync(temp.paths.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(temp.paths.dir, modes.dir ?? 0o700);
  fs.writeFileSync(temp.paths.appFile, JSON.stringify(contents), { mode: 0o600 });
  fs.chmodSync(temp.paths.appFile, modes.file ?? 0o600);
}

export function permissionBits(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

export function writeTokenFile(temp: TempHome, record: TokenRecordFixture = tokenRecord()): void {
  fs.mkdirSync(temp.paths.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp.paths.tokenFile, JSON.stringify(record), { mode: 0o600 });
}
