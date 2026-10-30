import {
  conversationsInfoRoute,
  constantRoute,
  publicChannel,
  rawSearchMatch,
  type RawChannel,
  type Route,
} from './fake-slack.js';
import { tsFor } from './ids.js';

/** Channels that share one name, so a single name lookup pays for one info call per match. */
export const MATCHES_PER_NAME = 8;

/** One conversations.list, one search.messages and one conversations.info per match. */
export const UPSTREAM_CALLS_PER_NAME = 2 + MATCHES_PER_NAME;

export function budgetRoomName(index: number): string {
  return `budget-room-${String(index).padStart(2, '0')}`;
}

function budgetRoomId(index: number, match: number): string {
  return `C0EXAMPLE${String(index).padStart(2, '0')}${match}`;
}

export function budgetRoomIds(index: number): string[] {
  return Array.from({ length: MATCHES_PER_NAME }, (_, match) => budgetRoomId(index, match));
}

/**
 * Routes for `roomCount` channel names that conversations.list does not hold, so each name
 * falls back to a message search that finds `MATCHES_PER_NAME` channels carrying it.
 */
export function nameFallbackRoutes(roomCount: number): Record<string, Route> {
  const channels: Record<string, RawChannel> = {};
  const idsByName = new Map<string, string[]>();
  for (let index = 0; index < roomCount; index += 1) {
    const ids = budgetRoomIds(index);
    idsByName.set(budgetRoomName(index), ids);
    for (const id of ids) channels[id] = publicChannel(id, budgetRoomName(index));
  }
  return {
    'conversations.list': constantRoute({ channels: [] }),
    'search.messages': (params) => {
      const name = String(params.query).replace(/^in:/, '');
      const matches = (idsByName.get(name) ?? []).map((channelId, match) =>
        rawSearchMatch({ ts: tsFor(match), channelId, channelName: name }),
      );
      return { messages: { total: matches.length, matches } };
    },
    'conversations.info': conversationsInfoRoute(channels),
  };
}
