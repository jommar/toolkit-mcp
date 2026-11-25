/**
 * Core server contract through the real SDK: a runtime assembled from mock service clients is served by
 * `createServer(runtime)` and read through the official v2 client over an in-memory pair. No SDK
 * module is mocked; only the service-client constructors are replaced, so the factory guard can count them.
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const constructed = vi.hoisted(() => ({
  counts: { jira: 0, github: 0, figma: 0, confluence: 0, jenkins: 0, slack: 0 } as Record<string, number>,
  ping: vi.fn(async () => true),
}));

vi.mock('./services/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/index.js')>();
  const counted = (id: string) =>
    class {
      constructor() {
        constructed.counts[id]++;
      }
    };
  class FakeJenkinsClient extends counted('jenkins') {
    ping = constructed.ping;
  }
  return {
    ...actual,
    JiraClient: counted('jira'),
    GitHubClient: counted('github'),
    FigmaClient: counted('figma'),
    ConfluenceClient: counted('confluence'),
    JenkinsClient: FakeJenkinsClient,
    SlackClient: counted('slack'),
  };
});

import { assembleRuntime, buildRuntime, createServer, installProcessHooks } from './mcp-server.js';
import { modules } from './integrations/index.js';
import { healthDescriptor } from './mcp-health.js';
import { axiosError, closeTrackedClients, contentText, inputJsonSchema, trackedConnect } from './__fixtures__/mcp.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockClient = { client: any; calledMethods: () => string[] };

/** A service client whose named methods are given; any other method is a spy that rejects if called. */
function mockClient(methods: Record<string, Mock> = {}): MockClient {
  const extra = new Map<string, Mock>();
  const client = new Proxy(methods, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop in target) return target[prop];
      if (!extra.has(prop)) extra.set(prop, vi.fn(async () => Promise.reject(new Error(`unexpected call: ${prop}`))));
      return extra.get(prop);
    },
  });
  const calledMethods = () =>
    [...Object.entries(methods), ...extra.entries()].filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name);
  return { client, calledMethods };
}

const fakeLog = () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn() });

const MODULE_ENV = {
  JIRA_BASE_URL: 'https://jira.example.test',
  JIRA_EMAIL: 'user@example.test',
  JIRA_TOKEN: 'EXAMPLE-token',
  GH_TOKEN: 'EXAMPLE-token',
  FIGMA_TOKEN: 'EXAMPLE-token',
  JENKINS_URL: 'https://jenkins.example.test',
  JENKINS_USER: 'example',
  JENKINS_TOKEN: 'EXAMPLE-token',
  SLACK_ENABLED: 'true',
};

/** Every module's env is set, so a module is active only through its client (and env checks cannot hide one). */
function stubModuleEnv() {
  for (const [name, value] of Object.entries(MODULE_ENV)) vi.stubEnv(name, value);
  vi.stubEnv('MCP_LOG_LEVEL', 'silent');
}

const SLACK_TOOLS = [
  'slack_confirm_write',
  'slack_download_file',
  'slack_get_channels',
  'slack_get_messages',
  'slack_get_status',
  'slack_get_threads',
  'slack_get_users',
  'slack_login',
  'slack_logout',
  'slack_prepare_write',
  'slack_search_messages',
];

const MOCK_ISSUE = { key: 'TAP-1', summary: 'Example issue', status: 'Open', comments: [] };

let tempHome: string;

const connect = (runtime: unknown): Promise<Client> => trackedConnect(createServer(runtime as any));

function allMockClients() {
  return {
    jira: mockClient(),
    github: mockClient(),
    figma: mockClient(),
    confluence: mockClient(),
    jenkins: mockClient(),
    slack: mockClient(),
  };
}

function clientsOf(mocks: Record<string, MockClient>) {
  return Object.fromEntries(Object.entries(mocks).map(([id, m]) => [id, m.client]));
}

async function healthFlags(client: Client): Promise<Record<string, boolean>> {
  const result = await client.callTool({ name: 'mcp_get_health', arguments: {} });
  return JSON.parse(contentText(result)).integrations;
}

beforeAll(() => {
  tempHome = mkdtempSync(path.join(os.tmpdir(), 'toolkit-mcp-server-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
});

beforeEach(() => {
  stubModuleEnv();
});

afterEach(async () => {
  await closeTrackedClients();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe('tools/list contents', () => {
  it('lists 80 uniquely named tools: mcp_get_health first, then registry order, identical across two factory builds', async () => {
    const runtime = assembleRuntime(clientsOf(allMockClients()), fakeLog());
    const first = (await (await connect(runtime)).listTools()).tools;
    const second = (await (await connect(runtime)).listTools()).tools;

    const names = first.map((t) => t.name);
    expect(names).toHaveLength(80);
    expect(new Set(names).size).toBe(80);
    expect(names).toEqual(['mcp_get_health', ...modules.flatMap((m) => m.getToolDescriptors().map((d) => d.name))]);
    expect(modules.map((m) => m.id)).toEqual(['jira', 'github', 'figma', 'confluence', 'jenkins', 'slack']);
    expect(second).toEqual(first);
  });

  it('gives every tool a non-empty title and all four boolean hints, exactly as its descriptor declares them', async () => {
    const runtime = assembleRuntime(clientsOf(allMockClients()), fakeLog());
    const { tools } = await (await connect(runtime)).listTools();
    const declared = new Map(runtime.tools.map((d) => [d.name, d]));

    for (const tool of tools) {
      expect(typeof tool.title, tool.name).toBe('string');
      expect(tool.title!.trim().length, tool.name).toBeGreaterThan(0);
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
      expect({ title: tool.title, annotations: tool.annotations }, tool.name).toEqual({
        title: declared.get(tool.name)?.title,
        annotations: declared.get(tool.name)?.annotations,
      });
    }
  });
});

describe('tools/list schemas', () => {
  let tools: Awaited<ReturnType<Client['listTools']>>['tools'];
  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const variants = (schema: any): any[] => schema.anyOf ?? schema.oneOf ?? [];
  const constOf = (prop: any) => prop?.const ?? (prop?.enum?.length === 1 ? prop.enum[0] : undefined);

  beforeEach(async () => {
    const runtime = assembleRuntime(clientsOf(allMockClients()), fakeLog());
    tools = (await (await connect(runtime)).listTools()).tools;
  });

  it('shows github_get_prs limit bounds and default, and does not require it', () => {
    const schema = tool('github_get_prs').inputSchema as any;
    expect(schema.properties.limit).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
    expect(schema.required ?? []).not.toContain('limit');
  });

  it('shows slack_get_messages batch items with minItems and the link-or-{channel, ts} message union', () => {
    const messages = (tool('slack_get_messages').inputSchema as any).properties.messages;
    expect(messages.type).toBe('array');
    expect(messages.minItems).toBe(1);

    const message = messages.items.properties.message;
    const shapes = variants(message);
    expect(shapes.some((s) => s.type === 'string')).toBe(true);
    const ref = shapes.find((s) => s.type === 'object');
    expect(ref?.properties).toHaveProperty('channel');
    expect(ref?.properties).toHaveProperty('ts');
  });

  it('shows slack_prepare_write items as three variants keyed by action post, react, upload', () => {
    const items = (tool('slack_prepare_write').inputSchema as any).properties.items;
    expect(items.type).toBe('array');
    const actions = variants(items.items).map((v) => constOf(v.properties?.action));
    expect(actions.sort()).toEqual(['post', 'react', 'upload']);
  });

  it('publishes no $schema key in any input schema', () => {
    expect(tools.filter((t) => '$schema' in t.inputSchema).map((t) => t.name)).toEqual([]);
  });

  it('publishes for every tool the input schema the shared inputJsonSchema fixture derives from its descriptor', () => {
    const declared = new Map([healthDescriptor, ...modules.flatMap((m) => m.getToolDescriptors())].map((d) => [d.name, d]));
    for (const t of tools) expect(t.inputSchema, t.name).toEqual(inputJsonSchema(declared.get(t.name)!));
  });

  it('has no property with an empty description', () => {
    const empty: string[] = [];
    for (const t of tools) {
      for (const [prop, spec] of Object.entries(((t.inputSchema as any).properties ?? {}) as Record<string, any>)) {
        if ('description' in spec && !String(spec.description).trim()) empty.push(`${t.name}.${prop}`);
      }
    }
    expect(empty).toEqual([]);
  });
});

describe('tools/list size', () => {
  it('keeps the tools array JSON at or under 85000 bytes with all six modules registered', async () => {
    const runtime = assembleRuntime(clientsOf(allMockClients()), fakeLog());
    const { tools } = await (await connect(runtime)).listTools();
    expect(tools).toHaveLength(80);
    expect(Buffer.byteLength(JSON.stringify(tools), 'utf8')).toBeLessThanOrEqual(85_000);
  });
});

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

describe('tool errors', () => {
  it('returns an upstream 404 as an isError result with the status and detail, not a JSON-RPC error', async () => {
    const notFound = () => Promise.reject(axiosError(404, { errorMessages: ['Issue does not exist'] }));
    const jira = mockClient({ getIssue: vi.fn(notFound), getIssueSlim: vi.fn(notFound) });
    const client = await connect(assembleRuntime({ jira: jira.client }, fakeLog()));

    const result = await client.callTool({ name: 'jira_get_issues', arguments: { key: 'TAP-1' } });

    expect(result.isError).toBe(true);
    expect(contentText(result)).toBe('API error (404): Issue does not exist');
  });

  it('keeps the business-rule text when jira_get_issues gets neither key nor jql', async () => {
    const jira = mockClient();
    const client = await connect(assembleRuntime({ jira: jira.client }, fakeLog()));

    const result = await client.callTool({ name: 'jira_get_issues', arguments: {} });

    expect(result.isError).toBe(true);
    expect(contentText(result)).toBe('Provide either key or jql');
    expect(jira.calledMethods()).toEqual([]);
  });

  it('passes a slack.not_connected ProtocolError message through unchanged', async () => {
    const client = await connect(assembleRuntime({ slack: mockClient().client }, fakeLog()));

    const result = await client.callTool({ name: 'slack_get_channels', arguments: { channels: [{ member_only: true }] } });

    expect(result.isError).toBe(true);
    expect(contentText(result)).toMatch(/^slack\.not_connected: No Slack token is stored/);
  });
});

describe('input validation', () => {
  it('refuses github_get_prs limit 500 before any GitHub call, naming the field', async () => {
    const github = mockClient();
    const client = await connect(assembleRuntime({ github: github.client }, fakeLog()));

    const result = await client.callTool({ name: 'github_get_prs', arguments: { limit: 500 } });

    expect(result.isError).toBe(true);
    expect(contentText(result)).toContain('limit');
    expect(github.calledMethods()).toEqual([]);
  });

  it('refuses jira_transition_issue without a transition, with the refine message, before any Jira call', async () => {
    const jira = mockClient();
    const client = await connect(assembleRuntime({ jira: jira.client }, fakeLog()));

    const result = await client.callTool({ name: 'jira_transition_issue', arguments: { key: 'TAP-1' } });

    expect(result.isError).toBe(true);
    expect(contentText(result)).toContain('Provide either transitionId or transitionName');
    expect(jira.calledMethods()).toEqual([]);
  });

  it('applies the default limit 20 before the handler runs', async () => {
    // With `key` the handler never forwards `limit`; the JQL path does, so it observes the default.
    const search = vi.fn(async () => ({ issues: [], isLast: true }));
    const jira = mockClient({ search });
    const client = await connect(assembleRuntime({ jira: jira.client }, fakeLog()));

    const result = await client.callTool({ name: 'jira_get_issues', arguments: { jql: 'project = TAP' } });

    expect(result.isError).toBeFalsy();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]).toEqual(['project = TAP', expect.objectContaining({ maxResults: 20 })]);
  });
});

describe('unknown tool', () => {
  it('rejects tools/call for an unregistered name with -32602', async () => {
    const client = await connect(assembleRuntime(clientsOf(allMockClients()), fakeLog()));

    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });
});

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

describe('resources', () => {
  it('lists jira://myself and the three templates, each titled and application/json', async () => {
    const client = await connect(assembleRuntime({ jira: mockClient().client, github: mockClient().client }, fakeLog()));

    const { resources } = await client.listResources();
    const myself = resources.find((r) => r.uri === 'jira://myself');
    expect(myself).toBeDefined();
    expect(myself!.title).toBeTruthy();
    expect(myself!.mimeType).toBe('application/json');

    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(
      ['github://prs/{issueKey}', 'jira://issue/{key}', 'jira://search/{+jql}'].sort(),
    );
    for (const template of resourceTemplates) {
      expect(template.title, template.uriTemplate).toBeTruthy();
      expect(template.mimeType, template.uriTemplate).toBe('application/json');
    }
  });

  it('reads jira://issue/TAP-1 as the issue JSON', async () => {
    const getIssueSlim = vi.fn(async () => MOCK_ISSUE);
    const client = await connect(assembleRuntime({ jira: mockClient({ getIssueSlim }).client }, fakeLog()));

    const { contents } = await client.readResource({ uri: 'jira://issue/TAP-1' });

    expect(getIssueSlim).toHaveBeenCalledWith('TAP-1');
    expect(JSON.parse((contents[0] as { text: string }).text)).toEqual(MOCK_ISSUE);
  });

  it('decodes a JQL holding "/" before searchSlim', async () => {
    const searchSlim = vi.fn(async (_jql: string) => []);
    const client = await connect(assembleRuntime({ jira: mockClient({ searchSlim }).client }, fakeLog()));

    await client.readResource({ uri: 'jira://search/project%20%3D%20TAP%20AND%20text%20~%20a/b' });

    expect(searchSlim).toHaveBeenCalledTimes(1);
    expect(searchSlim.mock.calls[0][0]).toBe('project = TAP AND text ~ a/b');
  });
});

describe('resource errors', () => {
  it('reports an unknown jira URI as -32602 with data.uri', async () => {
    const client = await connect(assembleRuntime({ jira: mockClient().client }, fakeLog()));

    await expect(client.readResource({ uri: 'jira://nope/x' })).rejects.toMatchObject({
      code: -32602,
      data: { uri: 'jira://nope/x' },
    });
  });

  it('reports a malformed issue key as -32602 with the format message', async () => {
    const client = await connect(assembleRuntime({ jira: mockClient().client }, fakeLog()));

    await expect(client.readResource({ uri: 'jira://issue/notakey' })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining('Invalid issue key format'),
    });
  });

  it('reports an upstream 500 as -32603 with the API error text', async () => {
    const getIssueSlim = vi.fn(() => Promise.reject(axiosError(500, { message: 'Server exploded' })));
    const client = await connect(assembleRuntime({ jira: mockClient({ getIssueSlim }).client }, fakeLog()));

    await expect(client.readResource({ uri: 'jira://issue/TAP-1' })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringMatching(/API error \(500\)/),
    });
  });
});

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

describe('prompts', () => {
  const required = (args: Array<{ name: string; required?: boolean }> | undefined) =>
    (args ?? []).filter((a) => a.required).map((a) => a.name).sort();

  it('lists create-issue and triage-issue with their required arguments', async () => {
    const client = await connect(assembleRuntime({ jira: mockClient().client }, fakeLog()));

    const { prompts } = await client.listPrompts();
    const byName = Object.fromEntries(prompts.map((p) => [p.name, p]));

    expect(required(byName['create-issue']?.arguments)).toEqual(['issueType', 'projectKey', 'summary']);
    expect(required(byName['triage-issue']?.arguments)).toEqual(['key']);
  });

  it('builds the create-issue message from string arguments, splitting comma-separated labels', async () => {
    const client = await connect(assembleRuntime({ jira: mockClient().client }, fakeLog()));

    const result = await client.getPrompt({
      name: 'create-issue',
      arguments: { projectKey: 'TAP', issueType: 'Task', summary: 'Fix the widget', labels: 'a,b' },
    });

    const text = (result.messages[0].content as { text: string }).text;
    expect(text).toContain('project TAP');
    expect(text).toContain('Type: Task');
    expect(text).toContain('Summary: Fix the widget');
    expect(text).toContain('Labels: a, b');
  });

  it('rejects create-issue without summary as -32602', async () => {
    const client = await connect(assembleRuntime({ jira: mockClient().client }, fakeLog()));

    await expect(
      client.getPrompt({ name: 'create-issue', arguments: { projectKey: 'TAP', issueType: 'Task' } }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('rejects an unknown prompt as -32602', async () => {
    const client = await connect(assembleRuntime({ jira: mockClient().client }, fakeLog()));

    await expect(client.getPrompt({ name: 'nope', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });

  it('reports an upstream failure in triage-issue as -32603 with the detail, not as unknown', async () => {
    const getIssueSlim = vi.fn(() => Promise.reject(axiosError(500, { errorMessages: ['Upstream broke'] })));
    const client = await connect(assembleRuntime({ jira: mockClient({ getIssueSlim }).client }, fakeLog()));

    await expect(client.getPrompt({ name: 'triage-issue', arguments: { key: 'TAP-1' } })).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining('Upstream broke'),
    });
  });
});

// ---------------------------------------------------------------------------
// conditional registration
// ---------------------------------------------------------------------------

describe('conditional registration', () => {
  it('with no clients: tools capability only, exactly mcp_get_health, six false flags', async () => {
    const client = await connect(assembleRuntime({}, fakeLog()));

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.resources).toBeUndefined();
    expect(capabilities?.prompts).toBeUndefined();

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['mcp_get_health']);
    expect(await healthFlags(client)).toEqual({
      jira: false,
      github: false,
      figma: false,
      confluence: false,
      jenkins: false,
      slack: false,
    });
  });

  it('skips and logs a module that lacks a handler for one of its descriptors, while health and the other modules still serve', async () => {
    const figma = modules.find((m) => m.id === 'figma')!;
    const [dropped] = figma.getToolDescriptors();
    const original = figma.createToolHandlers.bind(figma);
    const spy = vi.spyOn(figma, 'createToolHandlers').mockImplementation((clients) => {
      const { [dropped.name]: _missing, ...rest } = original(clients);
      return rest;
    });
    const log = fakeLog();

    try {
      const runtime = assembleRuntime(clientsOf(allMockClients()), log);
      const client = await connect(runtime);

      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual([
        'mcp_get_health',
        ...modules.filter((m) => m !== figma).flatMap((m) => m.getToolDescriptors().map((d) => d.name)),
      ]);
      expect(log.error.mock.calls.flat().join(' ')).toContain('figma');
      const health = await client.callTool({ name: 'mcp_get_health', arguments: {} });
      expect(health.isError).toBeFalsy();
      const others = await client.callTool({ name: 'jira_get_issues', arguments: {} });
      expect(contentText(others)).toBe('Provide either key or jql');
    } finally {
      spy.mockRestore();
    }
  });

  it('with only a Slack client: exactly the eleven slack tools are added and health reports slack', async () => {
    const client = await connect(assembleRuntime({ slack: mockClient().client }, fakeLog()));

    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names[0]).toBe('mcp_get_health');
    expect(names.slice(1).sort()).toEqual(SLACK_TOOLS);
    expect(await healthFlags(client)).toEqual({
      jira: false,
      github: false,
      figma: false,
      confluence: false,
      jenkins: false,
      slack: true,
    });
  });
});

// ---------------------------------------------------------------------------
// factory guard
// ---------------------------------------------------------------------------

describe('factory', () => {
  it('builds clients, pings Jenkins and creates handlers once, however many servers the factory makes', async () => {
    for (const id of Object.keys(constructed.counts)) constructed.counts[id] = 0;
    constructed.ping.mockClear();
    const handlerSpies = modules.map((m) => vi.spyOn(m, 'createToolHandlers'));

    const runtime = await buildRuntime(fakeLog());
    for (let i = 0; i < 3; i++) {
      const client = await connect(runtime);
      expect((await client.listTools()).tools).toHaveLength(80);
    }

    for (const [id, count] of Object.entries(constructed.counts)) expect(count, `${id} constructor`).toBeLessThanOrEqual(1);
    expect(constructed.ping).toHaveBeenCalledTimes(1);
    for (const [i, spy] of handlerSpies.entries()) {
      expect(spy, `${modules[i].id}.createToolHandlers`).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// process hooks
// ---------------------------------------------------------------------------

describe('process hooks', () => {
  // Contract: installProcessHooks(target, stdin, log, shutdown) — `shutdown(code)` is the only exit path.
  function install() {
    const target = new EventEmitter();
    const stdin = new EventEmitter();
    const log = fakeLog();
    const shutdown = vi.fn(async (_code: number) => {});
    installProcessHooks(target as any, stdin as any, log as any, shutdown);
    return { target, stdin, log, shutdown };
  }
  type Hooks = ReturnType<typeof install>;

  it.each([
    ['SIGTERM', (h: Hooks) => h.target.emit('SIGTERM')],
    ['SIGINT', (h: Hooks) => h.target.emit('SIGINT')],
    ['stdin end', (h: Hooks) => h.stdin.emit('end')],
  ])('%s runs shutdown once with exit code 0', async (_label, trigger) => {
    const hooks = install();

    trigger(hooks);
    trigger(hooks);
    await new Promise((r) => setImmediate(r));

    expect(hooks.shutdown).toHaveBeenCalledTimes(1);
    expect(hooks.shutdown).toHaveBeenCalledWith(0);
  });

  it('runs shutdown once when several shutdown triggers arrive', async () => {
    const hooks = install();

    hooks.target.emit('SIGTERM');
    hooks.target.emit('SIGINT');
    hooks.stdin.emit('end');
    await new Promise((r) => setImmediate(r));

    expect(hooks.shutdown).toHaveBeenCalledTimes(1);
    expect(hooks.shutdown).toHaveBeenCalledWith(0);
  });

  it('logs an unhandled rejection and keeps serving', async () => {
    const hooks = install();

    hooks.target.emit('unhandledRejection', new Error('stray rejection'), Promise.resolve());
    await new Promise((r) => setImmediate(r));

    expect(hooks.log.error).toHaveBeenCalled();
    expect(hooks.log.error.mock.calls.flat().join(' ')).toContain('stray rejection');
    expect(hooks.shutdown).not.toHaveBeenCalled();
  });

  it('logs an uncaught exception and requests exit code 1', async () => {
    const hooks = install();

    hooks.target.emit('uncaughtException', new Error('stray throw'));
    await new Promise((r) => setImmediate(r));

    expect(hooks.log.error).toHaveBeenCalled();
    expect(hooks.log.error.mock.calls.flat().join(' ')).toContain('stray throw');
    expect(hooks.shutdown).toHaveBeenCalledWith(1);
  });
});
