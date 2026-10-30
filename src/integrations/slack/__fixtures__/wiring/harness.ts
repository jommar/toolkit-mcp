import { request as httpRequest } from 'node:http';
import { inspect } from 'node:util';
import { vi } from 'vitest';
import type { RecordedRequest } from './fake-slack-api.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }>;
export type ToolHandlers = Record<string, ToolHandler>;

export interface ThrownDetail {
  message: string;
  code: number | undefined;
  detail: string;
}

export interface ToolOutcome {
  name: string;
  text: string;
  thrown: ThrownDetail | undefined;
}

const INSPECT_DEPTH = 8;

function describeThrown(error: unknown): ThrownDetail {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return {
    message,
    code: typeof code === 'number' ? code : undefined,
    detail: inspect(error, { depth: INSPECT_DEPTH }),
  };
}

export async function callTool(
  handlers: ToolHandlers,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutcome> {
  const handler = handlers[name];
  if (!handler) throw new Error(`no handler named ${name}`);
  try {
    const result = await handler(args);
    const text = result.content.map((item) => item.text ?? '').join('\n');
    return { name, text, thrown: undefined };
  } catch (error) {
    return { name, text: '', thrown: describeThrown(error) };
  }
}

export function resultJson(outcome: ToolOutcome): any {
  if (outcome.thrown) throw new Error(`${outcome.name} threw: ${outcome.thrown.message}`);
  return JSON.parse(outcome.text);
}

export function observedText(outcome: ToolOutcome): string {
  return outcome.thrown ? `${outcome.thrown.message}\n${outcome.thrown.detail}` : outcome.text;
}

export function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) collectKeys(element, into);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

export interface ConsoleCapture {
  lines: () => string[];
  restore: () => void;
}

export function captureConsole(): ConsoleCapture {
  const captured: string[] = [];
  const record = (...parts: unknown[]) => {
    captured.push(parts.map((part) => (typeof part === 'string' ? part : inspect(part, { depth: INSPECT_DEPTH }))).join(' '));
  };
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(record),
  );
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    record(String(chunk));
    return true;
  }) as never);
  return {
    lines: () => [...captured],
    restore: () => {
      for (const spy of spies) spy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

export function renderRequest(request: RecordedRequest): string {
  const headerLines = Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`);
  return [`${request.httpMethod} ${request.url}`, ...headerLines, request.body].join('\n');
}

export interface LoopbackResponse {
  status: number;
  body: string;
  contentType: string;
}

export function loopbackRequest(port: number, pathWithQuery: string, method = 'GET'): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    // No shared agent: a pooled keep-alive socket would reach the previous login's closing listener on a reused port.
    const options = { host: '127.0.0.1', port, path: pathWithQuery, method, timeout: 5000, agent: false };
    const req = httpRequest(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          contentType: String(res.headers['content-type'] ?? ''),
        }),
      );
    });
    req.on('timeout', () => req.destroy(new Error('loopback request timed out')));
    req.on('error', reject);
    req.end();
  });
}

export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest = await read();
  while (!accept(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await read();
  }
  return latest;
}
