import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readToken, writeToken, removeToken, slackPaths } from './credential-store.js';
import { createTempHome, permissionBits, writeDashboardSession, type TempHome } from './__fixtures__/temp-home.js';
import { DASHBOARD_SESSION_SENTINEL, tokenRecord, TOKEN_SENTINEL } from './__fixtures__/synthetic.js';
import { settle } from './__fixtures__/settle.js';

describe('credential store', () => {
  let temp: TempHome;
  let outside: string;

  beforeEach(() => {
    temp = createTempHome();
    outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'slack-mcp-outside-'));
  });

  afterEach(() => {
    temp.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  });

  describe('slackPaths', () => {
    it('places the module store beside, never inside, the dashboard session directory', () => {
      expect(slackPaths(temp.home)).toMatchObject({
        dir: path.join(temp.home, '.config', 'slack', 'toolkit-mcp'),
        tokenFile: path.join(temp.home, '.config', 'slack', 'toolkit-mcp', 'token.json'),
        appFile: path.join(temp.home, '.config', 'slack', 'toolkit-mcp', 'app.json'),
      });
    });
  });

  describe('writing into an empty home', () => {
    it('creates the directory 0700 and the file 0600 and reads the record back', async () => {
      const record = tokenRecord();

      await writeToken(temp.paths, record);

      expect(permissionBits(temp.paths.dir)).toBe(0o700);
      expect(permissionBits(temp.paths.tokenFile)).toBe(0o600);
      expect(await readToken(temp.paths)).toEqual(record);
    });

    it('replaces the file by rename and leaves no temporary file behind', async () => {
      await writeToken(temp.paths, tokenRecord());
      const inodeBefore = fs.statSync(temp.paths.tokenFile).ino;

      await writeToken(temp.paths, tokenRecord({ access_token: `${TOKEN_SENTINEL}-second` }));

      expect(fs.statSync(temp.paths.tokenFile).ino).not.toBe(inodeBefore);
      expect(fs.readdirSync(temp.paths.dir)).toEqual(['token.json']);
      expect((await readToken(temp.paths))?.access_token).toBe(`${TOKEN_SENTINEL}-second`);
      expect(permissionBits(temp.paths.tokenFile)).toBe(0o600);
    });
  });

  describe('reading', () => {
    it('returns null when there is no token file', async () => {
      expect(await readToken(temp.paths)).toBeNull();
    });
  });

  describe('removing', () => {
    it('deletes only the token file and tolerates a second removal', async () => {
      await writeToken(temp.paths, tokenRecord());
      fs.writeFileSync(temp.paths.appFile, '{"client_id":"kept"}', { mode: 0o600 });

      const first = await settle(() => removeToken(temp.paths));
      const second = await settle(() => removeToken(temp.paths));

      expect(first.threw).toBe(false);
      expect(second.threw).toBe(false);
      expect(fs.existsSync(temp.paths.tokenFile)).toBe(false);
      expect(fs.readFileSync(temp.paths.appFile, 'utf8')).toBe('{"client_id":"kept"}');
      expect(await readToken(temp.paths)).toBeNull();
    });

    it('does not fail when the store directory does not exist', async () => {
      const result = await settle(() => removeToken(temp.paths));

      expect(result.threw).toBe(false);
    });
  });

  describe('a symlinked token file', () => {
    const secretTarget = () => path.join(outside, 'target.json');

    beforeEach(() => {
      fs.mkdirSync(temp.paths.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(secretTarget(), JSON.stringify(tokenRecord()), { mode: 0o600 });
      fs.symlinkSync(secretTarget(), temp.paths.tokenFile);
    });

    it('is refused on read and its contents are not returned', async () => {
      const result = await settle(() => readToken(temp.paths));

      expect(result.threw).toBe(true);
      expect(result.value ?? null).toBeNull();
    });

    it('is refused on write and the link target is untouched', async () => {
      const before = fs.readFileSync(secretTarget(), 'utf8');

      const result = await settle(() => writeToken(temp.paths, tokenRecord({ access_token: 'replacement' })));

      expect(result.threw).toBe(true);
      expect(fs.readFileSync(secretTarget(), 'utf8')).toBe(before);
    });

    it('is refused on remove and the link target survives', async () => {
      const result = await settle(() => removeToken(temp.paths));

      expect(result.threw).toBe(true);
      expect(fs.existsSync(secretTarget())).toBe(true);
    });
  });

  describe('a symlinked ancestor directory', () => {
    beforeEach(() => {
      fs.mkdirSync(path.join(temp.home, '.config'), { recursive: true });
      fs.symlinkSync(outside, temp.slackConfigDir);
    });

    it('is refused on write and nothing is created behind the link', async () => {
      const result = await settle(() => writeToken(temp.paths, tokenRecord()));

      expect(result.threw).toBe(true);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('is refused on read', async () => {
      fs.mkdirSync(path.join(outside, 'toolkit-mcp'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(outside, 'toolkit-mcp', 'token.json'), JSON.stringify(tokenRecord()), {
        mode: 0o600,
      });

      const result = await settle(() => readToken(temp.paths));

      expect(result.threw).toBe(true);
      expect(result.value ?? null).toBeNull();
    });

    it('is refused on remove and the file behind the link survives', async () => {
      fs.mkdirSync(path.join(outside, 'toolkit-mcp'), { recursive: true, mode: 0o700 });
      const behindLink = path.join(outside, 'toolkit-mcp', 'token.json');
      fs.writeFileSync(behindLink, JSON.stringify(tokenRecord()), { mode: 0o600 });

      const result = await settle(() => removeToken(temp.paths));

      expect(result.threw).toBe(true);
      expect(fs.existsSync(behindLink)).toBe(true);
    });
  });

  describe('the dashboard session file in the parent directory', () => {
    it('is never read, rewritten or removed by any operation', async () => {
      writeDashboardSession(temp);
      const before = fs.readFileSync(temp.dashboardSessionFile, 'utf8');
      const mtimeBefore = fs.statSync(temp.dashboardSessionFile).mtimeMs;

      expect(await readToken(temp.paths)).toBeNull();
      await writeToken(temp.paths, tokenRecord());
      expect(JSON.stringify(await readToken(temp.paths))).not.toContain(DASHBOARD_SESSION_SENTINEL);
      await removeToken(temp.paths);
      await removeToken(temp.paths);

      expect(fs.readFileSync(temp.dashboardSessionFile, 'utf8')).toBe(before);
      expect(fs.statSync(temp.dashboardSessionFile).mtimeMs).toBe(mtimeBefore);
      expect(permissionBits(temp.dashboardSessionFile)).toBe(0o600);
    });
  });
});
