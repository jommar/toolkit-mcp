import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAppConfig } from './app-config.js';
import { createTempHome, writeAppConfigFile, type TempHome } from './__fixtures__/temp-home.js';
import { settle } from './__fixtures__/settle.js';
import { CLIENT_ID_FIXTURE, CLIENT_SECRET_SENTINEL } from './__fixtures__/synthetic.js';

describe('readAppConfig', () => {
  let temp: TempHome;
  let outside: string;

  beforeEach(() => {
    temp = createTempHome();
    outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'slack-mcp-app-outside-'));
  });

  afterEach(() => {
    temp.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  async function expectNotConfigured(): Promise<void> {
    const outcome = await settle(() => readAppConfig(temp.paths));

    expect(outcome.threw).toBe(true);
    expect(outcome.error).toMatchObject({ code: 'app_not_configured' });
    expect(outcome.error.message).toContain(temp.paths.appFile);
    expect(outcome.error.message).toContain('docs/slack.md');
    expect(outcome.error.message).toContain('600');
    expect(`${outcome.error.message} ${JSON.stringify(outcome.error)}`).not.toContain(CLIENT_SECRET_SENTINEL);
  }

  it('returns the client id from a 0600 file in a 0700 directory', async () => {
    writeAppConfigFile(temp);

    expect(await readAppConfig(temp.paths)).toEqual({ client_id: CLIENT_ID_FIXTURE });
  });

  it('drops a client secret the user left in the file', async () => {
    writeAppConfigFile(temp, { client_id: CLIENT_ID_FIXTURE, client_secret: CLIENT_SECRET_SENTINEL });

    const config = await readAppConfig(temp.paths);

    expect(config).toEqual({ client_id: CLIENT_ID_FIXTURE });
    expect(JSON.stringify(config)).not.toContain(CLIENT_SECRET_SENTINEL);
  });

  it('is not configured when the directory does not exist', async () => {
    await expectNotConfigured();
  });

  it('is not configured when the directory exists but app.json does not', async () => {
    fs.mkdirSync(temp.paths.dir, { recursive: true, mode: 0o700 });

    await expectNotConfigured();
  });

  it('is not configured when app.json is a symlink, even to a valid 0600 file', async () => {
    fs.mkdirSync(temp.paths.dir, { recursive: true, mode: 0o700 });
    const target = path.join(outside, 'real-app.json');
    fs.writeFileSync(target, JSON.stringify({ client_id: CLIENT_ID_FIXTURE }), { mode: 0o600 });
    fs.symlinkSync(target, temp.paths.appFile);

    await expectNotConfigured();
  });

  it.each([0o640, 0o644, 0o660])('is not configured when app.json has mode %o (group or world accessible)', async (mode) => {
    writeAppConfigFile(temp, { client_id: CLIENT_ID_FIXTURE, client_secret: CLIENT_SECRET_SENTINEL }, { file: mode });

    await expectNotConfigured();
  });

  it.each([0o750, 0o755])('is not configured when the directory has mode %o', async (mode) => {
    writeAppConfigFile(temp, { client_id: CLIENT_ID_FIXTURE }, { dir: mode });

    await expectNotConfigured();
  });

  it('is not configured when the store directory is a symlink', async () => {
    const realDir = path.join(outside, 'toolkit-mcp');
    fs.mkdirSync(realDir, { mode: 0o700 });
    fs.writeFileSync(path.join(realDir, 'app.json'), JSON.stringify({ client_id: CLIENT_ID_FIXTURE }), { mode: 0o600 });
    fs.mkdirSync(temp.slackConfigDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(realDir, temp.paths.dir);

    await expectNotConfigured();
  });
});
