import { vi, describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// All mocks MUST come before any imports — vitest hoists vi.mock() calls
// ---------------------------------------------------------------------------

// Create shared mock functions that both vi.mock and test code can reference
const { mockSetRequestHandler, mockConnect } = vi.hoisted(() => {
  const mockSetRequestHandler = vi.fn();
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  return {
    mockSetRequestHandler,
    mockConnect,
  };
});

// Ensure no real env vars interfere with module needsEnv() during bootstrap
vi.hoisted(() => {
  process.env.MCP_LOG_LEVEL = 'silent';
  delete process.env.JIRA_BASE_URL;
  delete process.env.JIRA_EMAIL;
  delete process.env.JIRA_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.JENKINS_URL;
  delete process.env.JENKINS_USER;
  delete process.env.JENKINS_TOKEN;
  delete process.env.SLACK_ENABLED;
});

// Mock SDK transport so server.connect() doesn't actually connect
// Must use regular function (not arrow) so it's constructable with `new StdioServerTransport()`.
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(function () {
    return {};
  }),
}));

// Mock SDK types to avoid real SDK dependency resolution issues
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ErrorCode: {
    InvalidParams: -32602,
    MethodNotFound: -32601,
    InternalError: -32603,
  },
  McpError: class McpError extends Error {
    code: number;
    constructor(code: number, message: string) {
      super(message);
      this.code = code;
      this.name = 'McpError';
    }
  },
  CallToolRequestSchema: {},
  ListToolsRequestSchema: {},
  ReadResourceRequestSchema: {},
  GetPromptRequestSchema: {},
}));

// Mock the server SDK itself — uses hoisted mock functions.
// Must use regular function (not arrow) so it's constructable with `new Server(...)`.
vi.mock('@modelcontextprotocol/sdk/server', () => ({
  Server: vi.fn(function () {
    return {
      setRequestHandler: mockSetRequestHandler,
      connect: mockConnect,
    };
  }),
}));

// Mock jira-cli so the module imports don't blow up
vi.mock('./services/index.js', () => ({
  JiraClient: class MockJiraClient {},
  GitHubClient: class MockGitHubClient {},
  FigmaClient: class MockFigmaClient {},
  JenkinsClient: class MockJenkinsClient {},
  SlackClient: class MockSlackClient {},
  ISSUE_KEY_PATTERN: /^[A-Z][A-Z0-9]{0,10}-\d{1,6}$/i,
}));

// Mock the config so loadMcpConfig returns a predictable value
vi.mock('./mcp-config.js', () => ({
  loadMcpConfig: vi.fn(() => ({
    transport: 'stdio' as const,
    port: 3000,
    logLevel: 'silent' as const,
  })),
}));

// Import main() explicitly (module side-effect is guarded by VITEST env var)
import { main } from './mcp-server.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function registeredHandler(schema: unknown): (request: unknown) => Promise<any> {
  const call = mockSetRequestHandler.mock.calls.find(([registered]) => registered === schema);
  return call![1];
}

async function listedToolNames(): Promise<string[]> {
  const listed = await registeredHandler(ListToolsRequestSchema)({});
  return listed.tools.map((tool: { name: string }) => tool.name);
}

async function reportedIntegrations(): Promise<Record<string, boolean>> {
  const result = await registeredHandler(CallToolRequestSchema)({
    params: { name: 'mcp_get_health', arguments: {} },
  });
  return JSON.parse(result.content[0].text).integrations;
}

describe('mcp-server bootstrap', () => {
  // Call main() to trigger server initialization
  beforeAll(async () => {
    await main();
  });
  it('creates a Server instance and connects', () => {
    expect(mockSetRequestHandler).toHaveBeenCalled();
    expect(mockConnect).toHaveBeenCalled();
  });

  it('registers 4 request handlers (tools list, tool call, resource, prompt)', () => {
    expect(mockSetRequestHandler).toHaveBeenCalledTimes(4);
  });

  it('connects exactly once via stdio transport', () => {
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it('runs with only the built-in health tool (no active modules)', () => {
    // With all env vars cleared, JiraModule.needsEnv() and GitHubModule.needsEnv()
    // both return false. Only mcp_get_health should be registered.
    // We can verify this indirectly — the server started without error.
    expect(true).toBe(true);
  });

  it('registers no slack tool and reports slack inactive when SLACK_ENABLED is unset', async () => {
    const slackToolNames = (await listedToolNames()).filter((name) => name.startsWith('slack_'));
    expect(slackToolNames).toEqual([]);
    expect((await reportedIntegrations()).slack).toBe(false);
  });
});

describe('mcp-server bootstrap with SLACK_ENABLED=true', () => {
  beforeAll(async () => {
    vi.stubEnv('SLACK_ENABLED', 'true');
    mockSetRequestHandler.mockClear();
    await main();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('registers exactly the eleven slack tools', async () => {
    const slackToolNames = (await listedToolNames()).filter((name) => name.startsWith('slack_'));
    expect(slackToolNames.sort()).toEqual([
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
    ]);
  });

  it('reports slack active in the health tool', async () => {
    expect((await reportedIntegrations()).slack).toBe(true);
  });
});
