import { vi, type Mock } from 'vitest';
import { Readable } from 'node:stream';
import type {
  AuthTestResponse,
  SlackArguments,
  SlackClient,
  SlackResponse,
} from '../../../../services/slack/slack-client.js';
import {
  BOT_ONE,
  FILE_ONE,
  MESSAGE_TEXT_MARKER,
  USER_ME,
  tsFor,
} from './ids.js';

// ---------------------------------------------------------------------------
// Failures the client port rejects with
// ---------------------------------------------------------------------------

export interface SlackFailureFields {
  slack_code?: string;
  retry_after_s?: number;
  http_status?: number;
  message?: string;
}

export type SlackFailure = Error & { code: string } & Omit<SlackFailureFields, 'message'>;

/**
 * An error shaped like the ones the client port rejects with: `code` is the
 * module's own error code, `slack_code` is Slack's own error string.
 */
export function slackFailure(code: string, fields: SlackFailureFields = {}): SlackFailure {
  const { message, ...rest } = fields;
  const failure = new Error(message ?? `fixture failure ${code}`) as SlackFailure;
  failure.code = code;
  Object.assign(failure, rest);
  return failure;
}

// ---------------------------------------------------------------------------
// Raw Slack payload builders
// ---------------------------------------------------------------------------

export interface RawMessageOptions {
  ts: string;
  user?: string;
  text?: string;
  bot?: boolean;
  threadTs?: string;
  replyCount?: number;
}

export interface RawMessage {
  type: 'message';
  ts: string;
  user?: string;
  text: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
}

export function rawMessage(options: RawMessageOptions): RawMessage {
  const message: RawMessage = {
    type: 'message',
    ts: options.ts,
    text: options.text ?? `${MESSAGE_TEXT_MARKER}-${options.ts}`,
  };
  if (options.bot) {
    message.bot_id = BOT_ONE;
    message.subtype = 'bot_message';
  } else {
    message.user = options.user ?? USER_ME;
  }
  if (options.threadTs) message.thread_ts = options.threadTs;
  if (options.replyCount !== undefined) message.reply_count = options.replyCount;
  return message;
}

export interface RawChannel {
  id: string;
  name?: string;
  is_channel: boolean;
  is_group: boolean;
  is_im: boolean;
  is_mpim: boolean;
  is_private: boolean;
  is_archived: boolean;
  is_member: boolean;
  is_ext_shared: boolean;
  num_members?: number;
  user?: string;
  topic?: { value: string };
  purpose?: { value: string };
}

export function publicChannel(id: string, name: string, extra: Partial<RawChannel> = {}): RawChannel {
  return {
    id,
    name,
    is_channel: true,
    is_group: false,
    is_im: false,
    is_mpim: false,
    is_private: false,
    is_archived: false,
    is_member: true,
    is_ext_shared: false,
    num_members: 3,
    topic: { value: 'FIXTURE-TOPIC' },
    purpose: { value: 'FIXTURE-PURPOSE' },
    ...extra,
  };
}

export function privateChannel(id: string, name: string, extra: Partial<RawChannel> = {}): RawChannel {
  return publicChannel(id, name, {
    is_channel: false,
    is_group: true,
    is_private: true,
    ...extra,
  });
}

export function directChannel(id: string, partnerUserId: string, extra: Partial<RawChannel> = {}): RawChannel {
  return {
    id,
    is_channel: false,
    is_group: false,
    is_im: true,
    is_mpim: false,
    is_private: true,
    is_archived: false,
    is_member: true,
    is_ext_shared: false,
    user: partnerUserId,
    ...extra,
  };
}

export interface RawUser {
  id: string;
  name: string;
  deleted: boolean;
  is_bot: boolean;
  tz: string;
  profile: {
    display_name: string;
    real_name: string;
    title: string;
    email?: string;
  };
}

export interface RawUserOptions {
  id: string;
  displayName: string;
  email?: string;
  isBot?: boolean;
  deleted?: boolean;
}

export function rawUser(options: RawUserOptions): RawUser {
  const profile: RawUser['profile'] = {
    display_name: options.displayName,
    real_name: `FIXTURE-REAL-NAME-${options.id}`,
    title: 'FIXTURE-TITLE',
  };
  if (options.email !== undefined) profile.email = options.email;
  return {
    id: options.id,
    name: `handle-${options.id.toLowerCase()}`,
    deleted: options.deleted ?? false,
    is_bot: options.isBot ?? false,
    tz: 'UTC',
    profile,
  };
}

export interface RawMatchOptions {
  ts: string;
  channelId: string;
  channelName?: string;
  user?: string;
  text?: string;
  permalink?: string;
}

export function rawSearchMatch(options: RawMatchOptions) {
  return {
    type: 'message',
    ts: options.ts,
    user: options.user ?? USER_ME,
    username: 'handle-fixture',
    text: options.text ?? `${MESSAGE_TEXT_MARKER}-${options.ts}`,
    channel: { id: options.channelId, name: options.channelName ?? 'fixture-room' },
    permalink:
      options.permalink ??
      `https://example-team.slack.com/archives/${options.channelId}/p${options.ts.replace('.', '')}`,
  };
}

// ---------------------------------------------------------------------------
// Route helpers: behaviour of one Web API method in the fake
// ---------------------------------------------------------------------------

export type RouteParams = Record<string, any>;
export type Route = (params: RouteParams) => unknown | Promise<unknown>;

const OFFSET_PREFIX = 'offset:';

function offsetFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || !cursor.startsWith(OFFSET_PREFIX)) return 0;
  return Number(cursor.slice(OFFSET_PREFIX.length));
}

function pageOf<T>(all: T[], params: RouteParams) {
  const start = offsetFromCursor(params.cursor);
  const limit = Number(params.limit ?? 100);
  const slice = all.slice(start, start + limit);
  const nextStart = start + limit;
  const hasMore = nextStart < all.length;
  return {
    slice,
    has_more: hasMore,
    response_metadata: hasMore ? { next_cursor: `${OFFSET_PREFIX}${nextStart}` } : {},
  };
}

/** `conversations.history`: newest-first messages per channel, paged by `limit` and `cursor`. */
export function historyRoute(messagesByChannel: Record<string, RawMessage[]>): Route {
  return (params) => {
    const all = messagesByChannel[params.channel];
    if (!all) throw slackFailure('slack_error', { slack_code: 'channel_not_found' });
    const { slice, ...paging } = pageOf(all, params);
    return { messages: slice, ...paging };
  };
}

/**
 * `conversations.replies`: keyed by `<channel>:<rootTs>`, oldest-first, root first.
 * As Slack does, every page repeats the root message before that page's replies.
 */
export function repliesRoute(threads: Record<string, RawMessage[]>): Route {
  return (params) => {
    const all = threads[`${params.channel}:${params.ts}`];
    if (!all) throw slackFailure('slack_error', { slack_code: 'thread_not_found' });
    const [root, ...replies] = all;
    const { slice, ...paging } = pageOf(replies, params);
    return { messages: [root, ...slice], ...paging };
  };
}

export function conversationsInfoRoute(channels: Record<string, RawChannel>): Route {
  return (params) => {
    const channel = channels[params.channel];
    if (!channel) throw slackFailure('slack_error', { slack_code: 'channel_not_found' });
    return { channel };
  };
}

export function usersInfoRoute(users: RawUser[]): Route {
  return (params) => {
    const user = users.find((candidate) => candidate.id === params.user);
    if (!user) throw slackFailure('slack_error', { slack_code: 'user_not_found' });
    return { user };
  };
}

export function constantRoute(body: Record<string, unknown>): Route {
  return () => body;
}

// ---------------------------------------------------------------------------
// The fake client port
// ---------------------------------------------------------------------------

export interface UploadRecord {
  url: string;
  bytes: Buffer;
  contentLength: number;
}

export interface FakeSlackOptions {
  routes?: Record<string, Route>;
  directory?: RawUser[];
}

export interface RecordedCall {
  method: string;
  params: RouteParams;
}

type ConformingMethodName =
  | 'authTest'
  | 'authRevoke'
  | 'conversationsInfo'
  | 'conversationsHistory'
  | 'conversationsReplies'
  | 'usersInfo'
  | 'searchMessages'
  | 'postMessage'
  | 'addReaction'
  | 'getUploadUrl'
  | 'completeUpload'
  | 'getUserDirectory'
  | 'sendUploadBytes';

type PendingMethod = (params: SlackArguments) => Promise<SlackResponse>;

/** The real signature once SlackClient gains the method, so the fake is then checked against it too. */
type PendingClientMethod<Name extends string> = Name extends keyof SlackClient ? SlackClient[Name] : PendingMethod;

type FakedClientMethods = Pick<SlackClient, ConformingMethodName> & {
  conversationsList: PendingClientMethod<'conversationsList'>;
  conversationsMembers: PendingClientMethod<'conversationsMembers'>;
};

/** Every public method of the faked client, as a mock typed by the real client's signature. */
export type FakeSlackClient = { [Name in keyof FakedClientMethods]: Mock<FakedClientMethods[Name]> };

export function createFakeSlack(options: FakeSlackOptions = {}) {
  const routes: Record<string, Route> = { ...(options.routes ?? {}) };
  const calls: RecordedCall[] = [];
  const uploads: UploadRecord[] = [];
  let postCounter = 0;
  let uploadCounter = 0;

  async function callRoute(method: string, params: SlackArguments = {}): Promise<SlackResponse> {
    calls.push({ method, params });
    const route = routes[method];
    if (!route) {
      throw slackFailure('slack_error', { slack_code: `fixture_unrouted_${method}` });
    }
    const body = (await route(params)) as Record<string, unknown>;
    return { ok: true, ...body };
  }

  const routedTo = (slackMethod: string) => (params: SlackArguments = {}) => callRoute(slackMethod, params);

  const authTest = vi.fn<SlackClient['authTest']>(
    async () => (await callRoute('auth.test')) as AuthTestResponse,
  );

  const authRevoke = vi.fn<SlackClient['authRevoke']>(async () => ({ ok: true, revoked: true }));

  const conversationsInfo = vi.fn<SlackClient['conversationsInfo']>(routedTo('conversations.info'));
  const conversationsHistory = vi.fn<SlackClient['conversationsHistory']>(routedTo('conversations.history'));
  const conversationsReplies = vi.fn<SlackClient['conversationsReplies']>(routedTo('conversations.replies'));
  const usersInfo = vi.fn<SlackClient['usersInfo']>(routedTo('users.info'));
  const searchMessages = vi.fn<SlackClient['searchMessages']>(routedTo('search.messages'));

  // Methods the tool modules need that SlackClient does not expose yet.
  const conversationsList = vi.fn<FakedClientMethods['conversationsList']>(routedTo('conversations.list'));
  const conversationsMembers = vi.fn<FakedClientMethods['conversationsMembers']>(routedTo('conversations.members'));

  const getUserDirectory = vi.fn<SlackClient['getUserDirectory']>(async () => options.directory ?? []);

  const postMessage = vi.fn<SlackClient['postMessage']>(async (params) => {
    postCounter += 1;
    return { ok: true, channel: params.channel, ts: tsFor(1000 + postCounter) };
  });

  const addReaction = vi.fn<SlackClient['addReaction']>(async () => ({ ok: true }));

  const getUploadUrl = vi.fn<SlackClient['getUploadUrl']>(async () => {
    uploadCounter += 1;
    return {
      ok: true,
      upload_url: `https://upload.example.invalid/fixture-${uploadCounter}`,
      file_id: uploadCounter === 1 ? FILE_ONE : `F0EXAMPLE0${uploadCounter}`,
    };
  });

  const sendUploadBytes = vi.fn<SlackClient['sendUploadBytes']>(
    async (url: string, body: Readable, contentLength: number) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      uploads.push({ url, bytes: Buffer.concat(chunks), contentLength });
    },
  );

  const completeUpload = vi.fn<SlackClient['completeUpload']>(async (params) => ({
    ok: true,
    files: params.files.map((file) => ({
      id: file.id,
      permalink: `https://example-team.slack.com/files/${USER_ME}/${file.id}/fixture-file`,
    })),
  }));

  const client: FakeSlackClient = {
    authTest,
    authRevoke,
    conversationsInfo,
    conversationsHistory,
    conversationsReplies,
    conversationsList,
    conversationsMembers,
    usersInfo,
    searchMessages,
    getUserDirectory,
    postMessage,
    addReaction,
    getUploadUrl,
    sendUploadBytes,
    completeUpload,
  };

  return {
    client,
    calls,
    uploads,
    setRoute: (method: string, route: Route) => {
      routes[method] = route;
    },
    callsTo: (method: string) => calls.filter((recorded) => recorded.method === method),
  };
}

export type FakeSlack = ReturnType<typeof createFakeSlack>;

export const WRITE_METHOD_NAMES = [
  'postMessage',
  'addReaction',
  'getUploadUrl',
  'sendUploadBytes',
  'completeUpload',
] as const;
