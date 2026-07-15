import { Server } from '@modelcontextprotocol/sdk/server';
import {
  ErrorCode,
  McpError,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { JiraClient, GitHubClient, FigmaClient, ConfluenceClient, JenkinsClient } from './services/index.js';
import { z } from 'zod';
import { loadMcpConfig } from './mcp-config.js';
import { createHealthHandler } from './mcp-health.js';
import { modules } from './integrations/index.js';
import type { ToolHandlerFn, ToolDescriptor } from './integrations/index.js';

export async function main(): Promise<void> {
  const config = loadMcpConfig();
  const log = (msg: string) => {
    if (config.logLevel !== 'silent') {
      console.error(`[mcp] ${msg}`);
    }
  };

  log('toolkit-mcp starting...');

  // Determine which integrations are active based on env vars
  const jiraActive = !!(process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_TOKEN);
  const githubActive = !!process.env.GH_TOKEN;
  const figmaActive = !!process.env.FIGMA_TOKEN;
  const confluenceActive = !!(
    (process.env.CONFLUENCE_BASE_URL || process.env.JIRA_BASE_URL) &&
    (process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL) &&
    (process.env.CONFLUENCE_TOKEN || process.env.JIRA_TOKEN)
  );
  const jenkinsActive = !!(process.env.JENKINS_URL && process.env.JENKINS_USER && process.env.JENKINS_TOKEN);

  log(`Jira integration: ${jiraActive ? 'active' : 'inactive'}`);
  log(`GitHub integration: ${githubActive ? 'active' : 'inactive'}`);
  log(`Figma integration: ${figmaActive ? 'active' : 'inactive'}`);
  log(`Confluence integration: ${confluenceActive ? 'active' : 'inactive'}`);
  log(`Jenkins integration: ${jenkinsActive ? 'active' : 'inactive'}`);

  // Create client instances for active integrations only
  const clients: Record<string, unknown> = {};
  if (jiraActive) {
    try {
      clients.jira = new JiraClient();
      log('JiraClient created successfully');
    } catch (err) {
      log(`Failed to create JiraClient: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (githubActive) {
    try {
      clients.github = new GitHubClient();
      log('GitHubClient created successfully');
    } catch (err) {
      log(`Failed to create GitHubClient: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (figmaActive) {
    try {
      clients.figma = new FigmaClient();
      log('FigmaClient created successfully');
    } catch (err) {
      log(`Failed to create FigmaClient: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (confluenceActive) {
    try {
      clients.confluence = new ConfluenceClient();
      log('ConfluenceClient created successfully');
    } catch (err) {
      log(`Failed to create ConfluenceClient: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (jenkinsActive) {
    try {
      clients.jenkins = new JenkinsClient();
      log('JenkinsClient created successfully');
    } catch (err) {
      log(`Failed to create JenkinsClient: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Create server
  const server = new Server(
    { name: 'toolkit-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  // Collect handlers and descriptors from all eligible modules
  const allHandlers: Record<string, ToolHandlerFn> = {};
  const allDescriptors: ToolDescriptor[] = [];
  const resourceHandlers: Array<(uri: string) => Promise<any>> = [];
  const promptHandlers: Array<(name: string, args: Record<string, unknown> | undefined) => Promise<any>> = [];

  // Always register built-in health tool
  const healthHandler = createHealthHandler(
    !!clients.jira,
    !!clients.github,
    !!clients.figma,
    !!clients.confluence,
    !!clients.jenkins,
  );
  allHandlers['mcp_get_health'] = healthHandler;
  allDescriptors.push({
    name: 'mcp_get_health',
    description: 'Report which integrations are active.',
    inputSchema: { type: 'object', properties: {} },
  });

  for (const mod of modules) {
    if (!mod.needsEnv()) continue;

    // Skip module if its required client failed to construct
    const clientKey = mod.id;
    if (!clients[clientKey]) {
      log(`Module ${mod.id} skipped: client not available (credentials may be invalid)`);
      continue;
    }

    try {
      const handlers = mod.createToolHandlers(clients);
      for (const [name, handler] of Object.entries(handlers)) {
        allHandlers[name] = handler;
      }
      allDescriptors.push(...mod.getToolDescriptors());

      if (mod.getResourceHandler) {
        const rh = mod.getResourceHandler(clients);
        resourceHandlers.push(rh);
      }

      if (mod.getPromptHandler) {
        const ph = mod.getPromptHandler(clients);
        promptHandlers.push(ph);
      }

      log(`Module registered: ${mod.id}`);
    } catch (err) {
      log(`Failed to register module ${mod.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(`Registered ${Object.keys(allHandlers).length} tools, ${resourceHandlers.length} resource groups, ${promptHandlers.length} prompt groups`);

  // -----------------------------------------------------------------------
  // Central dispatch for tools
  // -----------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = allHandlers[name];
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try {
      return await handler((args as Record<string, unknown>) ?? {});
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (err instanceof z.ZodError) {
        throw new McpError(ErrorCode.InvalidParams, `Validation error: ${err.message}`);
      }
      throw new McpError(
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // -----------------------------------------------------------------------
  // Central dispatch for tool listing
  // -----------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allDescriptors,
  }));

  // -----------------------------------------------------------------------
  // Central dispatch for resources
  // -----------------------------------------------------------------------
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    let lastError: Error | undefined;
    for (const rh of resourceHandlers) {
      try {
        return await rh(uri);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Continue to next handler
      }
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      lastError?.message ?? `Unknown resource: ${uri}`,
    );
  });

  // -----------------------------------------------------------------------
  // Central dispatch for prompts
  // -----------------------------------------------------------------------
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let lastError: Error | undefined;
    for (const ph of promptHandlers) {
      try {
        return await ph(name, args as Record<string, unknown> | undefined);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Continue to next handler
      }
    }
    throw new McpError(
      ErrorCode.MethodNotFound,
      `Unknown prompt: ${name}`,
    );
  });

  // -----------------------------------------------------------------------
  // Start transport
  // -----------------------------------------------------------------------
  log(`Transport: ${config.transport}`);

  if (config.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    log('HTTP transport not yet implemented; falling back to stdio');
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}

const runningDirectly = !process.env.VITEST;
if (runningDirectly) {
  main().catch((err) => {
    console.error(`[mcp] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
