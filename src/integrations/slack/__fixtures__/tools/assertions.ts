import { expect } from 'vitest';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

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

/** The action must throw a ProtocolError whose message names `slack.<code>:`. */
export async function expectSlackError(
  action: Promise<unknown> | (() => unknown),
  code: string,
): Promise<ProtocolError> {
  const error = await rejectionOf(action);
  expect(error, `expected a thrown slack.${code} error`).toBeInstanceOf(ProtocolError);
  expect((error as ProtocolError).message).toContain(`slack.${code}:`);
  return error as ProtocolError;
}

/** The action must throw a ProtocolError carrying the InvalidParams code. */
export async function expectInvalidParams(
  action: Promise<unknown> | (() => unknown),
): Promise<ProtocolError> {
  const error = await rejectionOf(action);
  expect(error, 'expected a thrown InvalidParams error').toBeInstanceOf(ProtocolError);
  expect((error as ProtocolError).code).toBe(ProtocolErrorCode.InvalidParams);
  return error as ProtocolError;
}
