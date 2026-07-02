import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export interface HealthResult {
  serverVersion: string;
  integrations: {
    jira: boolean;
    github: boolean;
    figma: boolean;
    confluence: boolean;
  };
}

export function createHealthHandler(
  jiraActive: boolean,
  githubActive: boolean,
  figmaActive: boolean,
  confluenceActive = false,
) {
  return async (args: unknown): Promise<{ content: { type: 'text'; text: string }[] }> => {
    if (args != null && typeof args === 'object' && Object.keys(args as Record<string, unknown>).length > 0) {
      throw new McpError(ErrorCode.InvalidParams, 'mcp_get_health does not accept parameters');
    }
    const result: HealthResult = {
      serverVersion: '0.1.0',
      integrations: {
        jira: jiraActive,
        github: githubActive,
        figma: figmaActive,
        confluence: confluenceActive,
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };
}
