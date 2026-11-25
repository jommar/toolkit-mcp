import type { CallToolResult, GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/server';
import type { z } from 'zod';

/**
 * A tool handler: receives the schema's parsed input (the SDK validates it and applies
 * defaults before the call) and returns an SDK CallToolResult. A throw becomes an
 * `isError` result in register.ts.
 */
export type ToolHandlerFn = (args: any) => Promise<CallToolResult>;

/** The four hints every tool declares. All four are required. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Descriptor for a single tool; register.ts registers it with the server.
 */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
}

/**
 * Descriptor for a resource: a static `uri`, or a `uriTemplate` (RFC 6570), never both.
 */
export type ResourceDescriptor = {
  name: string;
  title: string;
  description: string;
  mimeType: string;
} & ({ uri: string; uriTemplate?: undefined } | { uriTemplate: string; uri?: undefined });

/** Descriptor for a prompt. */
export interface PromptDescriptor {
  name: string;
  title: string;
  description: string;
  argsSchema: z.ZodObject;
}

/** Reads a resource by its URI (the SDK passes the percent-encoded href). */
export type ResourceHandlerFn = (uri: string) => Promise<ReadResourceResult>;

/** Returns a prompt's messages for a prompt name and its string arguments. */
export type PromptHandlerFn = (
  name: string,
  args: Record<string, unknown> | undefined,
) => Promise<GetPromptResult>;

/**
 * Interface for integration modules.
 * Each module wraps an external tool (Jira, GitHub, etc.)
 * and conditionally registers tools/resources/prompts only when
 * its required environment variables are present.
 *
 * Modules do NOT touch the MCP server directly — register.ts registers
 * the descriptors and handlers they return.
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

  /** Optional: return a handler for this module's resource URIs and templates. */
  getResourceHandler?(clients: C): ResourceHandlerFn;

  /** Optional: return descriptors for the resources and templates this module serves. */
  getResourceDescriptors?(): ResourceDescriptor[];

  /** Optional: return a prompt handler that accepts prompt name and args. */
  getPromptHandler?(clients: C): PromptHandlerFn;

  /** Optional: return descriptors for the prompts this module serves. */
  getPromptDescriptors?(): PromptDescriptor[];
}

import { JiraModule } from './jira/index.js';
import { GitHubModule } from './github/index.js';
import { FigmaModule } from './figma/index.js';
import { ConfluenceModule } from './confluence/index.js';
import { JenkinsModule } from './jenkins/index.js';
import { SlackModule } from './slack/index.js';

/**
 * Module registry — explicitly import and export all module implementations.
 * Adding a new module requires creating its directory AND adding its import here.
 */
export const modules: IntegrationModule<any>[] = [
  new JiraModule(),
  new GitHubModule(),
  new FigmaModule(),
  new ConfluenceModule(),
  new JenkinsModule(),
  new SlackModule(),
];
