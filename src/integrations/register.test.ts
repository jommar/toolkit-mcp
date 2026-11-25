/**
 * The registry adapter's own logic: how errors become tool text and protocol errors, and the per-call
 * debug line, through a real McpServer and the official v2 client. Synthetic descriptors only.
 * Tool, resource and prompt error behaviour end to end is proven in src/mcp-server.test.ts.
 */
import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describeToolError, registerModuleTools, toProtocolError } from './register.js';
import type { ToolDescriptor } from './index.js';
import { createLogger } from '../mcp-config.js';
import { axiosError, closeTrackedClients, trackedConnect } from '../__fixtures__/mcp.js';

const HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function descriptor(name: string): ToolDescriptor {
  const inputSchema = z.object({ text: z.string().optional() });
  return { name, title: `Title ${name}`, description: `Does ${name}.`, inputSchema, annotations: HINTS };
}

const newServer = () => new McpServer({ name: 'register-test', version: '0.0.0' });

afterEach(async () => {
  await closeTrackedClients();
  vi.restoreAllMocks();
});

describe('describeToolError', () => {
  it('passes a ProtocolError message through unchanged', () => {
    const err = new ProtocolError(ProtocolErrorCode.InvalidRequest, 'slack.not_connected: No Slack token. Run slack_login.');
    expect(describeToolError(err)).toBe('slack.not_connected: No Slack token. Run slack_login.');
  });

  it('prefixes a ZodError with "Validation error: "', () => {
    const parsed = z.object({ a: z.string() }).safeParse({});
    expect(parsed.success).toBe(false);
    expect(describeToolError(parsed.error)).toMatch(/^Validation error: /);
  });

  it.each([
    ['message', { message: 'Bad thing' }, 'API error (400): Bad thing'],
    ['errorMessages', { errorMessages: ['One', 'Two'] }, 'API error (400): One; Two'],
    ['error', { error: 'Nope' }, 'API error (400): Nope'],
    ['no body detail', {}, 'API error (400): Request failed with status code 400'],
  ])('formats an axios error with status and detail from %s', (_label, data, text) => {
    expect(describeToolError(axiosError(400, data))).toBe(text);
  });

  it('uses the message of a plain Error and stringifies anything else', () => {
    expect(describeToolError(new Error('plain'))).toBe('plain');
    expect(describeToolError('raw')).toBe('raw');
  });
});

describe('toProtocolError', () => {
  it('returns a ProtocolError, including ResourceNotFoundError, unchanged', () => {
    const invalid = new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid issue key format: "x"');
    const notFound = new ResourceNotFoundError('jira://nope/x');
    expect(toProtocolError(invalid)).toBe(invalid);
    expect(toProtocolError(notFound)).toBe(notFound);
  });

  it('maps anything else to InternalError -32603 with the describeToolError text', () => {
    const mapped = toProtocolError(axiosError(500, { message: 'down' }));
    expect(mapped).toBeInstanceOf(ProtocolError);
    expect(mapped.code).toBe(-32603);
    expect(mapped.message).toBe('API error (500): down');
  });
});

describe('log level', () => {
  const SECRET_ARG = 'ARG-EXAMPLE-should-not-be-logged';
  const SECRET_RESULT = 'RESULT-EXAMPLE-should-not-be-logged';

  function serverWithTools(log: { debug(line: string): void }) {
    const server = newServer();
    registerModuleTools(
      server,
      [descriptor('works'), descriptor('fails')],
      {
        works: async () => ({ content: [{ type: 'text', text: SECRET_RESULT }] }),
        fails: async () => Promise.reject(new Error(SECRET_RESULT)),
      },
      log,
    );
    return server;
  }

  it('debug: one line per call with the tool name, ok or error and a duration, and no arguments or results', async () => {
    const debug = vi.fn();
    const client = await trackedConnect(serverWithTools({ debug }));

    await client.callTool({ name: 'works', arguments: { text: SECRET_ARG } });
    await client.callTool({ name: 'fails', arguments: { text: SECRET_ARG } });

    expect(debug).toHaveBeenCalledTimes(2);
    const [okLine, errorLine] = debug.mock.calls.map((c) => String(c[0]));
    expect(okLine).toMatch(/works/);
    expect(okLine).toMatch(/\bok\b/);
    expect(okLine).toMatch(/\d+\s*ms/);
    expect(errorLine).toMatch(/fails/);
    expect(errorLine).toMatch(/\berror\b/);
    expect(errorLine).toMatch(/\d+\s*ms/);
    for (const line of [okLine, errorLine]) {
      expect(line).not.toContain(SECRET_ARG);
      expect(line).not.toContain(SECRET_RESULT);
    }
  });

  it('info: a createLogger("info") logger writes no per-call line', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = await trackedConnect(serverWithTools(createLogger('info')));

    await client.callTool({ name: 'works', arguments: {} });
    await client.callTool({ name: 'fails', arguments: {} });

    const lines = [...stderrWrite.mock.calls, ...consoleError.mock.calls].map((c) => String(c[0]));
    expect(lines.filter((l) => /\b(works|fails)\b/.test(l))).toEqual([]);
  });

  it('silent: a createLogger("silent") logger writes nothing', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = await trackedConnect(serverWithTools(createLogger('silent')));

    await client.callTool({ name: 'works', arguments: {} });
    await client.callTool({ name: 'fails', arguments: {} });

    expect([...stderrWrite.mock.calls, ...consoleError.mock.calls]).toEqual([]);
  });
});
