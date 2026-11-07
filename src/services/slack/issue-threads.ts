import type { SlackClient } from './slack-client.js';
import { buildPermalink, slackTsToIso, type RawMessage } from './slack-model.js';

export const MAX_THREADS_PER_ISSUE = 5;
// Several matches usually share a thread, so the search asks for more messages than threads kept.
const SEARCH_MATCH_COUNT = 20;
const DIRECT_MESSAGE_ID_PREFIX = 'D';
// Keeps direct messages out of the search itself, so they cannot use up the matches asked for.
const EXCLUDE_DIRECT_MESSAGES = '-is:dm';
// A search match names its thread root only here, as a query parameter of its own permalink.
const PERMALINK_THREAD_TS_PATTERN = /[?&]thread_ts=(\d+\.\d+)/;

export interface IssueThread {
  permalink: string;
  channel?: string;
  channelId: string;
  threadTs: string;
  /** The newest matching message in the thread, as an ISO 8601 UTC instant. */
  at: string;
}

interface SearchChannel {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
}

interface SearchMatch extends RawMessage {
  permalink?: string;
  channel?: SearchChannel;
}

interface ChannelMatch extends SearchMatch {
  channel: SearchChannel;
}

interface SearchBody {
  messages?: { matches?: SearchMatch[] };
}

/**
 * Channel threads that mention an issue key, as links only (no message text), newest match first.
 * Direct and group messages and bot messages are left out; several matches in one thread become one entry.
 */
export async function findThreadsForIssueKey(
  slack: Pick<SlackClient, 'searchMessages'>,
  teamUrl: string,
  issueKey: string,
): Promise<IssueThread[]> {
  const body = (await slack.searchMessages({
    query: `"${issueKey}" ${EXCLUDE_DIRECT_MESSAGES}`,
    count: SEARCH_MATCH_COUNT,
    sort: 'timestamp',
    sort_dir: 'desc',
  })) as SearchBody;
  const matches = (body.messages?.matches ?? []).filter(isChannelMatch);
  return collapseIntoThreads(matches, teamUrl).slice(0, MAX_THREADS_PER_ISSUE);
}

function isChannelMatch(match: SearchMatch): match is ChannelMatch {
  if (!match.channel || match.bot_id) return false;
  return !isDirectConversation(match.channel);
}

function isDirectConversation(channel: SearchChannel): boolean {
  return Boolean(channel.is_im || channel.is_mpim) || channel.id.startsWith(DIRECT_MESSAGE_ID_PREFIX);
}

// Search answers newest first, so the first match of a thread is its newest and a Map keeps threads in that order.
function collapseIntoThreads(matches: ChannelMatch[], teamUrl: string): IssueThread[] {
  const threads = new Map<string, IssueThread>();
  for (const match of matches) {
    const threadTs = threadTsOf(match);
    const key = `${match.channel.id}:${threadTs}`;
    if (threads.has(key)) continue;
    threads.set(key, {
      permalink: buildPermalink({ teamUrl, channelId: match.channel.id, ts: threadTs }),
      channel: match.channel.name,
      channelId: match.channel.id,
      threadTs,
      at: slackTsToIso(match.ts),
    });
  }
  return [...threads.values()];
}

function threadTsOf(match: SearchMatch): string {
  return PERMALINK_THREAD_TS_PATTERN.exec(match.permalink ?? '')?.[1] ?? match.ts;
}
