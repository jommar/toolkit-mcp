/**
 * `bin/toolkit-mcp` launcher (D22 a), hermetic: a temp HOME holds a fake nvm node for the `.nvmrc`
 * version, and a temp bin dir first on PATH holds a fake `node`. Each fake is a shell script that
 * records which binary ran, its cwd and its argv to $SHIM_RECORD, then exits 0 without writing to
 * stdout, so anything on stdout came from the launcher itself. The launcher runs from an unrelated
 * cwd, to prove it changes to the repo root. POSIX only (shell shims).
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHER = path.join(ROOT, 'bin', 'toolkit-mcp');
const ENTRY = path.join(ROOT, 'src', 'mcp-server.ts');
const NVMRC = readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();
const RUN_TIMEOUT_MS = 10_000;

const SHIM = `#!/bin/sh
{
  printf 'bin=%s\\n' "$0"
  printf 'cwd=%s\\n' "$(pwd)"
  for a in "$@"; do printf 'arg=%s\\n' "$a"; done
} > "$SHIM_RECORD"
exit 0
`;

interface Sandbox {
  dir: string;
  home: string;
  record: string;
  nvmNode: string;
  pathNode: string;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeShim(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, SHIM);
  chmodSync(file, 0o755);
}

/** A temp HOME, a fake PATH `node`, and (when `withNvm`) a fake `~/.nvm/versions/node/v<.nvmrc>/bin/node`. */
function sandbox(withNvm: boolean): Sandbox {
  const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-mcp-launcher-'));
  sandboxes.push(dir);
  const home = path.join(dir, 'home');
  mkdirSync(home);
  const nvmNode = path.join(home, '.nvm', 'versions', 'node', `v${NVMRC}`, 'bin', 'node');
  if (withNvm) writeShim(nvmNode);
  const pathNode = path.join(dir, 'path-bin', 'node');
  writeShim(pathNode);
  mkdirSync(path.join(dir, 'cwd'));
  return { dir, home, record: path.join(dir, 'record.txt'), nvmNode, pathNode };
}

function runLauncher(box: Sandbox): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(LAUNCHER, [], {
      cwd: path.join(box.dir, 'cwd'),
      env: { HOME: box.home, PATH: `${path.dirname(box.pathNode)}:/usr/bin:/bin`, SHIM_RECORD: box.record },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`launcher did not exit within ${RUN_TIMEOUT_MS} ms; stderr: ${stderr}`));
    }, RUN_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function readRecord(box: Sandbox): { bin: string; cwd: string; args: string[] } {
  expect(existsSync(box.record), 'no node shim ran').toBe(true);
  const lines = readFileSync(box.record, 'utf8').split('\n').filter(Boolean);
  const value = (key: string) => lines.filter((l) => l.startsWith(`${key}=`)).map((l) => l.slice(key.length + 1));
  return { bin: value('bin')[0], cwd: value('cwd')[0], args: value('arg') };
}

/** `--import tsx <entry>`, where the entry resolves (from the recorded cwd) to src/mcp-server.ts. */
function expectServerArgs(record: { cwd: string; args: string[] }): void {
  expect(record.args).toHaveLength(3);
  expect(record.args.slice(0, 2)).toEqual(['--import', 'tsx']);
  expect(realpathSync(path.resolve(record.cwd, record.args[2]))).toBe(realpathSync(ENTRY));
}

describe.skipIf(process.platform === 'win32')('bin/toolkit-mcp launcher', () => {
  it('runs the .nvmrc node from $HOME/.nvm with --import tsx src/mcp-server.ts, cwd the repo root', async () => {
    const box = sandbox(true);
    const result = await runLauncher(box);

    expect(result.code, result.stderr).toBe(0);
    const record = readRecord(box);
    expect(record.bin).toBe(box.nvmNode);
    expect(realpathSync(record.cwd)).toBe(realpathSync(ROOT));
    expectServerArgs(record);
  });

  it('falls back to node on PATH when the .nvmrc node is not installed', async () => {
    const box = sandbox(false);
    const result = await runLauncher(box);

    expect(result.code, result.stderr).toBe(0);
    const record = readRecord(box);
    expect(record.bin).toBe(box.pathNode);
    expect(realpathSync(record.cwd)).toBe(realpathSync(ROOT));
    expectServerArgs(record);
  });

  it.each([
    ['the .nvmrc node', true],
    ['the PATH fallback', false],
  ])('writes nothing to stdout itself (%s)', async (_label, withNvm) => {
    const box = sandbox(withNvm);
    const result = await runLauncher(box);

    expect(result.code, result.stderr).toBe(0);
    expect(existsSync(box.record), 'no node shim ran').toBe(true);
    expect(result.stdout).toBe('');
  });
});
