/**
 * Stdio end-to-end: spawns the real server (`node --import tsx src/mcp-server.ts`) and speaks raw
 * JSON-RPC lines on its stdin/stdout, once per protocol era.
 *
 * The child gets an explicit env (PATH and a temp HOME only) and an empty temp cwd, so it never picks
 * up a developer `.env` (dotenv loads from the cwd with override) or the runner's `VITEST` flag (which
 * skips `main()`); entry and loader are absolute paths.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = path.join(ROOT, 'src', 'mcp-server.ts');
const TSX_LOADER = import.meta.resolve('tsx');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };

const LEGACY_VERSION = '2025-11-25';
/** Older initialize-era versions clients still send (Claude Code, the inspector); the server must echo each. */
const LEGACY_VERSIONS = [LEGACY_VERSION, '2025-06-18'];
const MODERN_VERSION = '2026-07-28';
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'e2e', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const REPLY_TIMEOUT_MS = 15_000;
const EXIT_WITHIN_MS = 2_000;
const TEST_TIMEOUT_MS = 30_000;

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

interface Session {
  child: ChildProcess;
  stdoutLines: string[];
  stderr: () => string;
  request(id: number, method: string, params?: unknown): Promise<JsonRpcMessage>;
  notify(method: string, params?: unknown): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const live: Array<{ child: ChildProcess; dir: string }> = [];

function spawnServer(): Session {
  const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-mcp-e2e-'));
  const child = spawn(process.execPath, ['--import', TSX_LOADER, ENTRY], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  live.push({ child, dir });

  const stdoutLines: string[] = [];
  const waiters = new Map<number, (m: JsonRpcMessage) => void>();
  let buffer = '';
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += String(d)));
  child.stdout!.on('data', (d) => {
    buffer += String(d);
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        if (message.id !== undefined && waiters.has(message.id)) {
          waiters.get(message.id)!(message);
          waiters.delete(message.id);
        }
      } catch {
        // kept in stdoutLines; the shutdown test asserts every line parses
      }
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );

  const send = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`);
  return {
    child,
    stdoutLines,
    stderr: () => stderr,
    exited,
    notify: (method, params) => send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }),
    request: (id, method, params) => {
      const reply = new Promise<JsonRpcMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no reply to ${method} (id ${id}) within ${REPLY_TIMEOUT_MS} ms; stderr:\n${stderr}`)),
          REPLY_TIMEOUT_MS,
        );
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        exited.then(({ code, signal }) => {
          clearTimeout(timer);
          reject(new Error(`server exited (code ${code}, signal ${signal}) before replying to ${method}; stderr:\n${stderr}`));
        });
      });
      send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
      return reply;
    },
  };
}

async function initializeLegacy(session: Session, protocolVersion = LEGACY_VERSION): Promise<JsonRpcMessage> {
  const reply = await session.request(1, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  });
  session.notify('notifications/initialized');
  return reply;
}

function exitWithin(session: Session, ms: number) {
  return Promise.race([
    session.exited,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ]);
}

const healthBody = (reply: JsonRpcMessage) => JSON.parse(reply.result.content[0].text);

afterEach(() => {
  for (const { child, dir } of live.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('legacy client', () => {
  it.each(LEGACY_VERSIONS)(
    'negotiates %s, reports package info, advertises tools only and lists exactly mcp_get_health',
    async (version) => {
      const session = spawnServer();
      const init = await initializeLegacy(session, version);

      expect(init.error).toBeUndefined();
      expect(init.result.protocolVersion).toBe(version);
      expect(init.result.serverInfo).toMatchObject({ name: 'toolkit-mcp', version: PKG.version });
      expect(init.result.capabilities.tools).toBeDefined();
      expect(init.result.capabilities.resources).toBeUndefined();
      expect(init.result.capabilities.prompts).toBeUndefined();

      const list = await session.request(2, 'tools/list');
      expect(list.error).toBeUndefined();
      expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['mcp_get_health']);
      expect(list.result).not.toHaveProperty('ttlMs');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('modern client', () => {
  it(
    'answers server/discover and tools/list with the 2026-07-28 envelope and cache hints, without initialize',
    async () => {
      const session = spawnServer();

      const discover = await session.request(1, 'server/discover', { _meta: MODERN_META });
      expect(discover.error).toBeUndefined();
      expect(discover.result.supportedVersions).toContain(MODERN_VERSION);

      const list = await session.request(2, 'tools/list', { _meta: MODERN_META });
      expect(list.error).toBeUndefined();
      expect(list.result.tools.map((t: { name: string }) => t.name)).toContain('mcp_get_health');
      expect(list.result.ttlMs).toBe(3_600_000);
      expect(list.result.cacheScope).toBe('private');
      expect(list.result._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({
        name: 'toolkit-mcp',
        version: PKG.version,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('health', () => {
  const ALL_INACTIVE = { jira: false, github: false, figma: false, confluence: false, jenkins: false, slack: false };

  it(
    'legacy era: reports the package version with six inactive integrations, and refuses parameters as isError',
    async () => {
      const session = spawnServer();
      await initializeLegacy(session);

      const ok = await session.request(2, 'tools/call', { name: 'mcp_get_health', arguments: {} });
      expect(ok.error).toBeUndefined();
      expect(healthBody(ok)).toEqual({ serverVersion: PKG.version, integrations: ALL_INACTIVE });

      const refused = await session.request(3, 'tools/call', { name: 'mcp_get_health', arguments: { a: 1 } });
      expect(refused.error).toBeUndefined();
      expect(refused.result.isError).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'modern era: same version and flags, and parameters are an isError result',
    async () => {
      const session = spawnServer();

      const ok = await session.request(1, 'tools/call', { name: 'mcp_get_health', arguments: {}, _meta: MODERN_META });
      expect(ok.error).toBeUndefined();
      expect(healthBody(ok)).toEqual({ serverVersion: PKG.version, integrations: ALL_INACTIVE });

      const refused = await session.request(2, 'tools/call', {
        name: 'mcp_get_health',
        arguments: { a: 1 },
        _meta: MODERN_META,
      });
      expect(refused.error).toBeUndefined();
      expect(refused.result.isError).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('shutdown', () => {
  function expectProtocolOnlyStdout(session: Session) {
    expect(session.stdoutLines.length).toBeGreaterThan(0);
    for (const line of session.stdoutLines) {
      expect(() => JSON.parse(line), `stdout line is not JSON-RPC: ${line}`).not.toThrow();
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
    expect(session.stderr()).toContain('toolkit-mcp');
  }

  it(
    'exits 0 within 2 s when stdin closes',
    async () => {
      const session = spawnServer();
      await initializeLegacy(session);
      await session.request(2, 'tools/list');

      session.child.stdin!.end();
      const outcome = await exitWithin(session, EXIT_WITHIN_MS);

      expect(outcome).toEqual({ code: 0, signal: null });
      expectProtocolOnlyStdout(session);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'exits 0 within 2 s on SIGTERM',
    async () => {
      const session = spawnServer();
      await initializeLegacy(session);
      await session.request(2, 'tools/list');

      session.child.kill('SIGTERM');
      const outcome = await exitWithin(session, EXIT_WITHIN_MS);

      expect(outcome).toEqual({ code: 0, signal: null });
      expectProtocolOnlyStdout(session);
    },
    TEST_TIMEOUT_MS,
  );
});
