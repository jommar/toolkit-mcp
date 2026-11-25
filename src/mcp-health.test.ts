import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import * as health from './mcp-health.js';
import { createHealthHandler } from './mcp-health.js';
import type { ToolDescriptor } from './integrations/index.js';

const PKG_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

function healthDescriptor(): ToolDescriptor {
  const found = Object.values(health).find(
    (value): value is ToolDescriptor => !!value && typeof value === 'object' && (value as ToolDescriptor).name === 'mcp_get_health',
  );
  if (!found) throw new Error('mcp-health.ts exports no descriptor named mcp_get_health');
  return found;
}

describe('createHealthHandler', () => {
  it('returns health with all integrations active and the package.json version', async () => {
    const handler = createHealthHandler(true, true, true, true, true, true);
    const result = await handler({});

    expect(result.content).toHaveLength(1);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body.serverVersion).toBe(PKG_VERSION);
    expect(body.integrations).toEqual({
      jira: true,
      github: true,
      figma: true,
      confluence: true,
      jenkins: true,
      slack: true,
    });
  });

  it('defaults slack to false when the flag is omitted', async () => {
    const handler = createHealthHandler(true, true, true, true, true);
    const body = JSON.parse(((await handler({})).content[0] as { text: string }).text);
    expect(body.integrations.slack).toBe(false);
  });

  it('defaults jenkins to false when the flag is omitted', async () => {
    const handler = createHealthHandler(true, true, true, true);
    const body = JSON.parse(((await handler({})).content[0] as { text: string }).text);
    expect(body.integrations.jenkins).toBe(false);
  });

  it('returns health with mixed integration states', async () => {
    const handler = createHealthHandler(true, false, true);
    const body = JSON.parse(((await handler({})).content[0] as { text: string }).text);
    expect(body.integrations.jira).toBe(true);
    expect(body.integrations.github).toBe(false);
    expect(body.integrations.figma).toBe(true);
    expect(body.integrations.confluence).toBe(false);
  });
});

describe('health descriptor', () => {
  // Its hint values are pinned by the per-tool table in src/integrations/index.test.ts.
  it('is titled', () => {
    expect(healthDescriptor().title.trim().length).toBeGreaterThan(0);
  });

  it('has a strict empty input schema: {} passes, any parameter is refused', () => {
    const schema = healthDescriptor().inputSchema;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ a: 1 }).success).toBe(false);
  });
});
