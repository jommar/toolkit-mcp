import { rawSearchMatch, type Route } from './fake-slack.js';
import { CHANNEL_ONE, tsFor } from './ids.js';

const CURSOR_MARK_PREFIX = 'CURSOR-MARK-ISSUED-FOR:';

export const FIRST_PAGE_OFFSETS = [40, 30];
export const SECOND_PAGE_OFFSETS = [20, 10];
/** Posted after page one was taken, so it lies above the upper bound page one froze. */
export const LATE_POST_OFFSET = 560;

function matchesAt(offsets: number[]) {
  return offsets.map((offset) => rawSearchMatch({ ts: tsFor(offset), channelId: CHANNEL_ONE }));
}

/**
 * `search.messages` for any query: page one hands out a cursor that names the exact query string it was
 * issued for, and the page that cursor opens carries the late post above the frozen bound.
 */
export function cursorNamesItsQuerySearchRoute(): Route {
  return (params) => {
    if (params.cursor === '*') {
      return {
        messages: { total: 5, matches: matchesAt(FIRST_PAGE_OFFSETS) },
        response_metadata: { next_cursor: `${CURSOR_MARK_PREFIX}${params.query}` },
      };
    }
    return {
      messages: { total: 5, matches: matchesAt([LATE_POST_OFFSET, ...SECOND_PAGE_OFFSETS]) },
      response_metadata: {},
    };
  };
}

export function upstreamCursorFor(query: string): string {
  return `${CURSOR_MARK_PREFIX}${query}`;
}
