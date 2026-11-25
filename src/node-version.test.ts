/**
 * Node version guard (D22 b): the server refuses to start on a Node major below the package.json
 * `engines.node` minimum. The check is a pure function so it can be tested without an old Node.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { assertSupportedNode, MINIMUM_NODE_MAJOR } from './mcp-server.js';

const ENGINES_NODE = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { engines: { node: string } }
).engines.node;

describe('assertSupportedNode', () => {
  it('throws for a major below the minimum, naming the running version and the minimum', () => {
    expect(() => assertSupportedNode('v23.9.0', 24)).toThrow(/v23\.9\.0/);
    expect(() => assertSupportedNode('v23.9.0', 24)).toThrow(/24/);
  });

  it.each(['v24.0.0', 'v26.13.1'])('accepts %s with minimum 24', (version) => {
    expect(() => assertSupportedNode(version, 24)).not.toThrow();
  });
});

describe('MINIMUM_NODE_MAJOR', () => {
  it('is 24, taken from package.json engines.node', () => {
    expect(ENGINES_NODE).toBe('>=24');
    expect(MINIMUM_NODE_MAJOR).toBe(24);
  });

  it('accepts the Node running this suite', () => {
    expect(() => assertSupportedNode(process.version, MINIMUM_NODE_MAJOR)).not.toThrow();
  });
});
