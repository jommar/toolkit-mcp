import os from 'node:os';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  runBatch,
  type BatchEntry,
  type BatchError,
  type BatchOutcome,
  type BatchPage,
} from '../../services/slack/batch-runner.js';
import { decodeCursor, encodeCursor, type CursorPayload } from '../../services/slack/page-cursor.js';
import { matchesWorkspace, resolveLink, type LinkKind, type ResolvedLink } from '../../services/slack/link-resolver.js';
import { shapeMessage, toSlackTs, type RawMessage } from '../../services/slack/slack-model.js';
import { readToken, slackPaths, type TokenRecord } from '../../services/slack/credential-store.js';
import type { SlackClient, SlackResponse, SlackUser } from '../../services/slack/slack-client.js';

export interface ReadToolContext {
  slack: SlackClient;
  oauth?: { getPendingLogin(): unknown };
  now: () => number;
}

const TOOL = {
  search: 'slack_search_messages',
  messages: 'slack_get_messages',
  threads: 'slack_get_threads',
  channels: 'slack_get_channels',
  users: 'slack_get_users',
} as const;

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_TEXT_CHARS = 300;
const SEARCH_QUERY_CAP = 5;
const MESSAGE_CAP = 20;
const THREAD_CAP = 20;
const CHANNEL_CAP = 20;
const USER_ID_CAP = 100;
const USER_OTHER_CAP = 20;
const DIRECT_USER_LOOKUP_LIMIT = 10;
// conversations.replies returns the root first and counts it toward the limit, so one entry would hide a reply.
const SINGLE_MESSAGE_LOOKUP_LIMIT = 2;
const NAME_SCAN_LIMIT = 200;
const NAME_FALLBACK_SEARCH_COUNT = 20;
const NAME_SCAN_TYPES = 'public_channel,private_channel,mpim,im';
const DEFAULT_CHANNEL_TYPES = 'public_channel,private_channel';
const EMAIL_SCOPE = 'users:read.email';
const SEARCH_FIRST_CURSOR = '*';
const SEARCH_UPPER_FRACTION = '999999';
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const SLACK_ID_PATTERN = /^[A-Z][A-Z0-9]+$/;
const CHANNEL_LINKS: LinkKind[] = ['conversation', 'message'];
const MESSAGE_LINKS: LinkKind[] = ['message'];
const USER_LINKS: LinkKind[] = ['user'];
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(['text', 'mrkdwn', 'author_name', 'reactions', 'channel_name']);
const USER_FIELDS: ReadonlySet<string> = new Set(['real_name', 'title', 'tz', 'email']);
// Slack's own codes for a missing target; they reach the caller as item errors, not a failed call.
const ITEM_FAILURE_CODES: ReadonlySet<string> = new Set([
  'channel_not_found',
  'thread_not_found',
  'message_not_found',
  'user_not_found',
]);
const SESSION_REJECTED = 'session_rejected';
const SESSION_NEXT_STEP = 'Run slack_logout, then slack_login.';

type Shaped = Record<string, unknown>;
type Page<T> = SlackResponse & T;

interface MessageRecord extends RawMessage {
  reactions?: Array<{ name: string; count: number }>;
}

interface SearchMatch extends MessageRecord {
  channel?: { id: string; name?: string };
}

interface ChannelRecord {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_group?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_ext_shared?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface UserRecord extends SlackUser {
  tz?: string;
  profile?: { display_name?: string; real_name?: string; email?: string; title?: string };
}

interface Cursored {
  response_metadata?: { next_cursor?: string };
}
interface HistoryBody extends Cursored {
  messages?: MessageRecord[];
}
interface SearchBody extends Cursored {
  messages?: { total?: number; matches?: SearchMatch[] };
}
interface ChannelListBody extends Cursored {
  channels?: ChannelRecord[];
}
interface ChannelBody {
  channel: ChannelRecord;
}
interface MembersBody extends Cursored {
  members?: string[];
}
interface UserBody {
  user: UserRecord;
}

export interface SlackRef {
  channel: string;
  ts: string;
}

interface ReadArgs {
  fields?: string[];
  limit?: number;
  max_text_chars?: number;
}

interface ItemBase {
  ref?: string;
  cursor?: string;
}

interface SearchInput extends ItemBase {
  query?: string;
  exact_phrases?: string[];
  in_channels?: string[];
  from_users?: string[];
  after?: string;
  before?: string;
  top_level_only?: boolean;
  include_bots?: boolean;
}

interface MessageInput extends ItemBase {
  message?: string | SlackRef;
  channel?: string;
  after?: string;
  before?: string;
  top_level_only?: boolean;
}

interface ThreadInput extends ItemBase {
  thread?: string | SlackRef;
}

interface ChannelInput extends ItemBase {
  channel?: string;
  name?: string;
  member_only?: boolean;
  types?: string[];
  include_archived?: boolean;
}

interface UserInput extends ItemBase {
  user?: string;
  me?: boolean;
  query?: string;
  members_of?: string;
}

export interface SearchArgs extends ReadArgs {
  queries: SearchInput[];
}
export interface MessagesArgs extends ReadArgs {
  messages: MessageInput[];
}
export interface ThreadsArgs extends ReadArgs {
  threads: ThreadInput[];
}
export interface ChannelsArgs extends ReadArgs {
  channels: ChannelInput[];
}
export interface UsersArgs extends ReadArgs {
  users: UserInput[];
}

interface SearchTarget {
  query?: string;
  exact_phrases: string[];
  in_channels: string[];
  from_users: string[];
  after?: string;
  before?: string;
  top_level_only: boolean;
  include_bots: boolean;
}

interface HistoryTarget {
  kind: 'history';
  channel: string;
  after?: string;
  before?: string;
  top_level_only: boolean;
}

interface MessageTarget {
  kind: 'message';
  channel: string;
  ts: string;
  thread_ts?: string;
}

interface ThreadTarget {
  channel: string;
  root: string;
}

type ChannelTarget =
  | { kind: 'channel'; channel: string }
  | { kind: 'name'; name: string; prefix: boolean; include_archived: boolean }
  | { kind: 'member_only'; types: string; include_archived: boolean };

type UserTarget =
  | { kind: 'user'; user: string }
  | { kind: 'query'; query: string }
  | { kind: 'members'; channel: string };

// The cursor payload's `target` is one of the targets above, serialized; `position` is the upstream page token.
interface Start {
  target: string;
  position?: string;
  skip: number;
  upper?: string;
}

interface PageFetch {
  items: Shaped[];
  next?: string;
  extra?: Shaped;
}

interface Plan {
  ref: string;
  key: string;
  run: () => Promise<BatchPage<Shaped>>;
  resumeAt: (keptCount: number) => string;
}

interface Refusal {
  ref: string;
  failure: BatchError;
}

type Planned = Plan | Refusal;
type Extras = Map<string, Shaped>;

interface Names {
  people: () => Promise<UserRecord[]>;
  channelName: (channelId: string) => Promise<string | null>;
}

interface CallMeter {
  count: number;
}

interface ReadRun {
  ctx: ReadToolContext;
  team: TokenRecord;
  fields: string[];
  limit: number;
  viaDirectory: boolean;
  names: Names;
  extras: Extras;
  calls: CallMeter;
  shape: (raw: MessageRecord, channelId: string) => Promise<Shaped>;
}

/** Raised while planning or fetching one item; the batch keeps going and the item reports this code. */
class ItemFailure extends Error {
  readonly code: string;

  constructor(readonly failure: BatchError) {
    super(failure.message);
    this.code = failure.code;
  }
}

export function slackSearchMessagesHandler(ctx: ReadToolContext) {
  return async (args: SearchArgs): Promise<CallToolResult> => {
    assertBatchSize(args.queries.length, SEARCH_QUERY_CAP);
    const run = readRun(ctx, await connectedTeam(ctx), args, allowedFields(args.fields, MESSAGE_FIELDS));
    const upper = frozenUpper(ctx.now());
    return jsonResult(await runPlanned(args.queries.map((input) => planSearch(input, run, upper)), run));
  };
}

export function slackGetMessagesHandler(ctx: ReadToolContext) {
  return async (args: MessagesArgs): Promise<CallToolResult> => {
    assertBatchSize(args.messages.length, MESSAGE_CAP);
    const run = readRun(ctx, await connectedTeam(ctx), args, allowedFields(args.fields, MESSAGE_FIELDS));
    return jsonResult(await runPlanned(args.messages.map((input) => planMessageItem(input, run)), run));
  };
}

export function slackGetThreadsHandler(ctx: ReadToolContext) {
  return async (args: ThreadsArgs): Promise<CallToolResult> => {
    assertBatchSize(args.threads.length, THREAD_CAP);
    const run = readRun(ctx, await connectedTeam(ctx), args, allowedFields(args.fields, MESSAGE_FIELDS));
    return jsonResult(await runPlanned(args.threads.map((input) => planThreadItem(input, run)), run));
  };
}

export function slackGetChannelsHandler(ctx: ReadToolContext) {
  return async (args: ChannelsArgs): Promise<CallToolResult> => {
    assertBatchSize(args.channels.length, CHANNEL_CAP);
    const run = readRun(ctx, await connectedTeam(ctx), args, []);
    return jsonResult(await runPlanned(args.channels.map((input) => planChannelItem(input, run)), run));
  };
}

export function slackGetUsersHandler(ctx: ReadToolContext) {
  return async (args: UsersArgs): Promise<CallToolResult> => {
    const userIdItems = args.users.filter((input) => input.me || isUserIdItem(input)).length;
    const allUserIds = args.users.every(isUserIdItem);
    assertBatchSize(args.users.length, allUserIds ? USER_ID_CAP : USER_OTHER_CAP);
    const fields = allowedFields(args.fields, USER_FIELDS);
    const run = readRun(ctx, await connectedTeam(ctx), args, fields, userIdItems > DIRECT_USER_LOOKUP_LIMIT);
    return jsonResult(await runPlanned(args.users.map((input) => planUserItem(input, run)), run));
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function planSearch(input: SearchInput, run: ReadRun, upper: string): Planned {
  return planOrRefuse(input.ref ?? input.query ?? TOOL.search, () => {
    const start = startOfItem(
      TOOL.search,
      input.cursor,
      searchTargetOf(input, run.team),
      'A search needs query, exact_phrases or in_channels.',
    );
    // A cursor carries the bound of the page it continues; a fresh item takes the bound of this call.
    const bounded = { ...start, upper: start.upper ?? upper };
    return searchPlan(input.ref ?? slackSearchQuery(parseTarget<SearchTarget>(bounded.target)), bounded, run);
  });
}

function searchTargetOf(input: SearchInput, team: TokenRecord): SearchTarget | undefined {
  const target: SearchTarget = {
    query: input.query || undefined,
    exact_phrases: input.exact_phrases ?? [],
    in_channels: (input.in_channels ?? []).map((value) => channelIdOf(value, team)),
    from_users: (input.from_users ?? []).map((value) => userIdOf(value, team)),
    after: optionalSlackTs(input.after),
    before: optionalSlackTs(input.before),
    top_level_only: input.top_level_only ?? false,
    include_bots: input.include_bots ?? false,
  };
  if (!target.query && target.exact_phrases.length === 0 && target.in_channels.length === 0) return undefined;
  return target;
}

function slackSearchQuery(target: SearchTarget): string {
  const modifiers = [
    ...target.exact_phrases.map((phrase) => `"${phrase.replace(/"/g, '')}"`),
    ...target.in_channels.map((channelId) => `in:<#${channelId}>`),
    ...target.from_users.map((userId) => `from:<@${userId}>`),
    ...(target.after === undefined ? [] : [`after:${calendarDay(target.after, -1)}`]),
    ...(target.before === undefined ? [] : [`before:${calendarDay(target.before, 1)}`]),
  ];
  return [target.query, ...modifiers].filter(Boolean).join(' ');
}

function searchPlan(ref: string, start: Start, run: ReadRun): Plan {
  return planOf(TOOL.search, ref, start, (current) => searchPage(current, run), run.extras);
}

async function searchPage(start: Start, run: ReadRun): Promise<PageFetch> {
  const target = parseTarget<SearchTarget>(start.target);
  const body = (await run.ctx.slack.searchMessages({
    query: slackSearchQuery(target),
    count: run.limit,
    cursor: start.position ?? SEARCH_FIRST_CURSOR,
    sort: 'timestamp',
    sort_dir: 'desc',
  })) as Page<SearchBody>;
  const matches = (body.messages?.matches ?? []).filter((match) => withinSearchWindow(match, target, start.upper));
  return {
    items: await Promise.all(matches.map((match) => run.shape(match, match.channel?.id ?? ''))),
    next: body.response_metadata?.next_cursor,
    extra: { total: body.messages?.total ?? 0 },
  };
}

// Slack ts strings are fixed width, so string order is time order.
function withinSearchWindow(match: SearchMatch, target: SearchTarget, upper?: string): boolean {
  if (upper !== undefined && match.ts > upper) return false;
  if (target.top_level_only && isReply(match)) return false;
  if (!target.include_bots && Boolean(match.bot_id)) return false;
  return inTimeWindow(match.ts, target.after, target.before);
}

// ---------------------------------------------------------------------------
// Messages and threads
// ---------------------------------------------------------------------------

function planMessageItem(input: MessageInput, run: ReadRun): Planned {
  const hint = input.ref ?? (typeof input.message === 'string' ? input.message : input.channel) ?? TOOL.messages;
  return planOrRefuse(hint, () => {
    const start = startOfItem(
      TOOL.messages,
      input.cursor,
      messageTargetOf(input, run.team),
      'A message item needs message, channel or cursor.',
    );
    const target = parseTarget<HistoryTarget | MessageTarget>(start.target);
    return messagesPlan(input.ref ?? messageLabel(target), start, run);
  });
}

function messageTargetOf(input: MessageInput, team: TokenRecord): HistoryTarget | MessageTarget | undefined {
  if (input.message !== undefined) {
    if (typeof input.message === 'string') {
      const link = locate(input.message, MESSAGE_LINKS, team);
      return { kind: 'message', channel: link.channel_id!, ts: link.ts!, thread_ts: link.thread_ts };
    }
    return {
      kind: 'message',
      channel: channelIdOf(input.message.channel, team),
      ts: input.message.ts,
    };
  }
  if (input.channel !== undefined) {
    return {
      kind: 'history',
      channel: channelIdOf(input.channel, team),
      after: optionalSlackTs(input.after),
      before: optionalSlackTs(input.before),
      top_level_only: input.top_level_only ?? false,
    };
  }
  return undefined;
}

function messageLabel(target: HistoryTarget | MessageTarget): string {
  return target.kind === 'message' ? `${target.channel}@${target.ts}` : target.channel;
}

function messagesPlan(ref: string, start: Start, run: ReadRun): Plan {
  return planOf(TOOL.messages, ref, start, (current) => fetchMessages(current, run), run.extras);
}

async function fetchMessages(start: Start, run: ReadRun): Promise<PageFetch> {
  const target = parseTarget<HistoryTarget | MessageTarget>(start.target);
  if (target.kind === 'message') return fetchSingleMessage(target, run);
  const body = (await run.ctx.slack.conversationsHistory({
    channel: target.channel,
    limit: run.limit,
    cursor: start.position,
    oldest: target.after,
    latest: target.before,
    inclusive: true,
  })) as Page<HistoryBody>;
  const kept = (body.messages ?? []).filter((raw) => keepHistoryMessage(raw, target));
  return {
    items: await Promise.all(kept.map((raw) => run.shape(raw, target.channel))),
    next: body.response_metadata?.next_cursor,
  };
}

// The ceiling can cut a single message to a cursor, so that cursor must be able to name the message again.
// Replies answer for the root or for any reply of its thread, so one call finds a top-level message and a reply alike.
async function fetchSingleMessage(target: MessageTarget, run: ReadRun): Promise<PageFetch> {
  const body = (await run.ctx.slack
    .conversationsReplies({
      channel: target.channel,
      ts: target.thread_ts ?? target.ts,
      oldest: target.ts,
      latest: target.ts,
      inclusive: true,
      limit: SINGLE_MESSAGE_LOOKUP_LIMIT,
    })
    .catch((error: { slack_code?: unknown }) => {
      // Slack reports a ts outside every thread as thread_not_found; to the caller that is a missing message.
      if (error.slack_code === 'thread_not_found') throw messageNotFound();
      throw error;
    })) as Page<HistoryBody>;
  const raw = (body.messages ?? []).find((message) => message.ts === target.ts);
  if (!raw) throw messageNotFound();
  return { items: [await run.shape(raw, target.channel)] };
}

function messageNotFound(): ItemFailure {
  return new ItemFailure({ code: 'message_not_found', message: 'No message with that ts is visible to this token.' });
}

function keepHistoryMessage(raw: MessageRecord, target: HistoryTarget): boolean {
  if (raw.bot_id) return false;
  if (target.top_level_only && isReply(raw)) return false;
  return inTimeWindow(raw.ts, target.after, target.before);
}

function planThreadItem(input: ThreadInput, run: ReadRun): Planned {
  const hint = input.ref ?? (typeof input.thread === 'string' ? input.thread : TOOL.threads);
  return planOrRefuse(hint, () => {
    const start = startOfItem(
      TOOL.threads,
      input.cursor,
      threadTargetOf(input, run.team),
      'A thread item needs thread or cursor.',
    );
    return threadsPlan(input.ref ?? threadLabel(parseTarget<ThreadTarget>(start.target)), start, run);
  });
}

function threadTargetOf(input: ThreadInput, team: TokenRecord): ThreadTarget | undefined {
  if (input.thread === undefined) return undefined;
  if (typeof input.thread === 'string') {
    const link = locate(input.thread, MESSAGE_LINKS, team);
    return { channel: link.channel_id!, root: link.thread_ts ?? link.ts! };
  }
  return { channel: channelIdOf(input.thread.channel, team), root: input.thread.ts };
}

function threadLabel(target: ThreadTarget): string {
  return `${target.channel}:${target.root}`;
}

function threadsPlan(ref: string, start: Start, run: ReadRun): Plan {
  return planOf(TOOL.threads, ref, start, (current) => fetchThread(current, run), run.extras);
}

async function fetchThread(start: Start, run: ReadRun): Promise<PageFetch> {
  const target = parseTarget<ThreadTarget>(start.target);
  const body = (await run.ctx.slack.conversationsReplies({
    channel: target.channel,
    ts: target.root,
    limit: run.limit,
    cursor: start.position,
  })) as Page<HistoryBody>;
  const messages = body.messages ?? [];
  // Slack repeats the root on every page; it is kept once, on the first page.
  const replies = start.position === undefined ? messages : messages.filter((raw) => raw.ts !== target.root);
  const root = messages.find((raw) => raw.ts === target.root);
  return {
    items: await Promise.all(replies.map((raw) => run.shape(raw, target.channel))),
    next: body.response_metadata?.next_cursor,
    extra: { root_ts: target.root, reply_count: root?.reply_count },
  };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

function planChannelItem(input: ChannelInput, run: ReadRun): Planned {
  const hint = input.ref ?? input.channel ?? input.name ?? TOOL.channels;
  return planOrRefuse(hint, () => {
    const start = startOfItem(
      TOOL.channels,
      input.cursor,
      channelTargetOf(input, run.team),
      'A channel item needs channel, name, member_only or cursor.',
    );
    return channelsPlan(input.ref ?? channelLabel(parseTarget<ChannelTarget>(start.target)), start, run);
  });
}

function channelTargetOf(input: ChannelInput, team: TokenRecord): ChannelTarget | undefined {
  if (input.channel !== undefined) {
    return { kind: 'channel', channel: channelIdOf(input.channel, team) };
  }
  if (input.name !== undefined) {
    const prefix = input.name.endsWith('*');
    return {
      kind: 'name',
      name: prefix ? input.name.slice(0, -1) : input.name,
      prefix,
      include_archived: input.include_archived ?? false,
    };
  }
  if (input.member_only) {
    return {
      kind: 'member_only',
      types: input.types?.join(',') ?? DEFAULT_CHANNEL_TYPES,
      include_archived: input.include_archived ?? false,
    };
  }
  return undefined;
}

function channelLabel(target: ChannelTarget): string {
  if (target.kind === 'channel') return target.channel;
  if (target.kind === 'name') return target.prefix ? `${target.name}*` : target.name;
  return 'member_only';
}

function channelsPlan(ref: string, start: Start, run: ReadRun): Plan {
  return planOf(TOOL.channels, ref, start, (current) => fetchChannels(current, run), run.extras);
}

async function fetchChannels(start: Start, run: ReadRun): Promise<PageFetch> {
  const target = parseTarget<ChannelTarget>(start.target);
  if (target.kind === 'channel') {
    const channel = ((await run.ctx.slack.conversationsInfo({ channel: target.channel })) as Page<ChannelBody>).channel;
    return { items: [await channelWithParticipants(channel, run)] };
  }
  if (target.kind === 'member_only') {
    const body = (await run.ctx.slack.usersConversations({
      user: run.team.user_id,
      types: target.types,
      exclude_archived: !target.include_archived,
      limit: run.limit,
      cursor: start.position,
    })) as Page<ChannelListBody>;
    return { items: (body.channels ?? []).map(channelEntry), next: body.response_metadata?.next_cursor };
  }
  return fetchChannelsByName(target, run);
}

async function fetchChannelsByName(target: Extract<ChannelTarget, { kind: 'name' }>, run: ReadRun): Promise<PageFetch> {
  const body = (await run.ctx.slack.conversationsList({
    types: NAME_SCAN_TYPES,
    exclude_archived: !target.include_archived,
    limit: NAME_SCAN_LIMIT,
  })) as Page<ChannelListBody>;
  const listed = (body.channels ?? []).filter((channel) =>
    target.prefix ? channel.name?.startsWith(target.name) : channel.name === target.name,
  );
  if (listed.length > 0 || target.prefix) return { items: listed.map(channelEntry) };
  return { items: await channelsNamedInSearch(target.name, run) };
}

// A channel conversations.list does not return can still be found through a message in it.
async function channelsNamedInSearch(name: string, run: ReadRun): Promise<Shaped[]> {
  const body = (await run.ctx.slack.searchMessages({
    query: `in:${name}`,
    count: NAME_FALLBACK_SEARCH_COUNT,
  })) as Page<SearchBody>;
  const channelIds = new Set(
    (body.messages?.matches ?? []).flatMap((match) =>
      match.channel && match.channel.name === name ? [match.channel.id] : [],
    ),
  );
  const infos = await Promise.all(
    [...channelIds].map((channelId) => run.ctx.slack.conversationsInfo({ channel: channelId })),
  );
  return infos.map((info) => channelEntry((info as Page<ChannelBody>).channel));
}

async function channelWithParticipants(raw: ChannelRecord, run: ReadRun): Promise<Shaped> {
  const entry = channelEntry(raw);
  if (raw.is_im) entry.participants = await participantsOf(raw.id, run);
  return entry;
}

async function participantsOf(channelId: string, run: ReadRun): Promise<Shaped[]> {
  const body = (await run.ctx.slack.conversationsMembers({ channel: channelId })) as Page<MembersBody>;
  const byId = userIndex(await run.names.people());
  return (body.members ?? []).map((userId) => ({
    user_id: userId,
    display_name: displayName(byId.get(userId)),
  }));
}

function channelEntry(raw: ChannelRecord): Shaped {
  return {
    channel_id: raw.id,
    name: raw.name,
    type: channelType(raw),
    is_archived: raw.is_archived ?? false,
    is_ext_shared: raw.is_ext_shared ?? false,
    is_member: raw.is_member ?? false,
    member_count: raw.num_members ?? null,
    topic: raw.topic?.value ?? '',
    purpose: raw.purpose?.value ?? '',
  };
}

function channelType(raw: ChannelRecord): string {
  if (raw.is_im) return 'im';
  if (raw.is_mpim) return 'mpim';
  if (raw.is_private || raw.is_group) return 'private_channel';
  return 'public_channel';
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function planUserItem(input: UserInput, run: ReadRun): Planned {
  const hint = input.ref ?? input.user ?? input.query ?? input.members_of ?? TOOL.users;
  return planOrRefuse(hint, () => {
    const start = startOfItem(
      TOOL.users,
      input.cursor,
      userTargetOf(input, run.team),
      'A user item needs user, me, query, members_of or cursor.',
    );
    return usersPlan(input.ref ?? userLabel(parseTarget<UserTarget>(start.target)), start, run);
  });
}

function userTargetOf(input: UserInput, team: TokenRecord): UserTarget | undefined {
  if (input.user !== undefined) return { kind: 'user', user: userIdOf(input.user, team) };
  if (input.me) return { kind: 'user', user: team.user_id };
  if (input.query !== undefined) return { kind: 'query', query: input.query };
  if (input.members_of !== undefined) return { kind: 'members', channel: channelIdOf(input.members_of, team) };
  return undefined;
}

// A cursor-only item that resumes a user lookup still asks for a user id, so it counts toward the caps.
function isUserIdItem(input: UserInput): boolean {
  return input.user !== undefined || resumesUserLookup(input);
}

function resumesUserLookup(input: UserInput): boolean {
  if (input.cursor === undefined) return false;
  const decoded = decodeCursor(TOOL.users, input.cursor);
  return decoded.ok && parseTarget<UserTarget>(decoded.payload.target).kind === 'user';
}

function userLabel(target: UserTarget): string {
  if (target.kind === 'user') return target.user;
  return target.kind === 'query' ? target.query : target.channel;
}

function usersPlan(ref: string, start: Start, run: ReadRun): Plan {
  return planOf(TOOL.users, ref, start, (current) => fetchUsers(current, run), run.extras);
}

async function fetchUsers(start: Start, run: ReadRun): Promise<PageFetch> {
  const target = parseTarget<UserTarget>(start.target);
  if (target.kind === 'user') return { items: [await userLookup(target.user, run)] };
  if (target.kind === 'query') return queryUsers(target.query, start.position, run);
  return membersOf(target.channel, start.position, run);
}

async function userLookup(userId: string, run: ReadRun): Promise<Shaped> {
  const raw = run.viaDirectory
    ? (await run.names.people()).find((candidate) => candidate.id === userId)
    : ((await run.ctx.slack.usersInfo({ user: userId })) as Page<UserBody>).user;
  if (!raw) throw new ItemFailure({ code: 'user_not_found', message: 'No such user is visible to this token.' });
  return userEntry(raw, run);
}

// The directory is one cached list, so a query pages over it by offset.
async function queryUsers(query: string, position: string | undefined, run: ReadRun): Promise<PageFetch> {
  const offset = Number(position ?? 0);
  const needle = query.toLowerCase();
  const matches = (await run.names.people()).filter((user) => namesMatch(user, needle));
  return {
    items: matches.slice(offset, offset + run.limit).map((user) => userEntry(user, run)),
    next: offset + run.limit < matches.length ? String(offset + run.limit) : undefined,
  };
}

async function membersOf(channelId: string, position: string | undefined, run: ReadRun): Promise<PageFetch> {
  const body = (await run.ctx.slack.conversationsMembers({
    channel: channelId,
    limit: run.limit,
    cursor: position,
  })) as Page<MembersBody>;
  const byId = userIndex(await run.names.people());
  return {
    items: (body.members ?? []).map((userId) => {
      const user = byId.get(userId);
      return user ? userEntry(user, run) : { user_id: userId, display_name: null };
    }),
    next: body.response_metadata?.next_cursor,
  };
}

function namesMatch(user: UserRecord, needle: string): boolean {
  return [user.profile?.display_name, user.profile?.real_name, user.name].some((value) =>
    (value ?? '').toLowerCase().includes(needle),
  );
}

function userEntry(raw: UserRecord, run: ReadRun): Shaped {
  const entry: Shaped = {
    user_id: raw.id,
    display_name: displayName(raw),
    is_bot: raw.is_bot ?? false,
    deleted: raw.deleted ?? false,
  };
  if (run.fields.includes('real_name')) entry.real_name = raw.profile?.real_name ?? null;
  if (run.fields.includes('title')) entry.title = raw.profile?.title ?? null;
  if (run.fields.includes('tz')) entry.tz = raw.tz ?? null;
  if (run.fields.includes('email')) Object.assign(entry, emailFields(raw, run.team));
  return entry;
}

// An address is shown only when the token was granted the scope that reads it.
function emailFields(raw: UserRecord, team: TokenRecord): Shaped {
  if (!team.scopes.includes(EMAIL_SCOPE)) return { email: null, email_unavailable: 'scope_missing' };
  const address = raw.profile?.email;
  return address ? { email: address, email_unavailable: undefined } : { email: null, email_unavailable: 'not_set' };
}

function displayName(user: UserRecord | undefined): string | null {
  return user?.profile?.display_name || user?.profile?.real_name || user?.name || null;
}

function userIndex(users: UserRecord[]): Map<string, UserRecord> {
  return new Map(users.map((user): [string, UserRecord] => [user.id, user]));
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function readRun(
  ctx: ReadToolContext,
  team: TokenRecord,
  args: ReadArgs,
  fields: string[],
  viaDirectory = false,
): ReadRun {
  const calls: CallMeter = { count: 0 };
  const metered: ReadToolContext = { ...ctx, slack: countUpstreamCalls(ctx.slack, calls) };
  const names = createNames(metered);
  const maxTextChars = args.max_text_chars ?? DEFAULT_MAX_TEXT_CHARS;
  return {
    ctx: metered,
    team,
    fields,
    limit: args.limit ?? DEFAULT_LIMIT,
    viaDirectory,
    names,
    extras: new Map(),
    calls,
    shape: async (raw, channelId) => {
      const shaped: Shaped = { ...shapeMessage(raw, { channelId, teamUrl: team.team_url, fields }) };
      if (typeof shaped.text === 'string') shaped.text = truncate(shaped.text, maxTextChars);
      if (typeof shaped.mrkdwn === 'string') shaped.mrkdwn = truncate(shaped.mrkdwn, maxTextChars);
      if (fields.includes('author_name')) shaped.author_name = await authorName(names, raw.user);
      if (fields.includes('reactions')) {
        shaped.reactions = (raw.reactions ?? []).map(({ name, count }) => ({ name, count }));
      }
      if (fields.includes('channel_name')) shaped.channel_name = await names.channelName(channelId);
      return shaped;
    },
  };
}

// Each SlackClient method call is one upstream call. A lookup answered from the directory adds none.
function countUpstreamCalls(slack: SlackClient, calls: CallMeter): SlackClient {
  return new Proxy(slack, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.count += 1;
        return value.apply(target, args);
      };
    },
  });
}

// Lookups that several items in one call share are made once per call.
function createNames(ctx: ReadToolContext): Names {
  let directory: Promise<UserRecord[]> | undefined;
  const channelNames = new Map<string, Promise<string | null>>();
  return {
    people: () => (directory ??= ctx.slack.getUserDirectory()),
    channelName: (channelId) => {
      let name = channelNames.get(channelId);
      if (!name) {
        name = ctx.slack
          .conversationsInfo({ channel: channelId })
          .then((body) => (body as Page<ChannelBody>).channel.name ?? null);
        channelNames.set(channelId, name);
      }
      return name;
    },
  };
}

async function authorName(names: Names, userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const user = (await names.people()).find((candidate) => candidate.id === userId);
  return displayName(user);
}

async function connectedTeam(ctx: ReadToolContext): Promise<TokenRecord> {
  const token = await readToken(slackPaths(os.homedir()));
  if (token) return token;
  if (ctx.oauth?.getPendingLogin()) {
    throw callError(
      'login_pending',
      'A login is waiting for approval and no token is stored yet.',
      'Open the authorize link, or paste the redirected address into slack_login.',
    );
  }
  throw callError('not_connected', 'No Slack token is stored for this module.', 'Run slack_login.');
}

function locate(value: string, accepted: LinkKind[], team: TokenRecord): ResolvedLink {
  const link = SLACK_ID_PATTERN.test(value) ? idLink(value) : parsedLinkOrRefuse(value);
  if (!accepted.includes(link.kind)) {
    throw new ItemFailure({
      code: 'wrong_link_kind',
      message: `This field takes ${accepted.join(' or ')} links, not ${link.kind} links.`,
    });
  }
  if (link.team_id !== undefined || link.team_domain !== undefined) {
    const check = matchesWorkspace(link, team);
    if (!check.ok) throw new ItemFailure(check.error);
  }
  return link;
}

function parsedLinkOrRefuse(value: string): ResolvedLink {
  const parsed = resolveLink(value);
  if (!parsed.ok) throw new ItemFailure(parsed.error);
  return parsed.link;
}

// The accepted link kinds always carry the field each caller reads, so these assertions cannot fail.
function channelIdOf(value: string, team: TokenRecord): string {
  return locate(value, CHANNEL_LINKS, team).channel_id!;
}

function userIdOf(value: string, team: TokenRecord): string {
  return locate(value, USER_LINKS, team).user_id!;
}

function idLink(id: string): ResolvedLink {
  if (id.startsWith('U') || id.startsWith('W')) return { kind: 'user', user_id: id };
  if (id.startsWith('F')) return { kind: 'file', file_id: id };
  return { kind: 'conversation', channel_id: id };
}

function planOrRefuse(hint: string, build: () => Plan): Planned {
  try {
    return build();
  } catch (error) {
    if (error instanceof ItemFailure) return { ref: hint, failure: error.failure };
    throw error;
  }
}

function planOf(
  tool: string,
  ref: string,
  start: Start,
  fetchPage: (start: Start) => Promise<PageFetch>,
  extras: Extras,
): Plan {
  const key = JSON.stringify(start);
  return {
    ref,
    key,
    run: async () => {
      const page = await fetchPage(start).catch((error: unknown) => {
        throw mapSlackItemError(error);
      });
      if (page.extra) extras.set(key, page.extra);
      return {
        items: page.items.slice(start.skip),
        hasMore: Boolean(page.next),
        nextPageToken: page.next ? encodeCursor(tool, { ...start, position: page.next, skip: 0 }) : undefined,
      };
    },
    resumeAt: (keptCount) => encodeCursor(tool, { ...start, skip: start.skip + keptCount }),
  };
}

function mapSlackItemError(error: unknown): unknown {
  const failure = error as { code?: unknown; slack_code?: unknown; message?: string };
  const slackCode = failure.slack_code;
  if (failure.code === 'slack_error' && typeof slackCode === 'string' && ITEM_FAILURE_CODES.has(slackCode)) {
    return new ItemFailure({ code: slackCode, message: failure.message ?? slackCode });
  }
  return error;
}

function isPlan(planned: Planned): planned is Plan {
  return 'run' in planned;
}

async function runPlanned(planned: Planned[], run: ReadRun): Promise<{ results: Shaped[]; truncated: boolean }> {
  const runnable = planned.flatMap((entry, index) => (isPlan(entry) ? [{ index, plan: entry }] : []));
  const outcome = await runBatch(
    runnable.map(({ plan }) => plan),
    {
      key: (plan) => plan.key,
      exec: (plan) => plan.run(),
      resume: (plan, keptCount) => plan.resumeAt(keptCount),
      limits: { maxItems: runnable.length, callsSpent: () => run.calls.count },
    },
  );
  rejectWhenSessionEnded(outcome);
  const byIndex = new Map<number, BatchEntry<Shaped>>();
  for (const entry of outcome.results) {
    const index = runnable[entry.index].index;
    byIndex.set(index, { ...entry, index });
  }
  const results = planned.map((entry, index): Shaped =>
    isPlan(entry)
      ? { ...byIndex.get(index), ...run.extras.get(entry.key) }
      : { ref: entry.ref, index, status: 'error', error: entry.failure },
  );
  return { results, truncated: outcome.truncated };
}

// A rejected session fails every item the same way, so it fails the call rather than each item.
function rejectWhenSessionEnded(outcome: BatchOutcome<Shaped>): void {
  const rejected = outcome.results.find((entry) => entry.status === 'error' && entry.error.code === SESSION_REJECTED);
  if (rejected?.status === 'error') {
    throw callError(SESSION_REJECTED, rejected.error.message, SESSION_NEXT_STEP);
  }
}

function startOf(target: object): Start {
  return { target: JSON.stringify(target), skip: 0 };
}

function decodedStart(tool: string, cursor: string, expectedTarget?: string): CursorPayload {
  const decoded = decodeCursor(tool, cursor, expectedTarget);
  if (!decoded.ok) throw new ItemFailure(decoded.error);
  return decoded.payload;
}

// A cursor resumes the target it was issued for. An item that also names a target must name that same one.
function startOfItem(tool: string, cursor: string | undefined, ownTarget: object | undefined, missing: string): Start {
  if (ownTarget === undefined) {
    if (cursor === undefined) throw invalidParams(missing);
    return decodedStart(tool, cursor);
  }
  if (cursor === undefined) return startOf(ownTarget);
  return decodedStart(tool, cursor, JSON.stringify(ownTarget));
}

function parseTarget<T>(target: string): T {
  return JSON.parse(target) as T;
}

function assertBatchSize(count: number, cap: number): void {
  if (count > cap) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `slack.batch_too_large: ${count} items were sent, at most ${cap} fit in one call; split the list.`,
    );
  }
}

function allowedFields(requested: string[] = [], allowed: ReadonlySet<string>): string[] {
  const unknown = requested.find((field) => !allowed.has(field));
  if (unknown !== undefined) {
    throw invalidParams(`"${unknown}" is not a field this tool returns. Use one of: ${[...allowed].join(', ')}.`);
  }
  return requested;
}

function invalidParams(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, message);
}

function callError(code: string, sentence: string, nextStep: string): McpError {
  return new McpError(ErrorCode.InvalidRequest, `slack.${code}: ${sentence} ${nextStep}`);
}

function jsonResult(body: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function isReply(message: RawMessage): boolean {
  return message.thread_ts !== undefined && message.thread_ts !== message.ts;
}

function inTimeWindow(ts: string, after?: string, before?: string): boolean {
  return (after === undefined || ts >= after) && (before === undefined || ts < before);
}

function optionalSlackTs(value: string | undefined): string | undefined {
  return value === undefined ? undefined : slackTs(value);
}

function slackTs(value: string): string {
  try {
    return toSlackTs(value);
  } catch {
    throw invalidParams('Expected a Slack ts or an ISO 8601 time with a time zone.');
  }
}

// The upper bound freezes search at the moment of page one, so messages posted later do not shift the pages.
function frozenUpper(nowMs: number): string {
  return `${Math.floor(nowMs / MILLISECONDS_PER_SECOND)}.${SEARCH_UPPER_FRACTION}`;
}

function calendarDay(ts: string, offsetDays: number): string {
  const seconds = Number(ts.split('.')[0]);
  return new Date(seconds * MILLISECONDS_PER_SECOND + offsetDays * MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
}
