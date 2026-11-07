import { CHANNEL_ID, USER_ID } from './synthetic.js';

export const OTHER_CHANNEL_ID = 'C0EXAMPLE02';
export const CHANNEL_NAME = 'example-room';
export const MESSAGE_TEXT_MARKER = 'FIXTURE-MESSAGE-TEXT';

const BASE_EPOCH_SECONDS = 1_700_000_000;

/** A synthetic Slack ts, `seconds` after the fixture epoch. */
export function tsAt(seconds: number): string {
  return `${BASE_EPOCH_SECONDS + seconds}.000100`;
}

export interface SearchMatchOptions {
  ts: string;
  channelId?: string;
  channelName?: string;
  /** The thread root. Slack names it only in the match's permalink, never in a `thread_ts` field. */
  threadTs?: string;
  bot?: boolean;
  isIm?: boolean;
  isMpim?: boolean;
}

/** One `search.messages` match as Slack returns it: the message, its permalink and the channel it was found in. */
export function searchMatch(options: SearchMatchOptions): Record<string, unknown> {
  const channel: Record<string, unknown> = {
    id: options.channelId ?? CHANNEL_ID,
    name: options.channelName ?? CHANNEL_NAME,
  };
  if (options.isIm !== undefined) channel.is_im = options.isIm;
  if (options.isMpim !== undefined) channel.is_mpim = options.isMpim;

  const match: Record<string, unknown> = {
    type: 'message',
    ts: options.ts,
    user: USER_ID,
    text: `${MESSAGE_TEXT_MARKER}-${options.ts}`,
    permalink: matchPermalink(channel.id as string, options),
    channel,
  };
  if (options.bot) match.bot_id = 'B0EXAMPLE01';
  return match;
}

// A reply's permalink carries the thread root as a query parameter, which is the only place a search match names it.
function matchPermalink(channelId: string, { ts, threadTs }: SearchMatchOptions): string {
  const message = `https://example-team.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;
  return threadTs ? `${message}?thread_ts=${threadTs}&cid=${channelId}` : message;
}

export function searchResponse(matches: Array<Record<string, unknown>>): Record<string, unknown> {
  return { ok: true, query: 'EXAMPLE', messages: { total: matches.length, matches } };
}
