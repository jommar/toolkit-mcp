import { vi, describe, it, expect } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { createHealthHandler } from './mcp-health.js';

describe('createHealthHandler', () => {
  it('returns health with both integrations active', async () => {
    const handler = createHealthHandler(true, true);
    const result = await handler({});

    expect(result.content).toHaveLength(1);
    const body = JSON.parse(result.content[0].text);
    expect(body.serverVersion).toBe('0.1.0');
    expect(body.integrations.jira).toBe(true);
    expect(body.integrations.github).toBe(true);
  });

  it('returns health with no integrations active', async () => {
    const handler = createHealthHandler(false, false);
    const result = await handler({});

    const body = JSON.parse(result.content[0].text);
    expect(body.integrations.jira).toBe(false);
    expect(body.integrations.github).toBe(false);
  });

  it('returns health with mixed integration states', async () => {
    const handler = createHealthHandler(true, false);
    const result = await handler({});

    const body = JSON.parse(result.content[0].text);
    expect(body.integrations.jira).toBe(true);
    expect(body.integrations.github).toBe(false);
  });

  it('accepts null args', async () => {
    const handler = createHealthHandler(false, false);
    const result = await handler(null);
    const body = JSON.parse(result.content[0].text);
    expect(body.serverVersion).toBe('0.1.0');
  });

  it('accepts undefined args', async () => {
    const handler = createHealthHandler(false, false);
    const result = await handler(undefined);
    const body = JSON.parse(result.content[0].text);
    expect(body.serverVersion).toBe('0.1.0');
  });

  it('rejects unexpected parameters', async () => {
    const handler = createHealthHandler(false, false);

    await expect(handler({ extra: 'param' })).rejects.toThrow(McpError);
    await expect(handler({ extra: 'param' })).rejects.toThrow(
      'mcp_get_health does not accept parameters',
    );
  });
});
