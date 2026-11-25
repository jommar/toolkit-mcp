import type { EventEmitter } from 'node:events';
import os from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { SkillsExtension } from '@modelcontextprotocol/server/ext/skills';
import { JiraClient, GitHubClient, FigmaClient, ConfluenceClient, JenkinsClient, SlackClient } from './services/index.js';
import { slackPaths } from './services/slack/credential-store.js';
import { createLogger, loadMcpConfig } from './mcp-config.js';
import { createHealthHandler, healthDescriptor } from './mcp-health.js';
import { loadServedSkills } from './mcp-skills.js';
import { modules } from './integrations/index.js';
import { messageOf } from './integrations/helpers.js';
import {
  registerModulePrompts,
  registerModuleResources,
  registerModuleTools,
  type Logger,
} from './integrations/register.js';
import type {
  PromptDescriptor,
  PromptHandlerFn,
  ResourceDescriptor,
  ResourceHandlerFn,
  ToolDescriptor,
  ToolHandlerFn,
} from './integrations/index.js';
import { NODE_ENGINES, SERVER_INFO } from './server-info.js';

/** What every connection's server registers. Built once per process, so each module's handlers exist once. */
export interface Runtime {
  log: Logger;
  tools: ToolDescriptor[];
  toolHandlers: Record<string, ToolHandlerFn>;
  resources: Array<{ descriptors: ResourceDescriptor[]; handler: ResourceHandlerFn }>;
  prompts: Array<{ descriptors: PromptDescriptor[]; handler: PromptHandlerFn }>;
  /** The served skills catalog (MCP Skills extension); absent when it could not be loaded. */
  skills?: SkillsExtension;
}

type Clients = Record<string, unknown>;

/** The tool, prompt and resource lists are fixed for the life of the process, so clients may cache them for an hour. */
const HOUR_PRIVATE_CACHE = { ttlMs: 3_600_000, cacheScope: 'private' as const };
const LIST_CACHE_HINTS = {
  'tools/list': HOUR_PRIVATE_CACHE,
  'prompts/list': HOUR_PRIVATE_CACHE,
  'resources/list': HOUR_PRIVATE_CACHE,
  'resources/templates/list': HOUR_PRIVATE_CACHE,
};
/** Longest shutdown waits for queued stdout to reach the reader, so a stuck or gone pipe cannot hang the exit. */
const STDOUT_FLUSH_TIMEOUT_MS = 3_000;

/** The major of an `engines.node` range such as `>=24`, the lowest Node the package declares it runs on. */
function majorOfEnginesRange(range: string): number {
  const match = /^>=\s*(\d+)$/.exec(range.trim());
  if (!match) throw new Error(`package.json engines.node must be ">=<major>", got "${range}"`);
  return Number(match[1]);
}

export const MINIMUM_NODE_MAJOR: number = majorOfEnginesRange(NODE_ENGINES);

/**
 * Throws when `version` (as in `process.version`, e.g. `v23.9.0`) has a major below `minimumMajor`.
 * An unparsable version fails the check.
 */
export function assertSupportedNode(version: string, minimumMajor: number): void {
  const major = Number(/^v(\d+)\./.exec(version)?.[1]);
  if (!(major >= minimumMajor)) {
    throw new Error(
      `toolkit-mcp needs Node ${minimumMajor} or later; this process runs Node ${version}. Start it with the Node in .nvmrc (bin/toolkit-mcp selects it).`,
    );
  }
}

function createClient<T>(name: string, log: Logger, create: () => T): T | undefined {
  try {
    const client = create();
    log.info(`${name} created successfully`);
    return client;
  } catch (err) {
    log.error(`Failed to create ${name}: ${messageOf(err)}`);
    return undefined;
  }
}

/** Constructs the service clients whose integrations are enabled by the environment, then assembles the runtime. */
export async function buildRuntime(log: Logger): Promise<Runtime> {
  const env = process.env;
  const jiraActive = !!(env.JIRA_BASE_URL && env.JIRA_EMAIL && env.JIRA_TOKEN);
  const githubActive = !!env.GH_TOKEN;
  const figmaActive = !!env.FIGMA_TOKEN;
  const confluenceActive = !!(
    (env.CONFLUENCE_BASE_URL || env.JIRA_BASE_URL) &&
    (env.CONFLUENCE_EMAIL || env.JIRA_EMAIL) &&
    (env.CONFLUENCE_TOKEN || env.JIRA_TOKEN)
  );
  const jenkinsActive = !!(env.JENKINS_URL && env.JENKINS_USER && env.JENKINS_TOKEN);
  const slackActive = env.SLACK_ENABLED === 'true';

  log.info(`Jira integration: ${jiraActive ? 'active' : 'inactive'}`);
  log.info(`GitHub integration: ${githubActive ? 'active' : 'inactive'}`);
  log.info(`Figma integration: ${figmaActive ? 'active' : 'inactive'}`);
  log.info(`Confluence integration: ${confluenceActive ? 'active' : 'inactive'}`);
  log.info(`Jenkins integration: ${jenkinsActive ? 'active' : 'inactive'}`);
  log.info(`Slack integration: ${slackActive ? 'active' : 'inactive'}`);

  const clients: Clients = {};
  if (jiraActive) clients.jira = createClient('JiraClient', log, () => new JiraClient());
  if (githubActive) clients.github = createClient('GitHubClient', log, () => new GitHubClient());
  if (figmaActive) clients.figma = createClient('FigmaClient', log, () => new FigmaClient());
  if (confluenceActive) clients.confluence = createClient('ConfluenceClient', log, () => new ConfluenceClient());
  if (slackActive) clients.slack = createClient('SlackClient', log, () => new SlackClient(slackPaths(os.homedir())));
  if (jenkinsActive) {
    try {
      const jenkins = new JenkinsClient();
      if (await jenkins.ping()) {
        clients.jenkins = jenkins;
        log.info('JenkinsClient created successfully');
      } else {
        log.info('Jenkins unreachable — skipping Jenkins tools (server down or blocked)');
      }
    } catch (err) {
      log.error(`Failed to create JenkinsClient: ${messageOf(err)}`);
    }
  }

  const runtime = assembleRuntime(clients, log);
  runtime.skills = await loadServedSkills(log);
  return runtime;
}

/** Collects every eligible module's descriptors and handlers. Each module's handler factory runs here, once. */
export function assembleRuntime(clients: Clients, log: Logger): Runtime {
  const runtime: Runtime = {
    log,
    tools: [healthDescriptor],
    toolHandlers: {
      [healthDescriptor.name]: createHealthHandler(
        !!clients.jira,
        !!clients.github,
        !!clients.figma,
        !!clients.confluence,
        !!clients.jenkins,
        !!clients.slack,
      ),
    },
    resources: [],
    prompts: [],
  };

  for (const mod of modules) {
    if (!mod.needsEnv()) continue;
    if (!clients[mod.id]) {
      log.info(`Module ${mod.id} skipped: client not available (credentials may be invalid)`);
      continue;
    }

    try {
      const tools = mod.getToolDescriptors();
      const handlers = mod.createToolHandlers(clients);
      const unhandled = tools.find((tool) => !handlers[tool.name]);
      if (unhandled) throw new Error(`No handler for tool ${unhandled.name}`);
      const resources =
        mod.getResourceHandler && mod.getResourceDescriptors
          ? { descriptors: mod.getResourceDescriptors(), handler: mod.getResourceHandler(clients) }
          : undefined;
      const prompts =
        mod.getPromptHandler && mod.getPromptDescriptors
          ? { descriptors: mod.getPromptDescriptors(), handler: mod.getPromptHandler(clients) }
          : undefined;

      runtime.tools.push(...tools);
      Object.assign(runtime.toolHandlers, handlers);
      if (resources) runtime.resources.push(resources);
      if (prompts) runtime.prompts.push(prompts);
      log.info(`Module registered: ${mod.id}`);
    } catch (err) {
      log.error(`Failed to register module ${mod.id}: ${messageOf(err)}`);
    }
  }

  log.info(
    `Registered ${runtime.tools.length} tools, ${runtime.resources.length} resource groups, ${runtime.prompts.length} prompt groups`,
  );
  return runtime;
}

/** A new, unconnected server with the runtime's tools, resources, prompts and skills. Creates no client and makes no network call. */
export function createServer(runtime: Runtime): McpServer {
  const server = new McpServer(SERVER_INFO, { cacheHints: LIST_CACHE_HINTS });
  registerModuleTools(server, runtime.tools, runtime.toolHandlers, runtime.log);
  for (const { descriptors, handler } of runtime.resources) registerModuleResources(server, descriptors, handler);
  for (const { descriptors, handler } of runtime.prompts) registerModulePrompts(server, descriptors, handler);
  runtime.skills?.attach(server);
  return server;
}

/**
 * Routes process-level events to one shutdown. Stop signals and stdin end call `shutdown(0)` once in total;
 * an uncaught exception is logged and calls `shutdown(1)`; an unhandled rejection is logged and the server keeps serving.
 */
export function installProcessHooks(
  target: EventEmitter,
  stdin: EventEmitter,
  log: Logger,
  shutdown: (code: number) => unknown,
): void {
  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    void shutdown(code);
  };
  target.on('SIGTERM', () => stop(0));
  target.on('SIGINT', () => stop(0));
  stdin.on('end', () => stop(0));

  target.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${messageOf(reason)}`);
  });
  target.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${messageOf(err)}`);
    stop(1);
  });
}

/**
 * Resolves once everything written to stdout so far has been handed to the OS, on a stdout error (EPIPE: the reader
 * is gone), or after STDOUT_FLUSH_TIMEOUT_MS. Writes are ordered, so the empty write's callback runs after them.
 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      process.stdout.off('error', settle);
      resolve();
    };
    timer = setTimeout(settle, STDOUT_FLUSH_TIMEOUT_MS);
    process.stdout.once('error', settle);
    process.stdout.write('', settle);
  });
}

export async function main(): Promise<void> {
  try {
    assertSupportedNode(process.version, MINIMUM_NODE_MAJOR);
  } catch (err) {
    console.error(messageOf(err));
    process.exit(1);
  }

  const log = createLogger(loadMcpConfig().logLevel);
  log.info(`toolkit-mcp ${SERVER_INFO.version} starting`);

  let handle: StdioServerHandle | undefined;
  const shutdown = async (code: number) => {
    try {
      await handle?.close();
    } catch (err) {
      log.error(`Shutdown error: ${messageOf(err)}`);
    }
    await flushStdout();
    process.exit(code);
  };
  installProcessHooks(process, process.stdin, log, shutdown);

  const runtime = await buildRuntime(log);
  handle = serveStdio(() => createServer(runtime), {
    onerror: (err) => log.error(`Transport error: ${err.message}`),
  });
}

const runningDirectly = !process.env.VITEST;
if (runningDirectly) {
  main().catch((err) => {
    console.error(`[mcp] Fatal error: ${messageOf(err)}`);
    process.exit(1);
  });
}
