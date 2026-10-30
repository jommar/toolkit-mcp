import { stat } from 'node:fs/promises';
import os from 'node:os';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { describeFailure } from '../../services/slack/batch-runner.js';
import { readToken, slackPaths, type TokenRecord } from '../../services/slack/credential-store.js';
import { matchesWorkspace, resolveLink, type ResolvedLink } from '../../services/slack/link-resolver.js';
import { buildPermalink, cleanText, isSlackTs, type RawMessage } from '../../services/slack/slack-model.js';
import type { SlackClient, SlackResponse, SlackUser } from '../../services/slack/slack-client.js';
import { inspectUploadFile, openHashedStream } from '../../services/slack/upload-source.js';
import type { WriteGate } from './write-gate.js';

const MAX_WRITE_ITEMS = 10;
const WORKSPACE_CHANGED_MESSAGE =
  'The connected workspace changed after this was previewed, so nothing was sent. ' +
  'Preview the items again with slack_prepare_write.';
const CONVERSATION_ID = /^[CDG][A-Z0-9]+$/;
const USER_MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const USERGROUP_MENTION = /<!subteam\^([A-Z0-9]+)(?:\|([^>]+))?>/g;
const BROADCAST_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;

const refField = z.string().max(64).optional().describe('Caller reference, echoed in the preview and the result.');
const destinationField = z
  .string()
  .min(1)
  .describe('A conversation id (C, G or D prefix) or a Slack link to a conversation or message.');
const expectedDestinationField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Required with an id: the channel name, the DM partner's user id or handle, or the group-DM handles.",
  );
const threadField = z.string().min(1).optional().describe('Thread to reply in: a Slack ts or a message link.');

const postItemSchema = z.object({
  action: z.literal('post'),
  ref: refField,
  destination: destinationField,
  expected_destination: expectedDestinationField,
  text: z.string().min(1).max(40_000).describe('Message text, sent with link_names off.'),
  thread: threadField,
  reply_broadcast: z.boolean().optional().describe('Also show a thread reply in the channel.'),
});

const reactItemSchema = z.object({
  action: z.literal('react'),
  ref: refField,
  message: z.union([
    z.string().min(1).describe('A message link.'),
    z.object({ channel: z.string().min(1), ts: z.string().refine(isSlackTs, 'Expected a Slack ts.') }),
  ]),
  expected_destination: expectedDestinationField,
  emoji: z.string().min(1).max(100).describe('Emoji name, with or without colons.'),
});

const uploadItemSchema = z.object({
  action: z.literal('upload'),
  ref: refField,
  destination: destinationField,
  expected_destination: expectedDestinationField,
  thread: threadField,
  path: z.string().min(1).describe('Absolute path of the file; a symlink is followed and shown.'),
  filename: z.string().min(1).optional().describe('File name in Slack; defaults to the file name.'),
  title: z.string().min(1).optional().describe('File title; defaults to the file name.'),
  comment: z.string().max(40_000).optional().describe('Initial comment posted with the file.'),
});

const writeItemSchema = z.discriminatedUnion('action', [postItemSchema, reactItemSchema, uploadItemSchema]);

export const slackPrepareWriteSchema = z.object({
  items: z.array(writeItemSchema).min(1).describe('1 to 10 write items, all sent under one confirmation token.'),
});

export const slackConfirmWriteSchema = z.object({
  confirmation_token: z.string().min(1).describe('The token from slack_prepare_write; sends the previewed items once.'),
});

type WriteItem = z.infer<typeof writeItemSchema>;
type PostItem = z.infer<typeof postItemSchema>;
type ReactItem = z.infer<typeof reactItemSchema>;
type UploadItem = z.infer<typeof uploadItemSchema>;

export type FrozenWrite =
  | {
      action: 'post';
      ref: string;
      channelId: string;
      threadTs?: string;
      text: string;
      replyBroadcast?: boolean;
      teamId: string;
      teamUrl: string;
    }
  | { action: 'react'; ref: string; channelId: string; ts: string; emoji: string; teamId: string; teamUrl: string }
  | {
      action: 'upload';
      ref: string;
      channelId: string;
      threadTs?: string;
      teamId: string;
      resolvedPath: string;
      size: number;
      sha256: string;
      filename: string;
      title: string;
      comment?: string;
    };

export interface WriteToolContext {
  slack: SlackClient;
  gate: WriteGate<FrozenWrite>;
}

interface ItemError {
  code: string;
  message: string;
  retry_after_s?: number;
  slack_code?: string;
  http_status?: number;
  step?: string;
}

interface WriteResult {
  index: number;
  ref: string;
  action: string;
  channel_id: string;
  status: 'ok' | 'error';
  ts?: string;
  file_id?: string;
  permalink?: string;
  error?: ItemError;
}

interface Sent {
  ts?: string;
  file_id?: string;
  permalink?: string;
}

type ConversationType = 'public_channel' | 'private_channel' | 'im' | 'mpim';

interface SlackChannel {
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_ext_shared?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface Participant {
  user_id: string;
  display_name: string;
}

interface Destination {
  type: ConversationType;
  name?: string;
  participants?: Participant[];
  is_private?: boolean;
  is_ext_shared?: boolean;
  is_member?: boolean;
  member_count?: number;
  topic?: string;
  purpose?: string;
  thread_root?: { ts: string; author_name?: string; first_line: string };
}

interface Mention {
  kind: 'user' | 'usergroup' | 'broadcast';
  id: string;
  display_name: string;
}

interface Place {
  channelId: string;
  root?: string;
}

interface Prepared {
  preview: Record<string, unknown>;
  frozen?: FrozenWrite;
}

interface PrepareScope {
  slack: SlackClient;
  token: TokenRecord;
  lookupUser: (id: string) => Promise<SlackUser>;
}

type ChannelResponse = SlackResponse & { channel: SlackChannel };
type UserResponse = SlackResponse & { user: SlackUser };
type RepliesResponse = SlackResponse & { messages: RawMessage[] };
type MembersResponse = SlackResponse & { members: string[] };
type CompletedUploadResponse = SlackResponse & { files?: Array<{ permalink?: string }> };

export const slackPrepareWriteHandler = (context: WriteToolContext) => async (args: unknown) => {
  const { items } = slackPrepareWriteSchema.parse(args);
  if (items.length > MAX_WRITE_ITEMS) {
    throw callError(
      'batch_too_large',
      `${items.length} items were sent, at most ${MAX_WRITE_ITEMS} fit in one confirmation. Split the list.`,
    );
  }
  for (const item of items) requireExpectedForConversationId(item);

  const token = await connectedWorkspace();
  const scope: PrepareScope = { slack: context.slack, token, lookupUser: createUserLookup(context.slack) };
  const prepared: Prepared[] = [];
  for (const [index, item] of items.entries()) {
    prepared.push(await prepareItem(item, index, scope));
  }

  const writes = prepared.flatMap(({ frozen }) => (frozen ? [frozen] : []));
  const previews = prepared.map(({ preview }) => preview);
  if (writes.length !== prepared.length) return jsonResult({ items: previews });
  return jsonResult({ ...context.gate.issue(writes), items: previews });
};

export const slackConfirmWriteHandler = (context: WriteToolContext) => async (args: unknown) => {
  const { confirmation_token } = slackConfirmWriteSchema.parse(args);
  const { team_id: connectedTeamId } = await connectedWorkspace();
  const outcome = await context.gate.redeem(confirmation_token, (write, index) =>
    sendWrite(context.slack, write, index, connectedTeamId),
  );
  return jsonResult(outcome);
};

function jsonResult(body: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

function callError(code: string, sentence: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `slack.${code}: ${sentence}`);
}

function itemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function toItemError(error: unknown): ItemError {
  const { slack_code, http_status, step } = (error ?? {}) as Record<string, unknown>;
  const item: ItemError = { ...describeFailure(error) };
  if (typeof slack_code === 'string') item.slack_code = slack_code;
  if (typeof http_status === 'number') item.http_status = http_status;
  if (typeof step === 'string') item.step = step;
  return item;
}

async function connectedWorkspace(): Promise<TokenRecord> {
  const token = await readToken(slackPaths(os.homedir()));
  if (!token) throw callError('not_connected', 'No Slack account is connected. Run slack_login first.');
  return token;
}

function requireExpectedForConversationId(item: WriteItem): void {
  const target = item.action === 'react' ? reactChannelInput(item) : item.destination;
  if (target !== undefined && CONVERSATION_ID.test(target) && item.expected_destination === undefined) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'expected_destination is required with a conversation id. Give the channel name, the DM partner or ' +
        'the group-DM handles, or send the Slack link instead.',
    );
  }
}

function reactChannelInput(item: ReactItem): string | undefined {
  return typeof item.message === 'string' ? undefined : item.message.channel;
}

function createUserLookup(slack: SlackClient): (id: string) => Promise<SlackUser> {
  const lookups = new Map<string, Promise<SlackUser>>();
  return (id) => {
    const cached = lookups.get(id);
    if (cached) return cached;
    const lookup = slack.usersInfo({ user: id }).then((response) => (response as UserResponse).user);
    lookups.set(id, lookup);
    return lookup;
  };
}

async function prepareItem(item: WriteItem, index: number, scope: PrepareScope): Promise<Prepared> {
  const ref = item.ref ?? String(index);
  try {
    switch (item.action) {
      case 'post':
        return await preparePost(item, index, ref, scope);
      case 'react':
        return await prepareReact(item, index, ref, scope);
      case 'upload':
        return await prepareUpload(item, index, ref, scope);
    }
  } catch (error) {
    return { preview: { index, ref, action: item.action, error: toItemError(error) } };
  }
}

async function preparePost(item: PostItem, index: number, ref: string, scope: PrepareScope): Promise<Prepared> {
  const place = placeOf(item.destination, scope.token);
  const threadTs = reconcileRoots(place.root, threadRootOf(item.thread, scope.token));
  const { destination, warnings } = await describeDestination(
    place.channelId,
    threadTs,
    item.expected_destination,
    scope,
  );
  const mentions = await mentionsIn(item.text, scope);
  return {
    preview: {
      index,
      ref,
      action: 'post',
      destination,
      mentions,
      warnings: [...warnings, ...mentionWarnings(mentions)],
      text_preview: item.text,
      char_count: item.text.length,
    },
    frozen: {
      action: 'post',
      ref,
      channelId: place.channelId,
      threadTs,
      text: item.text,
      replyBroadcast: item.reply_broadcast,
      teamId: scope.token.team_id,
      teamUrl: scope.token.team_url,
    },
  };
}

async function prepareReact(item: ReactItem, index: number, ref: string, scope: PrepareScope): Promise<Prepared> {
  const target = messageTargetOf(item.message, scope.token);
  const { destination, warnings } = await describeDestination(
    target.channelId,
    undefined,
    item.expected_destination,
    scope,
  );
  const emoji = item.emoji.replace(/^:|:$/g, '');
  const teamId = scope.token.team_id;
  const teamUrl = scope.token.team_url;
  return {
    preview: {
      index,
      ref,
      action: 'react',
      destination,
      mentions: [],
      warnings,
      emoji,
      message: {
        channel_id: target.channelId,
        ts: target.ts,
        permalink: buildPermalink({ teamUrl, channelId: target.channelId, ts: target.ts }),
      },
    },
    frozen: { action: 'react', ref, channelId: target.channelId, ts: target.ts, emoji, teamId, teamUrl },
  };
}

async function prepareUpload(item: UploadItem, index: number, ref: string, scope: PrepareScope): Promise<Prepared> {
  const place = placeOf(item.destination, scope.token);
  const threadTs = reconcileRoots(place.root, threadRootOf(item.thread, scope.token));
  const { destination, warnings } = await describeDestination(
    place.channelId,
    threadTs,
    item.expected_destination,
    scope,
  );
  const inspection = await inspectUploadFile(item.path);
  const name = item.filename ?? inspection.name;
  const mentions = await mentionsIn(item.comment ?? '', scope);
  return {
    preview: {
      index,
      ref,
      action: 'upload',
      destination,
      mentions,
      warnings: [...warnings, ...mentionWarnings(mentions)],
      file: { ...inspection, name },
      comment_preview: item.comment,
    },
    frozen: {
      action: 'upload',
      ref,
      channelId: place.channelId,
      threadTs,
      teamId: scope.token.team_id,
      resolvedPath: inspection.resolved_path,
      size: inspection.size,
      sha256: inspection.sha256,
      filename: name,
      title: item.title ?? name,
      comment: item.comment,
    },
  };
}

function linkOf(value: string, token: TokenRecord): ResolvedLink {
  const resolution = resolveLink(value);
  if (!resolution.ok) throw itemError(resolution.error.code, resolution.error.message);
  const check = matchesWorkspace(resolution.link, token);
  if (!check.ok) throw itemError(check.error.code, check.error.message);
  return resolution.link;
}

function rootOf(link: ResolvedLink): string | undefined {
  return link.kind === 'message' ? (link.thread_ts ?? link.ts) : undefined;
}

function placeOf(destination: string, token: TokenRecord): Place {
  if (CONVERSATION_ID.test(destination)) return { channelId: destination };
  const link = linkOf(destination, token);
  if (!link.channel_id || (link.kind !== 'conversation' && link.kind !== 'message')) {
    throw itemError('wrong_link_kind', 'Use a conversation or message link; a user or file link cannot be written to.');
  }
  return { channelId: link.channel_id, root: rootOf(link) };
}

function messageTargetOf(
  message: string | { channel: string; ts: string },
  token: TokenRecord,
): { channelId: string; ts: string } {
  if (typeof message !== 'string') return { channelId: message.channel, ts: message.ts };
  const link = linkOf(message, token);
  if (link.kind !== 'message' || !link.channel_id || !link.ts) {
    throw itemError('wrong_link_kind', 'React to a message link, not a conversation, user or file link.');
  }
  return { channelId: link.channel_id, ts: link.ts };
}

function threadRootOf(thread: string | undefined, token: TokenRecord): string | undefined {
  if (thread === undefined || isSlackTs(thread)) return thread;
  const root = rootOf(linkOf(thread, token));
  if (!root) throw itemError('wrong_link_kind', 'thread must be a Slack ts or a message link.');
  return root;
}

function reconcileRoots(fromDestination: string | undefined, fromThread: string | undefined): string | undefined {
  if (fromDestination && fromThread && fromDestination !== fromThread) {
    throw itemError('target_mismatch', 'The thread and the destination link name different threads.');
  }
  return fromDestination ?? fromThread;
}

async function describeDestination(
  channelId: string,
  threadTs: string | undefined,
  expected: string | undefined,
  scope: PrepareScope,
): Promise<{ destination: Destination; warnings: string[] }> {
  const channel = ((await scope.slack.conversationsInfo({ channel: channelId })) as ChannelResponse).channel;
  if (channel.is_archived) {
    throw itemError('channel_archived', 'That conversation is archived, so nothing can be sent to it.');
  }

  const type = conversationTypeOf(channel);
  const participantIds = await participantIdsOf(channelId, channel, type, scope);
  if (expected !== undefined && !(await expectationHolds(expected, channel, type, participantIds, scope))) {
    throw itemError(
      'target_mismatch',
      'The destination does not match expected_destination. Check it and preview again.',
    );
  }

  const destination: Destination = {
    type,
    name: channel.name,
    participants:
      participantIds.length > 0
        ? await Promise.all(participantIds.map(async (id) => participantOf(id, scope)))
        : undefined,
    is_private: channel.is_private,
    is_ext_shared: channel.is_ext_shared,
    is_member: channel.is_member,
    member_count: channel.num_members,
    topic: channel.topic?.value,
    purpose: channel.purpose?.value,
  };
  if (threadTs !== undefined) destination.thread_root = await threadRootPreview(channelId, threadTs, scope);
  return { destination, warnings: channelWarnings(channel) };
}

function conversationTypeOf(channel: SlackChannel): ConversationType {
  if (channel.is_im) return 'im';
  if (channel.is_mpim) return 'mpim';
  return channel.is_private ? 'private_channel' : 'public_channel';
}

async function participantIdsOf(
  channelId: string,
  channel: SlackChannel,
  type: ConversationType,
  scope: PrepareScope,
): Promise<string[]> {
  if (type === 'im') return channel.user ? [channel.user] : [];
  if (type !== 'mpim') return [];
  const { members } = (await scope.slack.conversationsMembers({ channel: channelId })) as MembersResponse;
  return members.filter((member) => member !== scope.token.user_id);
}

async function participantOf(id: string, scope: PrepareScope): Promise<Participant> {
  return { user_id: id, display_name: displayNameOf(await scope.lookupUser(id), id) };
}

async function expectationHolds(
  expected: string,
  channel: SlackChannel,
  type: ConversationType,
  participantIds: string[],
  scope: PrepareScope,
): Promise<boolean> {
  if (type === 'public_channel' || type === 'private_channel') return stripMarker(expected) === channel.name;

  const wanted = expected.split(/[\s,]+/).map(stripMarker).filter(Boolean);
  if (type === 'im') {
    const [partner] = participantIds;
    if (!partner) return false;
    const handle = (await scope.lookupUser(partner)).name;
    return wanted.includes(partner) || (handle !== undefined && wanted.includes(handle));
  }

  const handles = await Promise.all(participantIds.map(async (id) => (await scope.lookupUser(id)).name));
  return sameMembers(wanted, handles);
}

function stripMarker(value: string): string {
  return value.replace(/^[#@]/, '');
}

function sameMembers(wanted: string[], actual: Array<string | undefined>): boolean {
  const wantedSet = new Set(wanted);
  return wantedSet.size === actual.length && actual.every((handle) => handle !== undefined && wantedSet.has(handle));
}

async function threadRootPreview(
  channelId: string,
  ts: string,
  scope: PrepareScope,
): Promise<NonNullable<Destination['thread_root']>> {
  const replies = { channel: channelId, ts, limit: 1 };
  const { messages } = (await scope.slack.conversationsReplies(replies)) as RepliesResponse;
  const [root] = messages;
  if (!root) throw itemError('thread_not_found', 'The thread root does not exist in that conversation.');
  return {
    ts: root.ts,
    author_name: root.user ? displayNameOf(await scope.lookupUser(root.user), root.user) : undefined,
    first_line: cleanText(root.text?.split('\n')[0]),
  };
}

function channelWarnings(channel: SlackChannel): string[] {
  return [
    ...(channel.is_ext_shared ? ['slack_connect'] : []),
    ...(channel.is_member === false ? ['not_a_member'] : []),
  ];
}

function mentionWarnings(mentions: Mention[]): string[] {
  return mentions.some((mention) => mention.kind === 'broadcast') ? ['broadcast_mention'] : [];
}

async function mentionsIn(text: string, scope: PrepareScope): Promise<Mention[]> {
  const mentions: Mention[] = [];
  for (const [, id] of text.matchAll(USER_MENTION)) {
    mentions.push({ kind: 'user', id, display_name: displayNameOf(await scope.lookupUser(id), id) });
  }
  for (const [, id, label] of text.matchAll(USERGROUP_MENTION)) {
    mentions.push({ kind: 'usergroup', id, display_name: label ?? id });
  }
  for (const [, keyword] of text.matchAll(BROADCAST_MENTION)) {
    mentions.push({ kind: 'broadcast', id: keyword, display_name: `@${keyword}` });
  }
  return mentions;
}

function displayNameOf(user: SlackUser, fallback: string): string {
  return user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || fallback;
}

async function sendWrite(
  slack: SlackClient,
  write: FrozenWrite,
  index: number,
  connectedTeamId: string,
): Promise<WriteResult> {
  const base = { index, ref: write.ref, action: write.action, channel_id: write.channelId };
  if (write.teamId !== connectedTeamId) {
    return { ...base, status: 'error', error: { code: 'workspace_changed', message: WORKSPACE_CHANGED_MESSAGE } };
  }
  try {
    return { ...base, status: 'ok', ...(await perform(slack, write)) };
  } catch (error) {
    return { ...base, status: 'error', error: toItemError(error) };
  }
}

async function perform(slack: SlackClient, write: FrozenWrite): Promise<Sent> {
  switch (write.action) {
    case 'post': {
      const response = await slack.postMessage({
        channel: write.channelId,
        text: write.text,
        thread_ts: write.threadTs,
        reply_broadcast: write.replyBroadcast,
        link_names: false,
      });
      const ts = response.ts as string;
      return { ts, permalink: buildPermalink({ teamUrl: write.teamUrl, channelId: write.channelId, ts }) };
    }
    case 'react': {
      await slack.addReaction({ channel: write.channelId, timestamp: write.ts, name: write.emoji });
      return {
        ts: write.ts,
        permalink: buildPermalink({ teamUrl: write.teamUrl, channelId: write.channelId, ts: write.ts }),
      };
    }
    case 'upload':
      return uploadFile(slack, write);
  }
}

async function uploadFile(slack: SlackClient, write: Extract<FrozenWrite, { action: 'upload' }>): Promise<Sent> {
  await assertUnchanged(write);
  const { upload_url, file_id } = await atStep('get_upload_url', () =>
    slack.getUploadUrl({ filename: write.filename, length: write.size }),
  );

  const { stream, sha256 } = await openHashedStream(write.resolvedPath);
  await atStep('send_bytes', () => slack.sendUploadBytes(upload_url, stream, write.size));
  if ((await sha256) !== write.sha256) {
    throw itemError('file_changed', 'The file changed after the preview, so the upload was not completed.');
  }

  const completed = (await atStep('complete_upload', () =>
    slack.completeUpload({
      files: [{ id: file_id, title: write.title }],
      channel_id: write.channelId,
      thread_ts: write.threadTs,
      initial_comment: write.comment,
    }),
  )) as CompletedUploadResponse;
  return { file_id, permalink: completed.files?.[0]?.permalink };
}

async function assertUnchanged(write: Extract<FrozenWrite, { action: 'upload' }>): Promise<void> {
  const current = await stat(write.resolvedPath).catch(() => undefined);
  if (!current?.isFile() || current.size !== write.size) {
    throw itemError('file_changed', 'The file changed or went missing after the preview, so nothing was uploaded.');
  }
}

async function atStep<T>(step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw uploadRejected(step, error);
  }
}

function uploadRejected(step: string, error: unknown): Error {
  const failure = toItemError(error);
  return Object.assign(new Error(failure.message), { ...failure, code: 'upload_rejected', step });
}
