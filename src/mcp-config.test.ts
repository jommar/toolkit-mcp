import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import { createLogger, loadMcpConfig } from './mcp-config.js';

describe('loadMcpConfig', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('MCP_LOG_LEVEL', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to info when MCP_LOG_LEVEL is not set', () => {
    expect(loadMcpConfig()).toEqual({ logLevel: 'info' });
  });

  it.each(['silent', 'info', 'debug'] as const)('reads MCP_LOG_LEVEL=%s', (level) => {
    vi.stubEnv('MCP_LOG_LEVEL', level);
    expect(loadMcpConfig().logLevel).toBe(level);
  });

  it('falls back to info when MCP_LOG_LEVEL is empty string', () => {
    vi.stubEnv('MCP_LOG_LEVEL', '');
    expect(loadMcpConfig().logLevel).toBe('info');
  });

  it('trims whitespace from MCP_LOG_LEVEL', () => {
    vi.stubEnv('MCP_LOG_LEVEL', '  silent  ');
    expect(loadMcpConfig().logLevel).toBe('silent');
  });
});

describe('log level', () => {
  // createLogger writes to stderr; vitest may route console.error separately, so both sinks are counted.
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  const written = () => [...stderrWrite.mock.calls, ...consoleError.mock.calls].map((c) => String(c[0]));

  beforeEach(() => {
    vi.unstubAllEnvs();
    stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutWrite = vi.spyOn(process.stdout, 'write');
    consoleLog = vi.spyOn(console, 'log');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('falls back to info when MCP_LOG_LEVEL is invalid', () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'verbose');
    expect(loadMcpConfig().logLevel).toBe('info');
  });

  it('holds logLevel only: MCP_TRANSPORT and MCP_PORT are no longer read', () => {
    vi.stubEnv('MCP_TRANSPORT', 'http');
    vi.stubEnv('MCP_PORT', '1');
    vi.stubEnv('MCP_LOG_LEVEL', 'debug');
    expect(loadMcpConfig()).toEqual({ logLevel: 'debug' });
  });

  it('debug writes debug, info and error lines to stderr', () => {
    const log = createLogger('debug');
    log.debug('tool x ok 3ms');
    log.info('started');
    log.error('broke');

    const lines = written();
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.includes('tool x ok 3ms'))).toBe(true);
    expect(lines.some((l) => l.includes('started'))).toBe(true);
    expect(lines.some((l) => l.includes('broke'))).toBe(true);
  });

  it('info writes info and error lines but no debug line', () => {
    const log = createLogger('info');
    log.debug('tool x ok 3ms');
    log.info('started');
    log.error('broke');

    const lines = written();
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('tool x ok 3ms'))).toBe(false);
  });

  it('silent writes nothing at all', () => {
    const log = createLogger('silent');
    log.debug('tool x ok 3ms');
    log.info('started');
    log.error('broke');

    expect(written()).toEqual([]);
  });

  it('never writes to stdout, which belongs to the protocol', () => {
    const log = createLogger('debug');
    log.debug('d');
    log.info('i');
    log.error('e');

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
