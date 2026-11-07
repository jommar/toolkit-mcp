import { Readable } from 'node:stream';
import { vi } from 'vitest';
import {
  ALL_USER_SCOPES,
  AUTH_CODE_SENTINEL,
  EXAMPLE,
  FILE_BYTES_SENTINEL,
  FIXTURE_EMAIL,
  FIXTURE_EMAIL_SELF,
  MESSAGE_BODY_SENTINEL,
  PHONE_SENTINEL,
  REAL_NAME_SENTINEL,
  TITLE_SENTINEL,
  TOKEN_SENTINEL,
  messageLink,
} from './sentinels.js';

type AxiosModule = typeof import('axios');
type AxiosErrorConstructor = AxiosModule['AxiosError'];

export interface RecordedRequest {
  httpMethod: string;
  url: string;
  host: string;
  path: string;
  apiMethod: string | undefined;
  headers: Record<string, string>;
  body: string;
  bodyWasStream: boolean;
}

export type SlackFields = Record<string, string | undefined>;

export type Reply =
  | { data: unknown; status?: number; headers?: Record<string, string> }
  | { networkError: string };

export type Handler = (fields: SlackFields, request: RecordedRequest) => Reply;

const SLACK_API_HOSTS = new Set(['slack.com', 'app.slack.com']);
export const FAKE_FILE_HOSTS: readonly string[] = ['files.slack.com', 'files-origin.slack.com'];
const UPLOAD_HANDLER_KEY = 'upload-host';
const FILE_HANDLER_KEY = 'file-host';

/** The name Slack holds for the example file; a download must never carry it into a result. */
export const SLACK_SIDE_FILE_NAME = 'EXAMPLE-slack-side-name.txt';

function slackOk(extra: Record<string, unknown> = {}): Reply {
  return { data: { ok: true, ...extra } };
}

function slackError(error: string): Reply {
  return { data: { ok: false, error } };
}

const emptyCursor = { next_cursor: '' };

function userRecord(id: string): Record<string, unknown> | undefined {
  if (id === EXAMPLE.peerId) {
    return {
      id,
      team_id: EXAMPLE.teamId,
      name: EXAMPLE.peerHandle,
      deleted: false,
      real_name: REAL_NAME_SENTINEL,
      tz: 'UTC',
      is_bot: false,
      profile: {
        display_name: EXAMPLE.peerHandle,
        real_name: REAL_NAME_SENTINEL,
        title: TITLE_SENTINEL,
        email: FIXTURE_EMAIL,
        phone: PHONE_SENTINEL,
      },
    };
  }
  if (id === EXAMPLE.meId) {
    return {
      id,
      team_id: EXAMPLE.teamId,
      name: EXAMPLE.meHandle,
      deleted: false,
      real_name: REAL_NAME_SENTINEL,
      tz: 'UTC',
      is_bot: false,
      profile: {
        display_name: EXAMPLE.meHandle,
        real_name: REAL_NAME_SENTINEL,
        title: TITLE_SENTINEL,
        email: FIXTURE_EMAIL_SELF,
        phone: PHONE_SENTINEL,
      },
    };
  }
  return undefined;
}

function conversationRecord(id: string): Record<string, unknown> | undefined {
  const shared = {
    is_archived: false,
    is_ext_shared: false,
    is_shared: false,
    is_org_shared: false,
    is_member: true,
    num_members: 2,
    created: 1700000000,
  };
  if (id === EXAMPLE.channelId) {
    return {
      id,
      name: EXAMPLE.channelName,
      is_channel: true,
      is_group: false,
      is_im: false,
      is_mpim: false,
      is_private: false,
      topic: { value: 'EXAMPLE-TOPIC', creator: '', last_set: 0 },
      purpose: { value: 'EXAMPLE-PURPOSE', creator: '', last_set: 0 },
      ...shared,
    };
  }
  if (id === EXAMPLE.dmId) {
    return {
      id,
      is_channel: false,
      is_group: false,
      is_im: true,
      is_mpim: false,
      is_private: true,
      user: EXAMPLE.peerId,
      is_user_deleted: false,
      ...shared,
    };
  }
  return undefined;
}

const topLevelMessages = [
  { type: 'message', user: EXAMPLE.peerId, text: `${MESSAGE_BODY_SENTINEL}-3`, ts: EXAMPLE.laterTs },
  {
    type: 'message',
    user: EXAMPLE.peerId,
    text: `${MESSAGE_BODY_SENTINEL}-1`,
    ts: EXAMPLE.rootTs,
    thread_ts: EXAMPLE.rootTs,
    reply_count: 1,
    reply_users_count: 1,
    latest_reply: EXAMPLE.replyTs,
  },
];

const threadReply = {
  type: 'message',
  user: EXAMPLE.meId,
  text: `${MESSAGE_BODY_SENTINEL}-2`,
  ts: EXAMPLE.replyTs,
  thread_ts: EXAMPLE.rootTs,
};

function historyHandler(fields: SlackFields): Reply {
  if (!conversationRecord(fields.channel ?? '')) return slackError('channel_not_found');
  const oldest = Number(fields.oldest ?? 0);
  const latest = fields.latest === undefined ? Infinity : Number(fields.latest);
  const inclusive = fields.inclusive === 'true' || fields.inclusive === '1';
  const inRange = topLevelMessages.filter((message) => {
    const ts = Number(message.ts);
    const afterOldest = inclusive ? ts >= oldest : ts > oldest;
    const beforeLatest = inclusive ? ts <= latest : ts < latest;
    return afterOldest && beforeLatest;
  });
  return slackOk({ messages: inRange, has_more: false, response_metadata: emptyCursor });
}

function repliesHandler(fields: SlackFields): Reply {
  if (!conversationRecord(fields.channel ?? '')) return slackError('channel_not_found');
  if (fields.ts !== EXAMPLE.rootTs) return slackError('thread_not_found');
  return slackOk({ messages: [topLevelMessages[1], threadReply], has_more: false, response_metadata: emptyCursor });
}

function searchHandler(fields: SlackFields): Reply {
  const matches = topLevelMessages.map((message, index) => ({
    iid: `EXAMPLE-IID-${index + 1}`,
    team: EXAMPLE.teamId,
    channel: { id: EXAMPLE.channelId, name: EXAMPLE.channelName, is_channel: true, is_private: false },
    type: 'message',
    user: message.user,
    username: EXAMPLE.peerHandle,
    ts: message.ts,
    text: message.text,
    permalink: messageLink(EXAMPLE.channelId, message.ts),
  }));
  return slackOk({
    query: fields.query ?? '',
    messages: {
      total: matches.length,
      pagination: { total_count: matches.length, page: 1, per_page: 20, page_count: 1, first: 1, last: matches.length },
      paging: { count: 20, total: matches.length, page: 1, pages: 1 },
      matches,
    },
    response_metadata: emptyCursor,
  });
}

function oauthExchangeHandler(fields: SlackFields): Reply {
  if (fields.code !== AUTH_CODE_SENTINEL) return slackError('invalid_code');
  return slackOk({
    app_id: 'A0EXAMPLE01',
    authed_user: {
      id: EXAMPLE.meId,
      scope: ALL_USER_SCOPES.join(','),
      token_type: 'user',
      access_token: TOKEN_SENTINEL,
    },
    team: { id: EXAMPLE.teamId, name: 'Example Team' },
    enterprise: null,
    is_enterprise_install: false,
  });
}

function uploadHostHandler(_fields: SlackFields, request: RecordedRequest): Reply {
  const length = request.headers['content-length'] ?? String(Buffer.byteLength(request.body));
  return { data: `OK - ${length}`, status: 200 };
}

/** A response body that hands out the chunks one per read and then ends, as a streamed download does. */
export function streamOf(...chunks: Buffer[]): Readable {
  const queue = [...chunks];
  return new Readable({
    read() {
      this.push(queue.shift() ?? null);
    },
  });
}

/** A response body that hands out one chunk and then fails with `error`. */
export function streamFailingAfter(first: Buffer, error: Error): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(first);
        return;
      }
      setTimeout(() => this.destroy(error), 5);
    },
  });
}

/** The `file` object `files.info` answers for the example file: hosted, with the size of the default bytes. */
export function hostedFileObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: EXAMPLE.fileId,
    name: SLACK_SIDE_FILE_NAME,
    title: TITLE_SENTINEL,
    mimetype: 'text/plain',
    filetype: 'text',
    size: Buffer.byteLength(FILE_BYTES_SENTINEL),
    mode: 'hosted',
    is_external: false,
    url_private: EXAMPLE.fileUrl,
    url_private_download: EXAMPLE.fileUrl,
    ...overrides,
  };
}

function fileHostHandler(): Reply {
  return {
    data: streamOf(Buffer.from(FILE_BYTES_SENTINEL)),
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  };
}

export function defaultHandlers(): Record<string, Handler> {
  return {
    'oauth.v2.access': oauthExchangeHandler,
    'auth.test': () =>
      slackOk({
        url: EXAMPLE.teamUrl,
        team: 'Example Team',
        user: EXAMPLE.meHandle,
        team_id: EXAMPLE.teamId,
        user_id: EXAMPLE.meId,
      }),
    'auth.revoke': () => slackOk({ revoked: true }),
    'conversations.info': (fields) => {
      const channel = conversationRecord(fields.channel ?? '');
      return channel ? slackOk({ channel }) : slackError('channel_not_found');
    },
    'conversations.history': historyHandler,
    'conversations.replies': repliesHandler,
    'conversations.members': () => slackOk({ members: [EXAMPLE.meId, EXAMPLE.peerId], response_metadata: emptyCursor }),
    'conversations.list': () =>
      slackOk({ channels: [conversationRecord(EXAMPLE.channelId)], response_metadata: emptyCursor }),
    'users.conversations': () =>
      slackOk({ channels: [conversationRecord(EXAMPLE.channelId)], response_metadata: emptyCursor }),
    'users.info': (fields) => {
      const user = userRecord(fields.user ?? '');
      return user ? slackOk({ user }) : slackError('user_not_found');
    },
    'users.list': () =>
      slackOk({
        members: [userRecord(EXAMPLE.meId), userRecord(EXAMPLE.peerId)],
        response_metadata: emptyCursor,
      }),
    'search.messages': searchHandler,
    'chat.postMessage': (fields) =>
      slackOk({
        channel: fields.channel,
        ts: EXAMPLE.postedTs,
        message: { type: 'message', user: EXAMPLE.meId, text: fields.text, ts: EXAMPLE.postedTs },
      }),
    'reactions.add': () => slackOk(),
    'files.info': (fields) =>
      fields.file === EXAMPLE.fileId ? slackOk({ file: hostedFileObject() }) : slackError('file_not_found'),
    'files.getUploadURLExternal': () => slackOk({ upload_url: EXAMPLE.uploadUrl, file_id: EXAMPLE.fileId }),
    'files.completeUploadExternal': () =>
      slackOk({
        files: [
          {
            id: EXAMPLE.fileId,
            title: 'example',
            permalink: `https://${EXAMPLE.teamHost}/files/${EXAMPLE.meId}/${EXAMPLE.fileId}/example.txt`,
          },
        ],
      }),
    [UPLOAD_HANDLER_KEY]: uploadHostHandler,
    [FILE_HANDLER_KEY]: fileHostHandler,
  };
}

interface CallConfig {
  url?: string;
  baseURL?: string;
  method?: string;
  headers?: unknown;
  data?: unknown;
  params?: Record<string, unknown>;
  auth?: { username?: string; password?: string };
}

function flattenHeaders(source: unknown): Record<string, string> {
  if (!source || typeof source !== 'object') return {};
  const maybeSerializable = source as { toJSON?: () => unknown };
  const plain = (typeof maybeSerializable.toJSON === 'function' ? maybeSerializable.toJSON() : source) as Record<
    string,
    unknown
  >;
  const flat: Record<string, string> = { ...flattenHeaders(plain.common) };
  for (const [name, value] of Object.entries(plain)) {
    if (value === undefined || value === null || typeof value === 'object') continue;
    flat[name.toLowerCase()] = String(value);
  }
  return flat;
}

function isReadableStream(value: unknown): value is AsyncIterable<Uint8Array | string> {
  return !!value && typeof value === 'object' && typeof (value as { pipe?: unknown }).pipe === 'function';
}

async function serializeBody(data: unknown): Promise<{ text: string; wasStream: boolean }> {
  if (data === undefined || data === null) return { text: '', wasStream: false };
  if (typeof data === 'string') return { text: data, wasStream: false };
  if (data instanceof URLSearchParams) return { text: data.toString(), wasStream: false };
  if (data instanceof Uint8Array) return { text: Buffer.from(data).toString('utf8'), wasStream: false };
  if (isReadableStream(data)) {
    const chunks: Buffer[] = [];
    for await (const chunk of data) chunks.push(Buffer.from(chunk));
    return { text: Buffer.concat(chunks).toString('utf8'), wasStream: true };
  }
  return { text: JSON.stringify(data), wasStream: false };
}

function absoluteUrl(config: CallConfig, defaults: CallConfig): string {
  const url = config.url ?? '';
  const base = config.baseURL ?? defaults.baseURL ?? '';
  const joined = /^https?:\/\//i.test(url) ? url : `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
  if (!config.params) return joined;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(config.params)) {
    if (value !== undefined && value !== null) query.set(name, String(value));
  }
  const text = query.toString();
  if (!text) return joined;
  return `${joined}${joined.includes('?') ? '&' : '?'}${text}`;
}

function parseFields(request: RecordedRequest): SlackFields {
  const fields: SlackFields = {};
  const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?') + 1) : '';
  for (const [name, value] of new URLSearchParams(query)) fields[name] = value;
  const trimmed = request.body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      for (const [name, value] of Object.entries(parsed)) {
        fields[name] = typeof value === 'string' ? value : JSON.stringify(value);
      }
    } catch {
      return fields;
    }
  } else if (request.headers['content-type']?.includes('x-www-form-urlencoded') || trimmed.includes('=')) {
    for (const [name, value] of new URLSearchParams(request.body)) fields[name] = value;
  }
  return fields;
}

export class FakeSlackApi {
  requests: RecordedRequest[] = [];

  private handlers: Record<string, Handler> = defaultHandlers();

  reset(): void {
    this.requests = [];
    this.handlers = defaultHandlers();
    vi.stubGlobal('fetch', () => {
      throw new Error('the global fetch is blocked in offline tests');
    });
  }

  resetHandlers(): void {
    this.handlers = defaultHandlers();
  }

  onMethod(apiMethod: string, handler: Handler): void {
    this.handlers[apiMethod] = handler;
  }

  onUpload(handler: Handler): void {
    this.handlers[UPLOAD_HANDLER_KEY] = handler;
  }

  onFileHost(handler: Handler): void {
    this.handlers[FILE_HANDLER_KEY] = handler;
  }

  failSlack(apiMethod: string, error: string): void {
    this.handlers[apiMethod] = () => slackError(error);
  }

  failEverySlackMethod(error: string): void {
    for (const name of Object.keys(this.handlers)) {
      if (name !== UPLOAD_HANDLER_KEY && name !== FILE_HANDLER_KEY) this.handlers[name] = () => slackError(error);
    }
  }

  failNetwork(apiMethod: string, code = 'ECONNREFUSED'): void {
    this.handlers[apiMethod] = () => ({ networkError: code });
  }

  failHttp(apiMethod: string, status: number, headers: Record<string, string> = {}): void {
    this.handlers[apiMethod] = () => ({ data: {}, status, headers });
  }

  failUploadHost(status: number): void {
    this.handlers[UPLOAD_HANDLER_KEY] = () => ({ data: 'upload refused', status });
  }

  requestsFor(apiMethod: string): RecordedRequest[] {
    return this.requests.filter((request) => request.apiMethod === apiMethod);
  }

  uploadHostRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.apiMethod === undefined);
  }

  fileHostRequests(): RecordedRequest[] {
    return this.requests.filter((request) => FAKE_FILE_HOSTS.includes(request.host));
  }

  fieldsOf(request: RecordedRequest): SlackFields {
    return parseFields(request);
  }

  async dispatch(config: CallConfig, defaults: CallConfig, AxiosError: AxiosErrorConstructor): Promise<unknown> {
    const url = absoluteUrl(config, defaults);
    const parsedUrl = new URL(url);
    const headers = { ...flattenHeaders(defaults.headers), ...flattenHeaders(config.headers) };
    const credentials = config.auth ?? defaults.auth;
    if (credentials) {
      headers.authorization = `Basic ${Buffer.from(`${credentials.username ?? ''}:${credentials.password ?? ''}`).toString('base64')}`;
    }
    const body = await serializeBody(config.data);
    const apiMatch = /^\/api\/([A-Za-z0-9._]+)$/.exec(parsedUrl.pathname);
    const request: RecordedRequest = {
      httpMethod: (config.method ?? defaults.method ?? 'get').toUpperCase(),
      url,
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
      apiMethod: SLACK_API_HOSTS.has(parsedUrl.hostname) && apiMatch ? apiMatch[1] : undefined,
      headers,
      body: body.text,
      bodyWasStream: body.wasStream,
    };
    this.requests.push(request);

    const axiosConfig = { url, method: request.httpMethod.toLowerCase(), headers };
    const handler =
      request.apiMethod !== undefined
        ? (this.handlers[request.apiMethod] ?? (() => slackError('unknown_method')))
        : FAKE_FILE_HOSTS.includes(request.host)
          ? this.handlers[FILE_HANDLER_KEY]
          : this.handlers[UPLOAD_HANDLER_KEY];
    const reply = handler(parseFields(request), request);

    if ('networkError' in reply) {
      throw new AxiosError(`connect ${reply.networkError}`, reply.networkError, axiosConfig as never);
    }
    const status = reply.status ?? 200;
    const response = { status, statusText: String(status), data: reply.data, headers: reply.headers ?? {}, config: axiosConfig, request: {} };
    if (status >= 400) {
      const code = status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST';
      throw new AxiosError(`Request failed with status code ${status}`, code, axiosConfig as never, {}, response as never);
    }
    return response;
  }
}

export const fakeSlackApi = new FakeSlackApi();

export function createAxiosModule(actual: AxiosModule, api: FakeSlackApi) {
  const makeCaller = (createConfig: CallConfig) => {
    const defaults = {
      ...createConfig,
      headers: { common: {} as Record<string, unknown>, ...((createConfig.headers as object | undefined) ?? {}) },
    };
    const call = (config: CallConfig) => api.dispatch(config, defaults, actual.AxiosError);
    const instance: any = (config: CallConfig) => call(config);
    instance.request = call;
    for (const verb of ['get', 'delete', 'head', 'options'] as const) {
      instance[verb] = (url: string, config: CallConfig = {}) => call({ ...config, url, method: verb });
    }
    for (const verb of ['post', 'put', 'patch'] as const) {
      instance[verb] = (url: string, data?: unknown, config: CallConfig = {}) => call({ ...config, url, data, method: verb });
    }
    instance.interceptors = { request: { use: vi.fn() }, response: { use: vi.fn() } };
    instance.defaults = defaults;
    return instance;
  };
  const axiosDefault = makeCaller({});
  axiosDefault.create = (config: CallConfig = {}) => makeCaller(config);
  axiosDefault.AxiosError = actual.AxiosError;
  axiosDefault.isAxiosError = actual.isAxiosError;
  return {
    default: axiosDefault,
    AxiosError: actual.AxiosError,
    isAxiosError: actual.isAxiosError,
    create: axiosDefault.create,
  };
}
