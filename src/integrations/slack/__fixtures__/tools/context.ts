import type { FakeClock } from './clock.js';
import type { FakeOAuth } from './fake-oauth.js';
import type { FakeSlack } from './fake-slack.js';

export interface ToolContextParts {
  slack: FakeSlack;
  clock: FakeClock;
  oauth?: FakeOAuth;
  gate?: unknown;
}

/**
 * The single bag every tool factory receives: `{ slack, oauth, gate, now }`.
 * Typed loosely on purpose; the factories' own types do not exist yet.
 */
export function createToolContext(parts: ToolContextParts): any {
  return {
    slack: parts.slack.client,
    oauth: parts.oauth?.oauth,
    gate: parts.gate,
    now: parts.clock.now,
  };
}
