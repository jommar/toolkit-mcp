import type { Logger } from './integrations/register.js';

export type LogLevel = 'silent' | 'info' | 'debug';

export interface McpConfig {
  logLevel: LogLevel;
}

const VALID_LOG_LEVELS = new Set<string>(['silent', 'info', 'debug']);

export function loadMcpConfig(): McpConfig {
  const rawLogLevel = process.env.MCP_LOG_LEVEL?.trim() || 'info';
  if (!VALID_LOG_LEVELS.has(rawLogLevel)) {
    console.error(`[mcp] Invalid MCP_LOG_LEVEL "${rawLogLevel}"; falling back to "info"`);
  }
  const logLevel = (VALID_LOG_LEVELS.has(rawLogLevel) ? rawLogLevel : 'info') as LogLevel;
  return { logLevel };
}

/** Every line goes to stderr; stdout is the protocol. */
export function createLogger(level: LogLevel): Logger {
  const write = (line: string) => {
    process.stderr.write(`[mcp] ${line}\n`);
  };
  return {
    info: (line) => {
      if (level !== 'silent') write(line);
    },
    debug: (line) => {
      if (level === 'debug') write(line);
    },
    error: (line) => {
      if (level !== 'silent') write(line);
    },
  };
}
