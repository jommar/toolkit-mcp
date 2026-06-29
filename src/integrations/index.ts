import { Server } from '@modelcontextprotocol/sdk/server';

/**
 * A tool handler: receives validated args, returns MCP CallToolResult content.
 */
export type ToolHandlerFn = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
}>;

/**
 * Descriptor for a single tool (returned by ListToolsRequestSchema).
 */
export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Interface for integration modules.
 * Each module wraps an external tool (Jira, GitHub, etc.)
 * and conditionally registers tools/resources/prompts only when
 * its required environment variables are present.
 *
 * Modules do NOT call server.setRequestHandler directly — they return
 * handler maps that the central MCP server dispatches from a single handler.
 */
export interface IntegrationModule<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique module identifier (e.g., "jira", "github") */
  readonly id: string;

  /** Returns true if the required env vars are all set. */
  needsEnv(): boolean;

  /**
   * Create and return tool handlers keyed by tool name.
   * Called once during bootstrap when needsEnv() returns true.
   */
  createToolHandlers(clients: C): Record<string, ToolHandlerFn>;

  /** Return descriptors for all tools this module provides. */
  getToolDescriptors(): ToolDescriptor[];

  /**
   * Optional: return a resource handler that accepts a URI and returns
   * ReadResourceResult-compatible content.
   */
  getResourceHandler?(clients: C): (
    uri: string,
  ) => Promise<{
    contents: { uri: string; mimeType: string; text: string }[];
  }>;

  /**
   * Optional: return a prompt handler that accepts prompt name and args
   * and returns GetPromptResult-compatible content.
   */
  getPromptHandler?(clients: C): (
    name: string,
    args: Record<string, unknown> | undefined,
  ) => Promise<{
    messages: { role: string; content: { type: string; text: string } }[];
  }>;
}

import { JiraModule } from './jira/index.js';
import { GitHubModule } from './github/index.js';
import { FigmaModule } from './figma/index.js';

/**
 * Module registry — explicitly import and export all module implementations.
 * Adding a new module requires creating its directory AND adding its import here.
 */
export const modules: IntegrationModule<any>[] = [new JiraModule(), new GitHubModule(), new FigmaModule()];
