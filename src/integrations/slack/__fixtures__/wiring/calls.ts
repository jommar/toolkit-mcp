import { EXAMPLE, channelLink, messageLink } from './sentinels.js';

export interface ToolCall {
  label: string;
  tool: string;
  args: Record<string, unknown>;
}

export const READ_CALLS: ToolCall[] = [
  { label: 'search by query', tool: 'slack_search_messages', args: { queries: [{ query: 'EXAMPLE' }] } },
  { label: 'history of a channel', tool: 'slack_get_messages', args: { messages: [{ channel: EXAMPLE.channelId }] } },
  {
    label: 'thread by link',
    tool: 'slack_get_threads',
    args: { threads: [{ thread: messageLink(EXAMPLE.channelId, EXAMPLE.rootTs) }] },
  },
  {
    label: 'channel and direct message',
    tool: 'slack_get_channels',
    args: { channels: [{ channel: EXAMPLE.channelId }, { channel: EXAMPLE.dmId }] },
  },
  {
    label: 'users by id',
    tool: 'slack_get_users',
    args: { users: [{ user: EXAMPLE.peerId }, { user: EXAMPLE.meId }] },
  },
  { label: 'members of a direct message', tool: 'slack_get_users', args: { users: [{ members_of: EXAMPLE.dmId }] } },
];

export function postItem(text: string): Record<string, unknown> {
  return { action: 'post', destination: channelLink(), text };
}

export function reactItem(): Record<string, unknown> {
  return { action: 'react', message: messageLink(EXAMPLE.channelId, EXAMPLE.rootTs), emoji: 'thumbsup' };
}

export function uploadItem(path: string, comment?: string): Record<string, unknown> {
  return { action: 'upload', destination: channelLink(), path, ...(comment ? { comment } : {}) };
}
