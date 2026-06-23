import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('./services/config.js', () => ({
  loadConfig: vi.fn(),
}));

import { loadMcpConfig } from './mcp-config.js';
import { loadConfig } from './services/config.js';

const mockLoadConfig = loadConfig as ReturnType<typeof vi.fn>;

describe('loadMcpConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env.MCP_TRANSPORT;
    delete process.env.MCP_PORT;
    delete process.env.MCP_LOG_LEVEL;
  });

  it('returns defaults when env vars are not set and jira config succeeds', () => {
    mockLoadConfig.mockReturnValue({
      baseUrl: 'https://test.atlassian.net',
      email: 'bot@test.com',
      token: 'tok_123',
    });

    const config = loadMcpConfig();

    expect(config.transport).toBe('stdio');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.jira).toEqual({
      baseUrl: 'https://test.atlassian.net',
      email: 'bot@test.com',
      token: 'tok_123',
    });
  });

  it('reads MCP_TRANSPORT from env', () => {
    vi.stubEnv('MCP_TRANSPORT', 'http');
    mockLoadConfig.mockReturnValue({
      baseUrl: 'https://test.atlassian.net',
      email: 'bot@test.com',
      token: 'tok_123',
    });

    const config = loadMcpConfig();
    expect(config.transport).toBe('http');
  });

  it('reads MCP_PORT from env', () => {
    vi.stubEnv('MCP_PORT', '8080');
    mockLoadConfig.mockReturnValue({
      baseUrl: 'https://test.atlassian.net',
      email: 'bot@test.com',
      token: 'tok_123',
    });

    const config = loadMcpConfig();
    expect(config.port).toBe(8080);
  });

  it('falls back to default port when MCP_PORT is not a valid number', () => {
    vi.stubEnv('MCP_PORT', 'not-a-number');
    mockLoadConfig.mockReturnValue({
      baseUrl: 'https://test.atlassian.net',
      email: 'bot@test.com',
      token: 'tok_123',
    });

    const config = loadMcpConfig();
    expect(config.port).toBe(3000);
  });

  it('reads MCP_LOG_LEVEL from env', () => {
    vi.stubEnv('MCP_LOG_LEVEL', 'debug');
    mockLoadConfig.mockReturnValue({
      baseUrl: 'https://test.atlassian.net',
      email: 'bot@test.com',
      token: 'tok_123',
    });

    const config = loadMcpConfig();
    expect(config.logLevel).toBe('debug');
  });

  it('sets jira to null when loadConfig throws', () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('Missing env vars');
    });

    const config = loadMcpConfig();
    expect(config.jira).toBeNull();
    expect(mockLoadConfig).toHaveBeenCalledTimes(1);
  });

  it('trims whitespace from env var values', () => {
    vi.stubEnv('MCP_TRANSPORT', '  http  ');
    vi.stubEnv('MCP_LOG_LEVEL', '  silent  ');
    mockLoadConfig.mockReturnValue({
      baseUrl: 'https://test.atlassian.net',
      email: 'bot@test.com',
      token: 'tok_123',
    });

    const config = loadMcpConfig();
    expect(config.transport).toBe('http');
    expect(config.logLevel).toBe('silent');
  });
});
