import { z } from 'zod';
import type { ToolDescriptor, ToolHandlerFn } from './integrations/index.js';
import { READ_ONLY_HINTS } from './integrations/register.js';
import { SERVER_INFO } from './server-info.js';

export interface HealthResult {
  serverVersion: string;
  integrations: {
    jira: boolean;
    github: boolean;
    figma: boolean;
    confluence: boolean;
    jenkins: boolean;
    slack: boolean;
  };
}

/** The built-in health tool. Its schema is strict and empty, so the SDK refuses any argument before the handler runs. */
export const healthDescriptor: ToolDescriptor = {
  name: 'mcp_get_health',
  title: 'Integration health',
  description: 'Report which integrations are active.',
  inputSchema: z.strictObject({}),
  annotations: { ...READ_ONLY_HINTS, openWorldHint: false },
};

export function createHealthHandler(
  jiraActive: boolean,
  githubActive: boolean,
  figmaActive: boolean,
  confluenceActive = false,
  jenkinsActive = false,
  slackActive = false,
): ToolHandlerFn {
  return async () => {
    const result: HealthResult = {
      serverVersion: SERVER_INFO.version,
      integrations: {
        jira: jiraActive,
        github: githubActive,
        figma: figmaActive,
        confluence: confluenceActive,
        jenkins: jenkinsActive,
        slack: slackActive,
      },
    };
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  };
}
