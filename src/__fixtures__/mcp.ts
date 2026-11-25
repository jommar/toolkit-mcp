/**
 * Shared MCP test fixture (tests only; nothing in production imports it).
 *
 * - `connectInMemory` drives a real `McpServer` through the official v2 client,
 *   so `tools/list`, `tools/call`, `resources/*` and `prompts/*` run through the SDK.
 * - `rawToolHandlers` keeps the handler suites' call shape: raw arguments in, the
 *   descriptor's zod schema parses them (a `ZodError` rejects), then the module's handler runs.
 * - `inputJsonSchema` converts a descriptor's schema the way the SDK does for `tools/list`;
 *   `src/mcp-server.test.ts` checks it against the real `tools/list` for every tool, so it cannot drift.
 * - `trackedConnect` / `closeTrackedClients` connect and close clients around each test.
 * - `axiosError` builds an upstream HTTP failure with a status and response body.
 * - `contentText` / `promptText` read one text part of a tool or prompt result, failing on any other part type.
 */
import { AxiosError } from 'axios';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import type { IntegrationModule, ToolDescriptor, ToolHandlerFn } from '../integrations/index.js';

/** The JSON Schema dialect the SDK asks Standard Schema for when it lists tool input schemas. */
const SDK_JSON_SCHEMA_TARGET = 'draft-2020-12';

/** A module handler behind its descriptor's schema: takes raw arguments, as today's suites call it. */
export type RawToolHandler = (args?: Record<string, unknown>) => ReturnType<ToolHandlerFn>;

/** Connect `server` to a new client over a linked in-memory pair. `client.close()` closes both ends. */
export async function connectInMemory(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'toolkit-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const trackedClients: Client[] = [];

/** `connectInMemory`, remembering the client so `closeTrackedClients` (call it in `afterEach`) closes it. */
export async function trackedConnect(server: McpServer): Promise<Client> {
  const client = await connectInMemory(server);
  trackedClients.push(client);
  return client;
}

/** Closes every client `trackedConnect` opened since the last call. */
export async function closeTrackedClients(): Promise<void> {
  for (const client of trackedClients.splice(0)) await client.close();
}

/** The module's tool handlers, each parsing its raw arguments with the matching descriptor's schema first. */
export function rawToolHandlers<M extends IntegrationModule<any>>(
  mod: M,
  // Typed from `createToolHandlers` so optional clients count (inferring the module's generic picks a narrower method's clients).
  clients: Parameters<M['createToolHandlers']>[0],
): Record<string, RawToolHandler> {
  const schemas = new Map(mod.getToolDescriptors().map((d) => [d.name, d.inputSchema]));
  const handlers = mod.createToolHandlers(clients);
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]): [string, RawToolHandler] => {
      const schema = schemas.get(name);
      if (!schema) throw new Error(`rawToolHandlers: ${mod.id} has a handler without a descriptor: ${name}`);
      return [name, async (args = {}) => handler(await schema.parseAsync(args))];
    }),
  );
}

/**
 * The input JSON Schema `tools/list` publishes for this descriptor: the SDK's Standard Schema
 * conversion with its `type: "object"` root, and no `$schema` key.
 */
export function inputJsonSchema(descriptor: ToolDescriptor): Record<string, any> {
  const converted = descriptor.inputSchema['~standard'].jsonSchema.input({ target: SDK_JSON_SCHEMA_TARGET });
  const schema: Record<string, any> = { type: 'object', ...converted };
  delete schema.$schema;
  return schema;
}

/** An axios error for an upstream HTTP `status` whose response body is `data`. */
export function axiosError(status: number, data: unknown): AxiosError {
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: '',
    data,
    headers: {},
    config: { headers: {} },
  } as any);
}

/** The text of a tool result's `index`th content part; throws when that part is missing or not text. */
export function contentText(result: { content: readonly { type: string }[] }, index = 0): string {
  const part = result.content[index];
  if (part?.type !== 'text' || !('text' in part) || typeof part.text !== 'string') {
    throw new Error(`content[${index}] is ${part?.type ?? 'missing'}, not text`);
  }
  return part.text;
}

/** The text of a prompt result's `index`th message; throws when its content is not text. */
export function promptText(result: { messages: readonly { content: { type: string } }[] }, index = 0): string {
  const content = result.messages[index]?.content;
  if (content?.type !== 'text' || !('text' in content) || typeof content.text !== 'string') {
    throw new Error(`messages[${index}] content is ${content?.type ?? 'missing'}, not text`);
  }
  return content.text;
}
