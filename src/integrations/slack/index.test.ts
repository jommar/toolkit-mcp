import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SlackModule } from './index.js';
import { TOOL_SCOPES } from '../../services/slack/slack-app.js';
import { TOOL_NAMES } from './__fixtures__/wiring/sentinels.js';

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
    it('creates exactly the ten slack tool handlers', () => {
      const handlers = slackModule.createToolHandlers({ slack: {} as never });
      expect(sorted(Object.keys(handlers))).toEqual(sorted(TOOL_NAMES));
      for (const handler of Object.values(handlers)) expect(typeof handler).toBe('function');
    });

    it('describes exactly the tools it handles', () => {
      const handlers = slackModule.createToolHandlers({ slack: {} as never });
      const descriptorNames = slackModule.getToolDescriptors().map((descriptor) => descriptor.name);
      expect(sorted(descriptorNames)).toEqual(sorted(Object.keys(handlers)));
    });

    it('gives every descriptor a description and a non-empty input schema', () => {
      for (const descriptor of slackModule.getToolDescriptors()) {
        expect(descriptor.description.trim().length, `${descriptor.name} description`).toBeGreaterThan(0);
        const properties = descriptor.inputSchema.properties as Record<string, unknown> | undefined;
        expect(typeof properties, `${descriptor.name} properties`).toBe('object');
        expect(Object.keys(properties ?? {}).length, `${descriptor.name} property count`).toBeGreaterThan(0);
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
