import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  type McpServer,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { isAxiosError } from 'axios';
import { z } from 'zod';
import type {
  PromptDescriptor,
  PromptHandlerFn,
  ResourceDescriptor,
  ResourceHandlerFn,
  ToolAnnotations,
  ToolDescriptor,
  ToolHandlerFn,
} from './index.js';
import { messageOf } from './helpers.js';

/** The server's log sink: startup and error lines at info and error, one line per tool call at debug. */
export interface Logger {
  info(line: string): void;
  error(line: string): void;
  debug(line: string): void;
}

/**
 * Annotation hint presets: the one home for tool hints, imported by every integration module. A tool that
 * differs by one flag spreads a preset and overrides that flag, e.g. `{ ...READ_ONLY_HINTS, openWorldHint: false }`.
 */
export const READ_ONLY_HINTS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const ADDITIVE_HINTS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
export const IDEMPOTENT_HINTS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const DESTRUCTIVE_HINTS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};
export const DESTRUCTIVE_NON_IDEMPOTENT_HINTS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

/** Text for a failed call: the wording the handlers throw, plus axios status and detail. */
export function describeToolError(err: unknown): string {
  if (err instanceof ProtocolError) return err.message;
  if (err instanceof z.ZodError) return `Validation error: ${err.message}`;
  if (isAxiosError(err)) {
    const status = err.response?.status;
    let detail = err.message;
    const data = err.response?.data;
    if (data && typeof data === 'object') {
      const body = data as { message?: string; errorMessages?: string[]; error?: string };
      detail = body.message || body.errorMessages?.join('; ') || body.error || detail;
    }
    return `API error${status ? ` (${status})` : ''}: ${detail}`;
  }
  return messageOf(err);
}

/** A resource or prompt failure as a protocol error: a ProtocolError passes through, anything else is -32603. */
export function toProtocolError(err: unknown): ProtocolError {
  if (err instanceof ProtocolError) return err;
  return new ProtocolError(ProtocolErrorCode.InternalError, describeToolError(err));
}

/**
 * The input schema as `tools/list` publishes it: zod's JSON Schema without the `$schema` key the SDK
 * would add to every tool, converted once per tool per server instance. Validation still runs through zod's own
 * `~standard.validate`. The SDK always requests one constant conversion target, so the memo ignores `options.target`.
 */
function listedInputSchema(schema: z.ZodObject): StandardSchemaWithJSON {
  const std = schema['~standard'];
  let json: Record<string, unknown> | undefined;
  return {
    '~standard': {
      ...std,
      jsonSchema: {
        ...std.jsonSchema,
        input: (options) => {
          if (!json) {
            json = std.jsonSchema.input(options);
            delete json.$schema;
          }
          return json;
        },
      },
    },
  };
}

/**
 * Registers tools in the order given. A throw becomes an `isError` result; at debug level
 * each call logs one line with the tool name, `ok` or `error`, and its duration.
 */
export function registerModuleTools(
  server: McpServer,
  descriptors: ToolDescriptor[],
  handlers: Record<string, ToolHandlerFn>,
  log: Pick<Logger, 'debug'>,
): void {
  for (const descriptor of descriptors) {
    const handler = handlers[descriptor.name];
    server.registerTool(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: listedInputSchema(descriptor.inputSchema),
        annotations: descriptor.annotations,
      },
      async (args) => {
        const started = performance.now();
        const logCall = (outcome: 'ok' | 'error') =>
          log.debug(`tool ${descriptor.name} ${outcome} ${Math.round(performance.now() - started)}ms`);
        try {
          const result = await handler(args);
          logCall('ok');
          return result;
        } catch (err) {
          logCall('error');
          return { content: [{ type: 'text', text: describeToolError(err) }], isError: true };
        }
      },
    );
  }
}

/** Registers resources and resource templates; the handler gets the encoded href. */
export function registerModuleResources(
  server: McpServer,
  descriptors: ResourceDescriptor[],
  handler: ResourceHandlerFn,
): void {
  const read = async (uri: URL) => {
    try {
      return await handler(uri.href);
    } catch (err) {
      throw toProtocolError(err);
    }
  };
  for (const descriptor of descriptors) {
    const config = {
      title: descriptor.title,
      description: descriptor.description,
      mimeType: descriptor.mimeType,
    };
    if (descriptor.uri !== undefined) {
      server.registerResource(descriptor.name, descriptor.uri, config, read);
    } else {
      const template = new ResourceTemplate(descriptor.uriTemplate, { list: undefined });
      server.registerResource(descriptor.name, template, config, read);
    }
  }
}

/** Registers prompts; the handler gets the prompt name and the arguments the SDK validated. */
export function registerModulePrompts(
  server: McpServer,
  descriptors: PromptDescriptor[],
  handler: PromptHandlerFn,
): void {
  for (const descriptor of descriptors) {
    server.registerPrompt(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        argsSchema: descriptor.argsSchema,
      },
      async (args) => {
        try {
          return await handler(descriptor.name, args);
        } catch (err) {
          throw toProtocolError(err);
        }
      },
    );
  }
}
