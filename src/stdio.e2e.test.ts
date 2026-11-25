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
    'negotiates %s, reports package info, advertises tools and the skill resources only and lists exactly mcp_get_health',
    async (version) => {
      const session = spawnServer();
      const init = await initializeLegacy(session, version);

      expect(init.error).toBeUndefined();
      expect(init.result.protocolVersion).toBe(version);
      expect(init.result.serverInfo).toMatchObject({ name: 'toolkit-mcp', version: PKG.version });
      expect(init.result.capabilities.tools).toBeDefined();
      // The Skills extension serves its files as resources, so even a legacy client sees the resources capability.
      expect(init.result.capabilities.resources).toBeDefined();
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

  it(
    'serves the toolkit-mcp skill: the extension in server/discover, skills/list, and its files over resources/read',
    async () => {
      const session = spawnServer();
      const meta = {
        ...MODERN_META,
        'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/skills': {} } },
      };

      const discover = await session.request(1, 'server/discover', { _meta: meta });
      expect(discover.result.capabilities.extensions).toHaveProperty(['io.modelcontextprotocol/skills']);

      const list = await session.request(2, 'skills/list', { _meta: meta });
      expect(list.error).toBeUndefined();
      expect(list.result.skills.map((s: { uri: string }) => s.uri)).toEqual(['skill://toolkit-mcp/SKILL.md']);
      expect(list.result.skills[0].frontmatter.name).toBe('toolkit-mcp');

      const read = await session.request(3, 'resources/read', { uri: 'skill://toolkit-mcp/references/jira.md', _meta: meta });
      expect(read.error).toBeUndefined();
      expect(read.result.contents[0].text).toContain('jira_get_issues');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('health', () => {
  const ALL_INACTIVE = { jira: false, github: false, figma: false, confluence: false, jenkins: false, slack: false };
  /** The server runs on `process.execPath` (see spawnServer), so its Node is the runner's. */
  const SPAWNED_NODE_VERSION = process.version;

  it(
    'legacy era: reports the package version with six inactive integrations, and refuses parameters as isError',
    async () => {
      const session = spawnServer();
      await initializeLegacy(session);

      const ok = await session.request(2, 'tools/call', { name: 'mcp_get_health', arguments: {} });
      expect(ok.error).toBeUndefined();
      expect(healthBody(ok).node).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(healthBody(ok)).toEqual({ serverVersion: PKG.version, node: SPAWNED_NODE_VERSION, integrations: ALL_INACTIVE });

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
      expect(healthBody(ok).node).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(healthBody(ok)).toEqual({ serverVersion: PKG.version, node: SPAWNED_NODE_VERSION, integrations: ALL_INACTIVE });

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

describe('stdout drain on stdin end', () => {
  /**
   * Dummy credentials for every integration that registers without a network call at startup (Jenkins
   * pings, so it stays off). Hosts are `.invalid`, so nothing could resolve even if a client tried.
   * With these the tools/list reply is about 70 KB, larger than one 64 KiB pipe buffer.
   */
  const MANY_TOOLS_ENV = {
    JIRA_BASE_URL: 'https://jira.example.invalid',
    JIRA_EMAIL: 'e2e@example.invalid',
    JIRA_TOKEN: 'dummy',
    GH_TOKEN: 'dummy',
    FIGMA_TOKEN: 'dummy',
    SLACK_ENABLED: 'true',
  };
  const PIPE_BUFFER_BYTES = 64 * 1024;
  /** How long the reader waits before draining; the server has long finished writing by then. */
  const READER_DELAY_S = 2;
  const SERVER_EXIT_WITHIN_MS = 5_000;
  const EXIT_MARKER = /server-exit=(\d+)/;

  it(
    'flushes the whole tools/list reply to a slow pipe reader before exiting 0',
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'toolkit-mcp-e2e-'));
      // The server's stdout is a kernel pipe to a reader that sleeps first, as a slow MCP client would be.
      // A Node pipe on the test side would buffer another 64 KiB in user space and hide the bug.
      const script = `{ "$@"; echo "server-exit=$?" >&2; } | { sleep ${READER_DELAY_S}; cat; }`;
      const child = spawn('/bin/sh', ['-c', script, 'sh', process.execPath, '--import', TSX_LOADER, ENTRY], {
        cwd: dir,
        env: { PATH: process.env.PATH ?? '', HOME: dir, ...MANY_TOOLS_ENV },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      live.push({ child, dir });

      const stdoutChunks: Buffer[] = [];
      let stderr = '';
      let stdinEndedAt = 0;
      const serverExit = new Promise<{ code: number; afterMs: number }>((resolve) => {
        child.stderr!.on('data', (d) => {
          stderr += String(d);
          const match = EXIT_MARKER.exec(stderr);
          if (match) resolve({ code: Number(match[1]), afterMs: Date.now() - stdinEndedAt });
        });
      });
      child.stdout!.on('data', (d: Buffer) => stdoutChunks.push(d));
      const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));

      const send = (message: unknown) => child.stdin!.write(`${JSON.stringify(message)}\n`);
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      child.stdin!.end();
      stdinEndedAt = Date.now();

      const exit = await Promise.race([
        serverExit,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), SERVER_EXIT_WITHIN_MS + 1_000)),
      ]);
      await closed;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');

      expect(exit, `server did not exit; stderr:\n${stderr}`).not.toBe('timeout');
      const { code, afterMs } = exit as { code: number; afterMs: number };
      expect(code).toBe(0);
      expect(afterMs).toBeLessThan(SERVER_EXIT_WITHIN_MS);

      const lines = stdout.split('\n').filter((line) => line.trim());
      const replies = lines.map((line, i) => {
        try {
          return JSON.parse(line) as JsonRpcMessage;
        } catch (err) {
          throw new Error(
            `stdout line ${i + 1} of ${lines.length} is not complete JSON (${Buffer.byteLength(line)} bytes, ` +
              `${Buffer.byteLength(stdout)} stdout bytes in total): ${(err as Error).message}`,
          );
        }
      });
      const list = replies.find((reply) => reply.id === 2);
      expect(list, `no tools/list reply in ${Buffer.byteLength(stdout)} stdout bytes`).toBeDefined();
      expect(list!.result.tools.length).toBeGreaterThan(1);
      // Guards the premise: a reply that fits one pipe buffer would pass even with the bug.
      expect(Buffer.byteLength(lines.find((line) => line.includes('"id":2'))!)).toBeGreaterThan(PIPE_BUFFER_BYTES);
    },
    TEST_TIMEOUT_MS,
  );
});
