import { z } from 'zod';
import { zodToJsonSchema } from '../helpers.js';
import type { ToolDescriptor } from '../index.js';
import { slackConfirmWriteSchema, slackPrepareWriteSchema } from './write-tools.js';

const refField = z
  .string()
  .max(64)
  .optional()
  .describe('Caller reference, 64 characters or fewer, echoed in the result.');
const cursorField = z
  .string()
  .optional()
  .describe("nextPageToken from this item's previous result; send {cursor} alone to continue that target.");
const idOrLink = z.string().min(1);
const time = z.string().min(1);
const slackRef = z.object({ channel: z.string().min(1), ts: z.string().min(1) });
const linkOrRef = z.union([z.string().min(1), slackRef]);

// zodToJsonSchema flattens unions to a string, so the JSON for a link-or-{channel, ts} field is written out.
const LINK_OR_REF_JSON = {
  anyOf: [
    { type: 'string' },
    { type: 'object', properties: { channel: { type: 'string' }, ts: { type: 'string' } }, required: ['channel', 'ts'] },
  ],
};

const MESSAGE_FIELDS = 'text, mrkdwn, author_name, reactions, channel_name';

const messageFieldsField = z
  .array(z.string())
  .optional()
  .describe(
    `Extra fields per message: ${MESSAGE_FIELDS}. Text and author names are opt-in; hasAttachments and available attachments metadata are returned by default.`,
  );
const limitField = z
  .number()
  .int()
  .min(1)
  .max(100)
  .optional()
  .describe('Items per page for each target (default 20, max 100).');
const maxTextCharsField = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('Longest text kept per message, in characters (default 300).');

const searchQuery = z.object({
  ref: refField,
  cursor: cursorField,
  query: z.string().max(500).optional().describe('Words to search for, 500 characters or fewer.'),
  exact_phrases: z.array(z.string()).optional().describe('Phrases matched exactly; each is quoted.'),
  in_channels: z.array(idOrLink).optional().describe('Channels to search in: ids or Slack links.'),
  from_users: z.array(idOrLink).optional().describe('Authors to match: user ids or profile links.'),
  after: time.optional().describe('Inclusive lower bound: ISO 8601 with an offset or Z, or a Slack ts.'),
  before: time.optional().describe('Exclusive upper bound, in the same formats as after.'),
  top_level_only: z.boolean().optional().describe('Skip thread replies.'),
  include_bots: z.boolean().optional().describe('Keep bot messages, which are dropped by default.'),
});

const messageItem = z.object({
  ref: refField,
  cursor: cursorField,
  message: linkOrRef.optional().describe('One message: a message link, or {channel, ts}.'),
  channel: idOrLink.optional().describe('History of a channel or DM: its id or Slack link.'),
  after: time.optional().describe('History: inclusive lower bound, ISO 8601 or a Slack ts.'),
  before: time.optional().describe('History: exclusive upper bound, ISO 8601 or a Slack ts.'),
  top_level_only: z.boolean().optional().describe('History: skip thread replies.'),
});

const threadItem = z.object({
  ref: refField,
  cursor: cursorField,
  thread: linkOrRef
    .optional()
    .describe('A message, reply or thread link, or {channel, ts}; a reply resolves to its root.'),
});

const channelItem = z.object({
  ref: refField,
  cursor: cursorField,
  channel: idOrLink.optional().describe('A channel, DM or group DM: its id or Slack link.'),
  name: z.string().min(1).optional().describe('Exact channel name, or a prefix ending in *.'),
  member_only: z.boolean().optional().describe('The channels you are a member of.'),
  types: z
    .array(z.string())
    .optional()
    .describe('Conversation types for name and member_only lookups: public_channel, private_channel, im, mpim.'),
  include_archived: z.boolean().optional().describe('Include archived channels.'),
});

const userItem = z.object({
  ref: refField,
  cursor: cursorField,
  user: idOrLink.optional().describe('A user id or profile link.'),
  me: z.boolean().optional().describe('The signed-in user.'),
  query: z.string().min(1).optional().describe('Match on display or real name only, never on email.'),
  members_of: idOrLink.optional().describe('Members of a DM or channel: its id or Slack link.'),
});

export const slackLoginSchema = z.object({
  workspace: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Workspace to sign in to: a team id, domain, host or URL.'),
  redirected_url: z
    .string()
    .min(1)
    .max(4096)
    .optional()
    .describe('Paste route: the address the browser landed on after approving, or a bare code.'),
});

export const slackLogoutSchema = z.object({
  revoke: z.boolean().optional().describe('Revoke the token at Slack before removing it (default true).'),
});

export const slackGetStatusSchema = z.object({
  verify: z
    .boolean()
    .optional()
    .describe('Check the token with Slack, cached for 60 seconds (default true); false makes no network call.'),
});

export const slackSearchMessagesSchema = z.object({
  queries: z.array(searchQuery).min(1).describe('1 to 5 searches, each with query, exact_phrases or in_channels.'),
  fields: messageFieldsField,
  limit: limitField,
  max_text_chars: maxTextCharsField,
});

export const slackGetMessagesSchema = z.object({
  messages: z.array(messageItem).min(1).describe('1 to 20 items: one message, or the history of a channel.'),
  fields: messageFieldsField,
  limit: limitField,
  max_text_chars: maxTextCharsField,
});

export const slackGetThreadsSchema = z.object({
  threads: z.array(threadItem).min(1).describe('1 to 20 threads, each given by a message, reply or thread link.'),
  fields: messageFieldsField,
  limit: limitField,
  max_text_chars: maxTextCharsField,
});

export const slackGetChannelsSchema = z.object({
  channels: z.array(channelItem).min(1).describe('1 to 20 items: a channel, a name, or member_only.'),
  limit: limitField,
});

export const slackGetUsersSchema = z.object({
  users: z.array(userItem).min(1).describe('1 to 100 user ids, or 1 to 20 items of any other kind.'),
  fields: z
    .array(z.string())
    .optional()
    .describe('Extra fields per user: real_name, title, tz, or email (email only when listed here).'),
  limit: limitField,
});

export const slackDownloadFileSchema = z.object({
  file: z.string().min(1).describe('A file id (starts with F) or a file link of the connected workspace.'),
  path: z.string().min(1).describe('Absolute path to save the file at; its directory must already exist.'),
  overwrite: z.boolean().optional().describe('Replace an existing regular file at path (default false).'),
});

// zodToJsonSchema reports an array as an array of bare objects; each batch item's own properties are restored here.
function batchTool(schema: z.AnyZodObject, batchKey: string, items: Record<string, unknown>) {
  const json = zodToJsonSchema(schema);
  const properties = json.properties as Record<string, Record<string, unknown>>;
  properties[batchKey] = { ...properties[batchKey], minItems: 1, items };
  return json;
}

function itemJson(item: z.AnyZodObject, overrides: Record<string, unknown> = {}) {
  const json = zodToJsonSchema(item);
  return { ...json, properties: { ...(json.properties as Record<string, unknown>), ...overrides } };
}

// zodToJsonSchema cannot express the discriminated union of write actions, so the item shape is written out.
const WRITE_ITEM_JSON = {
  type: 'object',
  description: 'One write, sent only after its preview is confirmed. Every item may add ref and expected_destination.',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['post', 'react', 'upload'], description: 'The write to make.' },
    ref: { type: 'string', maxLength: 64, description: 'Caller reference, echoed in the preview and the result.' },
    destination: {
      type: 'string',
      description: 'post and upload: a conversation id (C, G or D) or a Slack link. A message or thread link replies in that thread.',
    },
    expected_destination: {
      type: 'string',
      description: 'Required with a destination id: the channel name, the DM partner id or handle, or the other members\' handles for a group DM.',
    },
    text: { type: 'string', maxLength: 40000, description: 'post: message text, sent with link_names off.' },
    thread: { type: 'string', description: 'post and upload: a Slack ts or a message link to reply in.' },
    reply_broadcast: { type: 'boolean', description: 'post: also show the reply in the channel.' },
    message: { ...LINK_OR_REF_JSON, description: 'react: a message link, or {channel, ts}.' },
    emoji: { type: 'string', description: 'react: emoji name, with or without colons.' },
    path: { type: 'string', description: 'upload: absolute path of the file; a symlink is followed and shown.' },
    filename: { type: 'string', description: 'upload: file name in Slack (default: the file name).' },
    title: { type: 'string', description: 'upload: file title (default: the file name).' },
    comment: { type: 'string', maxLength: 40000, description: 'upload: initial comment posted with the file.' },
  },
};

export const slackToolDescriptors: ToolDescriptor[] = [
  {
    name: 'slack_login',
    description:
      'Connect Slack. If dev-dashboard has captured a web session (~/.config/slack/session.json), this adopts it and verifies against Slack; otherwise it returns an authorize_url to open in your own browser, and on the paste route call again with redirected_url to finish.',
    inputSchema: zodToJsonSchema(slackLoginSchema),
  },
  {
    name: 'slack_logout',
    description:
      'Disconnect Slack: revokes an app token at Slack when it can, then removes the stored login; revoke:false removes it without calling Slack. A session adopted from dev-dashboard is only removed here, never revoked, and the captured file is left untouched.',
    inputSchema: zodToJsonSchema(slackLogoutSchema),
  },
  {
    name: 'slack_get_status',
    description:
      'Report the Slack connection state (not_connected, pending, connected, expired or unverified) with the next step, and whether a dev-dashboard session is available to adopt; verify:false skips the Slack check.',
    inputSchema: zodToJsonSchema(slackGetStatusSchema),
  },
  {
    name: 'slack_search_messages',
    description:
      'Search Slack messages for 1 to 5 queries in one call, newest first; in_channels and from_users take ids or Slack links; send {cursor} items with nextPageToken to continue; text appears only when fields asks for it; hasAttachments is default; available attachments metadata includes file_id for slack_download_file.',
    inputSchema: batchTool(slackSearchMessagesSchema, 'queries', itemJson(searchQuery)),
  },
  {
    name: 'slack_get_messages',
    description:
      'Read 1 to 20 messages: {message} takes a message link or {channel, ts}, and {channel} reads that channel history, given as an id or link; page with nextPageToken as {cursor} items; text and author names appear only when fields asks for them; hasAttachments is default; available attachments metadata includes file_id for slack_download_file.',
    inputSchema: batchTool(
      slackGetMessagesSchema,
      'messages',
      itemJson(messageItem, {
        message: { ...LINK_OR_REF_JSON, description: 'One message: a message link, or {channel, ts}.' },
      }),
    ),
  },
  {
    name: 'slack_get_threads',
    description:
      'Read 1 to 20 threads, each given by a message, reply or thread link (or {channel, ts}); a reply resolves to its root, which appears once, oldest first; page with nextPageToken as {cursor} items; text appears only when fields asks for it; hasAttachments is default; available attachments metadata includes file_id for slack_download_file.',
    inputSchema: batchTool(
      slackGetThreadsSchema,
      'threads',
      itemJson(threadItem, {
        thread: {
          ...LINK_OR_REF_JSON,
          description: 'A message, reply or thread link, or {channel, ts}; a reply resolves to its root.',
        },
      }),
    ),
  },
  {
    name: 'slack_get_channels',
    description:
      'Look up 1 to 20 channels by id or link, by exact name or a prefix ending in *, or with member_only; each has type (public_channel, private_channel, im or mpim), topic and purpose; page with nextPageToken as {cursor} items.',
    inputSchema: batchTool(slackGetChannelsSchema, 'channels', itemJson(channelItem)),
  },
  {
    name: 'slack_get_users',
    description:
      'Look up 1 to 100 users by id or profile link, or 1 to 20 items by {query} on names, {members_of} (a DM or channel link) or {me:true}; fields may add real_name, title, tz or email, and email only when listed; page with nextPageToken as {cursor} items; phone is never returned.',
    inputSchema: batchTool(slackGetUsersSchema, 'users', itemJson(userItem)),
  },
  {
    name: 'slack_download_file',
    description:
      'Download one Slack file, given its id or a Slack file link, to an absolute path you choose and return only its path, name, size, type and sha256; an existing file is replaced only with overwrite:true, no file content is returned, and an app login needs the files:read scope.',
    inputSchema: zodToJsonSchema(slackDownloadFileSchema),
  },
  {
    name: 'slack_prepare_write',
    description:
      'Preview 1 to 10 Slack writes (post, react or upload) without sending anything, showing each resolved destination, text or file path, thread and mentions, and return one confirmation_token; show the user every item, check the channel topic and purpose when they did not name the destination, and call slack_confirm_write only after a yes to that exact preview.',
    inputSchema: batchTool(slackPrepareWriteSchema, 'items', WRITE_ITEM_JSON),
  },
  {
    name: 'slack_confirm_write',
    description:
      'Send the exact items frozen under one confirmation_token from slack_prepare_write, once and in input order; call it only after the user approves that preview, and a repeat call returns the stored results with already_sent:true.',
    inputSchema: zodToJsonSchema(slackConfirmWriteSchema),
  },
];
