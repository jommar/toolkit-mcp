import { vi, describe, it, expect, beforeEach } from 'vitest';

import { loadMcpConfig } from './mcp-config.js';

describe('loadMcpConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_PORT;
    delete process.env.MCP_LOG_LEVEL;
  });

  it('returns defaults when env vars are not set', () => {
    const config = loadMcpConfig();

    expect(config.transport).toBe('stdio');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
  });

  it('reads MCP_TRANSPORT from env', () => {
    vi.stubEnv('MCP_TRANSPORT', 'http');

    const config = loadMcpConfig();
    expect(config.transport).toBe('http');
  });

  it('falls back to stdio when MCP_TRANSPORT is empty string', () => {
    vi.stubEnv('MCP_TRANSPORT', '');

    const config = loadMcpConfig();
    expect(config.transport).toBe('stdio');
  });

  it('falls back to stdio when MCP_TRANSPORT is invalid', () => {
    vi.stubEnv('MCP_TRANSPORT', 'websocket');

    const config = loadMcpConfig();
    expect(config.transport).toBe('stdio');
  });

  it('reads MCP_PORT from env', () => {
    vi.stubEnv('MCP_PORT', '8080');

    const config = loadMcpConfig();
    expect(config.port).toBe(8080);
  });

  it('falls back to default port when MCP_PORT is not a valid number', () => {
    vi.stubEnv('MCP_PORT', 'not-a-number');

    const config = loadMcpConfig();
    expect(config.port).toBe(3000);
  });

  it('reads MCP_LOG_LEVEL from env', () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'debug');

    const config = loadMcpConfig();
    expect(config.logLevel).toBe('debug');
  });

  it('falls back to info when MCP_LOG_LEVEL is empty string', () => {
    vi.stubEnv('MCP_LOG_LEVEL', '');

    const config = loadMcpConfig();
    expect(config.logLevel).toBe('info');
  });

  it('falls back to info when MCP_LOG_LEVEL is invalid', () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'verbose');

    const config = loadMcpConfig();
    expect(config.logLevel).toBe('info');
  });

  it('trims whitespace from env var values', () => {
    vi.stubEnv('MCP_TRANSPORT', '  http  ');
    vi.stubEnv('MCP_LOG_LEVEL', '  silent  ');

    const config = loadMcpConfig();
    expect(config.transport).toBe('http');
    expect(config.logLevel).toBe('silent');
  });
});
