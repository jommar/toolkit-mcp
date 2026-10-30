import { slackFailure, type RawMessage, type Route, type RouteParams } from './fake-slack.js';

const DEFAULT_LIMIT = 100;

function inWindow(message: RawMessage, params: RouteParams): boolean {
  return (
    (params.oldest === undefined || message.ts >= params.oldest) &&
    (params.latest === undefined || message.ts <= params.latest)
  );
}

function failWith(slackCode: string): never {
  throw slackFailure('slack_error', { slack_code: slackCode });
}

/**
 * `conversations.history` as Slack answers it: one entry per thread (the root, or an unthreaded message),
 * never a reply, newest first, inside the oldest/latest window, at most `limit` entries.
 * Each thread is `[root, ...replies]`; an unthreaded message is a thread of one.
 */
export function topLevelHistoryRoute(channelId: string, threads: RawMessage[][]): Route {
  return (params) => {
    if (params.channel !== channelId) failWith('channel_not_found');
    const roots = threads.map(([root]) => root).filter((root) => inWindow(root, params));
    roots.sort((left, right) => (left.ts < right.ts ? 1 : -1));
    return { messages: roots.slice(0, Number(params.limit ?? DEFAULT_LIMIT)) };
  };
}

/**
 * `conversations.replies` as Slack answers it: `ts` may name the root or any reply of a thread, the
 * root always comes first, the oldest/latest window applies to the replies after it, and `limit`
 * counts the root.
 */
export function rootFirstRepliesRoute(channelId: string, threads: RawMessage[][]): Route {
  return (params) => {
    if (params.channel !== channelId) failWith('channel_not_found');
    const thread = threads.find((messages) => messages.some((message) => message.ts === params.ts));
    if (!thread) failWith('thread_not_found');
    const [root, ...replies] = thread;
    const inside = replies.filter((reply) => inWindow(reply, params));
    return { messages: [root, ...inside].slice(0, Number(params.limit ?? DEFAULT_LIMIT)) };
  };
}
