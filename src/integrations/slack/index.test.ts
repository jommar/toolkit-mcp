import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlackModule } from './index.js';
import { TOOL_SCOPES } from '../../services/slack/slack-app.js';
import { TOOL_NAMES } from './__fixtures__/wiring/sentinels.js';
import { inputJsonSchema } from '../../__fixtures__/mcp.js';

const SESSION_TOOLS = ['slack_login', 'slack_logout', 'slack_get_status'];
const SCOPED_TOOLS = TOOL_NAMES.filter((name) => !SESSION_TOOLS.includes(name));

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('SlackModule', () => {
  let slackModule: SlackModule;

  beforeEach(() => {
    vi.unstubAllEnvs();
    delete process.env.SLACK_ENABLED;
    slackModule = new SlackModule();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('has the id "slack"', () => {
    expect(slackModule.id).toBe('slack');
  });

  describe('needsEnv', () => {
    it('is false when SLACK_ENABLED is unset', () => {
      expect(slackModule.needsEnv()).toBe(false);
    });

    it('is false when SLACK_ENABLED is "false"', () => {
      vi.stubEnv('SLACK_ENABLED', 'false');
      expect(slackModule.needsEnv()).toBe(false);
    });

    it('is true when SLACK_ENABLED is "true"', () => {
      vi.stubEnv('SLACK_ENABLED', 'true');
      expect(slackModule.needsEnv()).toBe(true);
    });
  });

  describe('tool surface', () => {
    it('creates exactly the eleven slack tool handlers', () => {
      const handlers = slackModule.createToolHandlers({ slack: {} as never });
      expect(sorted(Object.keys(handlers))).toEqual(sorted(TOOL_NAMES));
      for (const handler of Object.values(handlers)) expect(typeof handler).toBe('function');
    });

    it('describes exactly the tools it handles', () => {
      const handlers = slackModule.createToolHandlers({ slack: {} as never });
      const descriptorNames = slackModule.getToolDescriptors().map((descriptor) => descriptor.name);
      expect(sorted(descriptorNames)).toEqual(sorted(Object.keys(handlers)));
    });

    it('gives slack_download_file a description of 135 to 359 characters', () => {
      const descriptor = slackModule.getToolDescriptors().find((candidate) => candidate.name === 'slack_download_file');

      expect(descriptor, 'slack_download_file descriptor').toBeDefined();
      expect(descriptor?.description.length).toBeGreaterThanOrEqual(135);
      expect(descriptor?.description.length).toBeLessThanOrEqual(359);
    });

    it.each([
      ['slack_search_messages', 'queries', '1 to 5'],
      ['slack_get_messages', 'messages', '1 to 20'],
      ['slack_get_threads', 'threads', '1 to 20'],
    ])('advertises default attachment metadata without new inputs for %s', (tool, batchKey, cap) => {
      const descriptor = slackModule.getToolDescriptors().find((candidate) => candidate.name === tool)!;

      expect(descriptor, tool).toBeDefined();
      expect(descriptor.description.length).toBeGreaterThanOrEqual(135);
      expect(descriptor.description.length).toBeLessThanOrEqual(359);
      expect(descriptor.description.match(/[.!?](?:\s|$)/g)).toHaveLength(1);
      expect(descriptor.description).toContain(cap);
      expect(descriptor.description).toContain('nextPageToken');
      expect(descriptor.description).toContain('cursor');
      expect(descriptor.description).toMatch(/text/i);
      expect(descriptor.description).toMatch(/fields/i);
      expect(descriptor.description).toMatch(/only|opt[- ]in/i);
      expect(descriptor.description).toMatch(/default/i);
      expect(descriptor.description).toContain('hasAttachments');
      expect(descriptor.description).toContain('attachments');
      expect(descriptor.description).toContain('file_id');
      expect(descriptor.description).toContain('slack_download_file');
      const schema = inputJsonSchema(descriptor) as any;
      const properties = schema.properties as Record<
        string,
        { type: string; items?: unknown; description: string }
      >;
      expect(sorted(Object.keys(properties))).toEqual(sorted([batchKey, 'fields', 'limit', 'max_text_chars']));
      expect(schema.required).toEqual([batchKey]);
      expect(properties.fields.type).toBe('array');
      expect(properties.fields.items).toEqual({ type: 'string' });
      expect(properties.fields.description).toContain('text, mrkdwn, author_name, reactions, channel_name');
      expect(properties.fields.description).toMatch(/default/i);
      expect(properties.fields.description).toContain('hasAttachments');
      expect(properties.fields.description).toContain('attachments');
    });

    it('gives every descriptor a description and a non-empty input schema', () => {
      for (const descriptor of slackModule.getToolDescriptors()) {
        expect(descriptor.description.trim().length, `${descriptor.name} description`).toBeGreaterThan(0);
        const properties = (inputJsonSchema(descriptor) as any).properties as Record<string, unknown> | undefined;
        expect(typeof properties, `${descriptor.name} properties`).toBe('object');
        expect(Object.keys(properties ?? {}).length, `${descriptor.name} property count`).toBeGreaterThan(0);
      }
    });
  });

  describe('published input schemas', () => {
    type JsonSchema = Record<string, any>;

    function published(tool: string): JsonSchema {
      const descriptor = slackModule.getToolDescriptors().find((candidate) => candidate.name === tool);
      expect(descriptor, tool).toBeDefined();
      return inputJsonSchema(descriptor!) as JsonSchema;
    }

    function expectDescribedProperties(schema: JsonSchema, label: string): void {
      for (const [key, property] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
        expect(typeof property.description, `${label}.${key} description`).toBe('string');
        expect(property.description.trim().length, `${label}.${key} description`).toBeGreaterThan(0);
      }
    }

    const LINK_OR_REF = {
      anyOf: [
        expect.objectContaining({ type: 'string' }),
        expect.objectContaining({
          type: 'object',
          properties: expect.objectContaining({ channel: expect.anything(), ts: expect.anything() }),
          required: ['channel', 'ts'],
        }),
      ],
    };

    it.each([
      ['slack_search_messages', 'queries', 5],
      ['slack_get_messages', 'messages', 20],
      ['slack_get_threads', 'threads', 20],
      ['slack_get_channels', 'channels', 20],
      ['slack_get_users', 'users', 100],
      ['slack_prepare_write', 'items', 10],
    ])('publishes the %s batch cap: %s holds 1 to %i items', (tool, batchKey, cap) => {
      expect(published(tool).properties[batchKey]).toMatchObject({ type: 'array', minItems: 1, maxItems: cap });
    });

    it.each([
      ['slack_search_messages', 'queries', ['ref', 'cursor', 'query', 'exact_phrases', 'in_channels', 'from_users', 'after', 'before', 'top_level_only', 'include_bots']],
      ['slack_get_messages', 'messages', ['ref', 'cursor', 'message', 'channel', 'after', 'before', 'top_level_only']],
      ['slack_get_threads', 'threads', ['ref', 'cursor', 'thread']],
      ['slack_get_channels', 'channels', ['ref', 'cursor', 'channel', 'name', 'member_only', 'types', 'include_archived']],
      ['slack_get_users', 'users', ['ref', 'cursor', 'user', 'me', 'query', 'members_of']],
    ])('shows the batch items of %s with their own described properties', (tool, batchKey, itemKeys) => {
      const batch = published(tool).properties[batchKey];

      expect(batch.type).toBe('array');
      expect(batch.minItems).toBe(1);
      expect(batch.items.type).toBe('object');
      expect(sorted(Object.keys(batch.items.properties))).toEqual(sorted(itemKeys));
      expectDescribedProperties(batch.items, `${tool}.${batchKey}[]`);
    });

    it.each([
      ['slack_get_messages', 'messages', 'message'],
      ['slack_get_threads', 'threads', 'thread'],
    ])('shows %s %s items taking a link or {channel, ts}', (tool, batchKey, field) => {
      expect(published(tool).properties[batchKey].items.properties[field]).toMatchObject(LINK_OR_REF);
    });

    it('shows slack_prepare_write items as three variants keyed by action', () => {
      const items = published('slack_prepare_write').properties.items;
      expect(items.type).toBe('array');
      expect(items.minItems).toBe(1);
      const variants = (items.items.oneOf ?? items.items.anyOf) as JsonSchema[];
      expect(Array.isArray(variants), 'items.items lists its variants').toBe(true);

      const byAction = Object.fromEntries(variants.map((variant) => [variant.properties.action.const, variant]));
      expect(sorted(Object.keys(byAction))).toEqual(['post', 'react', 'upload']);
      expect(byAction.post.required).toEqual(expect.arrayContaining(['action', 'destination', 'text']));
      expect(byAction.react.required).toEqual(expect.arrayContaining(['action', 'message', 'emoji']));
      expect(byAction.upload.required).toEqual(expect.arrayContaining(['action', 'destination', 'path']));
      expect(byAction.react.properties.message).toMatchObject(LINK_OR_REF);
    });

    it('describes every property of every slack_prepare_write variant', () => {
      const items = published('slack_prepare_write').properties.items;
      for (const variant of (items.items.oneOf ?? items.items.anyOf) as JsonSchema[]) {
        expectDescribedProperties(variant, `slack_prepare_write ${variant.properties?.action?.const}`);
      }
    });
  });

  describe('tool titles and hints', () => {
    // Hint values are owned by the 80-tool table in src/integrations/index.test.ts.
    it('gives every tool a title and all four hints', () => {
      for (const descriptor of slackModule.getToolDescriptors()) {
        expect(typeof descriptor.title, `${descriptor.name} title`).toBe('string');
        expect(descriptor.title.trim().length, `${descriptor.name} title`).toBeGreaterThan(0);
        for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
          expect(typeof descriptor.annotations?.[hint], `${descriptor.name} ${hint}`).toBe('boolean');
        }
      }
    });
  });

  describe('scope table', () => {
    it('has an entry for every tool', () => {
      for (const name of TOOL_NAMES) {
        expect(Object.keys(TOOL_SCOPES), `entry for ${name}`).toContain(name);
        expect(Array.isArray((TOOL_SCOPES as Record<string, unknown>)[name]), `array for ${name}`).toBe(true);
      }
    });

    it('asks no scope for the session tools', () => {
      for (const name of SESSION_TOOLS) {
        expect((TOOL_SCOPES as Record<string, readonly string[]>)[name], name).toEqual([]);
      }
    });

    it('asks at least one scope for every other tool', () => {
      for (const name of SCOPED_TOOLS) {
        expect((TOOL_SCOPES as Record<string, readonly string[]>)[name]?.length, name).toBeGreaterThan(0);
      }
    });
  });
});
