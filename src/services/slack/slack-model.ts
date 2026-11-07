const SLACK_TS_PATTERN = /^\d{10}\.\d{6}$/;
const FILE_ID_PATTERN = /^F[A-Z0-9]+$/;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const MILLISECONDS_PER_SECOND = 1000;
const MICROSECONDS_PER_MILLISECOND = 1000;
const SLACK_TS_FRACTION_DIGITS = 6;

export interface RawMessage {
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  user?: string;
  bot_id?: string;
  text?: string;
  files?: unknown;
}

export interface MessageContext {
  channelId: string;
  teamUrl: string;
  fields?: string[];
}

export interface ShapedMessage {
  channel_id: string;
  ts: string;
  thread_ts: string;
  is_top_level: boolean;
  reply_count: number;
  author_id: string | null;
  is_bot: boolean;
  hasAttachments: boolean;
  attachments?: ShapedAttachment[];
  at: string;
  permalink: string;
  text?: string;
  mrkdwn?: string;
}

interface ShapedAttachment {
  file_id: string;
  name?: string;
  size?: number;
  type?: string;
}

export function isSlackTs(value: string): boolean {
  return SLACK_TS_PATTERN.test(value);
}

export function slackTsToIso(ts: string): string {
  const [seconds, fraction = '0'] = ts.split('.');
  const milliseconds = Math.floor(Number(fraction) / MICROSECONDS_PER_MILLISECOND);
  return new Date(Number(seconds) * MILLISECONDS_PER_SECOND + milliseconds).toISOString();
}

export function toSlackTs(value: string): string {
  if (isSlackTs(value)) return value;

  const epochMs = ISO_INSTANT_PATTERN.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(epochMs)) {
    throw Object.assign(new Error('Expected a Slack ts or an ISO 8601 time with a time zone.'), {
      code: 'invalid_timestamp',
    });
  }

  const seconds = Math.floor(epochMs / MILLISECONDS_PER_SECOND);
  const fraction = (epochMs - seconds * MILLISECONDS_PER_SECOND) * MICROSECONDS_PER_MILLISECOND;
  return `${seconds}.${String(fraction).padStart(SLACK_TS_FRACTION_DIGITS, '0')}`;
}

export function buildPermalink({ teamUrl, channelId, ts }: { teamUrl: string; channelId: string; ts: string }): string {
  const archiveBase = teamUrl.replace(/\/+$/, '');
  return `${archiveBase}/archives/${channelId}/p${toSlackTs(ts).replace('.', '')}`;
}

export function cleanText(text: string | undefined): string {
  const plain = (text ?? '')
    .replace(/<@([^>|]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label ?? id}`)
    .replace(/<#([^>|]+)(?:\|([^>]+))?>/g, (_, id, label) => `#${label ?? id}`)
    .replace(/<!(channel|here|everyone)(?:\|[^>]+)?>/g, '@$1')
    .replace(/<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g, (_, url, label) => label ?? url)
    // Emphasis and code markers are dropped so the plain form reads as prose rather than showing raw asterisks.
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
  return decodeEntities(plain).replace(/\s+/g, ' ').trim();
}

export function shapeMessage(raw: RawMessage, { channelId, teamUrl, fields = [] }: MessageContext): ShapedMessage {
  const threadTs = raw.thread_ts ?? raw.ts;
  const shaped: ShapedMessage = {
    channel_id: channelId,
    ts: raw.ts,
    thread_ts: threadTs,
    is_top_level: threadTs === raw.ts,
    reply_count: raw.reply_count ?? 0,
    author_id: raw.user ?? null,
    is_bot: Boolean(raw.bot_id),
    ...shapeFileAttachments(raw.files),
    at: slackTsToIso(raw.ts),
    permalink: buildPermalink({ teamUrl, channelId, ts: raw.ts }),
  };
  if (fields.includes('text')) shaped.text = cleanText(raw.text);
  if (fields.includes('mrkdwn')) shaped.mrkdwn = raw.text ?? '';
  return shaped;
}

function shapeFileAttachments(files: unknown): Pick<ShapedMessage, 'hasAttachments' | 'attachments'> {
  if (!Array.isArray(files)) return { hasAttachments: false };

  let hasAttachments = false;
  const attachments: ShapedAttachment[] = [];
  for (const value of files) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    hasAttachments = true;
    const file = value as Record<string, unknown>;
    if (typeof file.id !== 'string' || !FILE_ID_PATTERN.test(file.id)) continue;

    const attachment: ShapedAttachment = { file_id: file.id };
    if (typeof file.name === 'string' && file.name.length > 0) attachment.name = file.name;
    if (typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0) attachment.size = file.size;
    if (typeof file.mimetype === 'string' && file.mimetype.length > 0) attachment.type = file.mimetype;
    attachments.push(attachment);
  }
  return attachments.length > 0 ? { hasAttachments, attachments } : { hasAttachments };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
