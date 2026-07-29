export interface McpConfig {
  transport: 'stdio' | 'http';
  port: number;
  logLevel: 'silent' | 'info' | 'debug';
}

const VALID_TRANSPORTS = new Set(['stdio', 'http']);
const VALID_LOG_LEVELS = new Set(['silent', 'info', 'debug']);

export function loadMcpConfig(): McpConfig {
  const rawTransport = process.env.MCP_TRANSPORT?.trim() || 'stdio';
  if (!VALID_TRANSPORTS.has(rawTransport)) {
    console.error(`[mcp] Invalid MCP_TRANSPORT "${rawTransport}"; falling back to "stdio"`);
  }
  const transport = (VALID_TRANSPORTS.has(rawTransport) ? rawTransport : 'stdio') as 'stdio' | 'http';

  const port = Number(process.env.MCP_PORT?.trim()) || 3000;

  const rawLogLevel = process.env.MCP_LOG_LEVEL?.trim() || 'info';
  if (!VALID_LOG_LEVELS.has(rawLogLevel)) {
    console.error(`[mcp] Invalid MCP_LOG_LEVEL "${rawLogLevel}"; falling back to "info"`);
  }
  const logLevel = (VALID_LOG_LEVELS.has(rawLogLevel) ? rawLogLevel : 'info') as 'silent' | 'info' | 'debug';

  return { transport, port, logLevel };
}
