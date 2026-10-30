import { expect } from 'vitest';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

interface TextResult {
  content: Array<{ type: string; text?: string }>;
}

/** Parses a tool result: one text item holding single-line JSON. */
export function parseResult<T = any>(result: unknown): T {
  const content = (result as TextResult).content;
  expect(content).toHaveLength(1);
  expect(content[0].type).toBe('text');
  const text = content[0].text ?? '';
  expect(text).not.toContain('\n');
  return JSON.parse(text) as T;
}

async function rejectionOf(action: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof action === 'function' ? action() : action);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The action must throw an McpError whose message names `slack.<code>:`. */
export async function expectSlackError(
  action: Promise<unknown> | (() => unknown),
  code: string,
): Promise<McpError> {
  const error = await rejectionOf(action);
  expect(error, `expected a thrown slack.${code} error`).toBeInstanceOf(McpError);
  expect((error as McpError).message).toContain(`slack.${code}:`);
  return error as McpError;
}

/** The action must throw an McpError carrying the InvalidParams code. */
export async function expectInvalidParams(
  action: Promise<unknown> | (() => unknown),
): Promise<McpError> {
  const error = await rejectionOf(action);
  expect(error, 'expected a thrown InvalidParams error').toBeInstanceOf(McpError);
  expect((error as McpError).code).toBe(ErrorCode.InvalidParams);
  return error as McpError;
}
