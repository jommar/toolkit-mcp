import { loadConfig } from './services/config.js';

export interface McpConfig {
  transport: 'stdio' | 'http';
  port: number;
  logLevel: 'silent' | 'info' | 'debug';
  jira: { baseUrl: string; email: string; token: string } | null;
}

export function loadMcpConfig(): McpConfig {
  const transport = (process.env.MCP_TRANSPORT?.trim() as 'stdio' | 'http') ?? 'stdio';
  const port = Number(process.env.MCP_PORT?.trim()) || 3000;
  const logLevel = (process.env.MCP_LOG_LEVEL?.trim() as 'silent' | 'info' | 'debug') ?? 'info';

  let jira: { baseUrl: string; email: string; token: string } | null = null;
  try {
    const config = loadConfig();
    jira = { baseUrl: config.baseUrl, email: config.email, token: config.token };
  } catch {
    // Jira env vars are missing — this is fine; module will check needsEnv()
    jira = null;
  }

  return { transport, port, logLevel, jira };
}
