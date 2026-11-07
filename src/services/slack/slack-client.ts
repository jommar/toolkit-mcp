import axios, { isAxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import os from 'node:os';
import type { Readable } from 'node:stream';
import { installRetry } from '../http-retry.js';
import { readToken, slackPaths, type SlackPaths, type TokenRecord } from './credential-store.js';

const SLACK_API_BASE_URL = 'https://slack.com/api';
// A web session (xoxc token + d cookie) is issued to the Slack web client, so it is called on that host.
const SLACK_WEB_API_BASE_URL = 'https://app.slack.com/api';
const SLACK_HOST_SUFFIX = '.slack.com';
// The only hosts a file download may contact, compared whole: a suffix match would also admit hosts Slack does not run.
const SLACK_FILE_HOSTS: ReadonlySet<string> = new Set(['files.slack.com', 'files-origin.slack.com']);
const MAX_DOWNLOAD_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const DIRECTORY_PAGE_SIZE = 200;
const DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_AFTER_S = 60;
const SESSION_REJECTED_CODES: ReadonlySet<string> = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
]);

export type SlackArguments = Record<string, unknown>;
export type SlackResponse = { ok: true } & Record<string, unknown>;
export type AuthTestResponse = SlackResponse & {
  url: string;
  team: string;
  team_id: string;
  user: string;
  user_id: string;
};

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: { display_name?: string; real_name?: string; email?: string };
}

export type UploadUrlRequest = { filename: string; length: number };
export type UploadUrlResponse = SlackResponse & { upload_url: string; file_id: string };
export type UploadedFile = { id: string; title?: string };
export type CompleteUploadRequest = {
  files: UploadedFile[];
  channel_id?: string;
  thread_ts?: string;
  initial_comment?: string;
};

export interface SlackFile {
  id?: string;
  mimetype?: string;
  size?: number;
  mode?: string;
  is_external?: boolean;
  is_deleted?: boolean;
  is_tombstoned?: boolean;
  url_private?: string;
  url_private_download?: string;
}
export type FileInfoResponse = SlackResponse & { file: SlackFile };
export type FileDownload = { body: Readable; contentType?: string };

type UsersListResponse = SlackResponse & {
  members: SlackUser[];
  response_metadata?: { next_cursor?: string };
};

interface DirectoryCache {
  teamId: string;
  fetchedAt: number;
  members: SlackUser[];
}

/** Slack Web API client over the stored user token; the token file is read on every call. */
export class SlackClient {
  private readonly paths: SlackPaths;
  private readonly http: AxiosInstance;
  private directoryCache: DirectoryCache | undefined;

  constructor(paths: SlackPaths = slackPaths(os.homedir())) {
    this.paths = paths;
    this.http = axios.create({ baseURL: SLACK_API_BASE_URL, timeout: REQUEST_TIMEOUT_MS });
    installRetry(this.http, { skipOnCondition: isPostRequest });
  }

  authTest(): Promise<AuthTestResponse> {
    return this.get<AuthTestResponse>('auth.test');
  }

  authRevoke(): Promise<SlackResponse> {
    return this.post<SlackResponse>('auth.revoke');
  }

  conversationsInfo(params: SlackArguments): Promise<SlackResponse> {
    return this.get<SlackResponse>('conversations.info', params);
  }

  conversationsHistory(params: SlackArguments): Promise<SlackResponse> {
    return this.get<SlackResponse>('conversations.history', params);
  }

  conversationsReplies(params: SlackArguments): Promise<SlackResponse> {
    return this.get<SlackResponse>('conversations.replies', params);
  }

  conversationsList(params: SlackArguments): Promise<SlackResponse> {
    return this.get<SlackResponse>('conversations.list', params);
  }

  conversationsMembers(params: SlackArguments): Promise<SlackResponse> {
    return this.get<SlackResponse>('conversations.members', params);
  }

  usersInfo(params: SlackArguments): Promise<SlackResponse> {
    return this.get<SlackResponse>('users.info', params);
  }

  usersConversations(params: SlackArguments): Promise<SlackResponse> {
    return this.get<SlackResponse>('users.conversations', params);
  }

  searchMessages(params: SlackArguments): Promise<SlackResponse> {
    return this.get<SlackResponse>('search.messages', params);
  }

  postMessage(params: SlackArguments): Promise<SlackResponse> {
    return this.post<SlackResponse>('chat.postMessage', params);
  }

  addReaction(params: SlackArguments): Promise<SlackResponse> {
    return this.post<SlackResponse>('reactions.add', params);
  }

  filesInfo(params: { file: string }): Promise<FileInfoResponse> {
    return this.get<FileInfoResponse>('files.info', params);
  }

  getUploadUrl(params: UploadUrlRequest): Promise<UploadUrlResponse> {
    return this.get<UploadUrlResponse>('files.getUploadURLExternal', params);
  }

  completeUpload(params: CompleteUploadRequest): Promise<SlackResponse> {
    return this.post<SlackResponse>('files.completeUploadExternal', params);
  }

  async getUserDirectory(): Promise<SlackUser[]> {
    const token = await this.storedToken();
    const cached = this.directoryCache;
    // A cached directory is served only to the workspace that fetched it.
    if (cached?.teamId === token.team_id && Date.now() - cached.fetchedAt < DIRECTORY_CACHE_TTL_MS) {
      return cached.members;
    }
    const members = await this.fetchDirectory();
    this.directoryCache = { teamId: token.team_id, fetchedAt: Date.now(), members };
    return members;
  }

  // this.http adds the bearer token, so the bytes go through the default instance, which does not.
  // Redirects are reported rather than followed, so the file bytes never travel to a host Slack did not name.
  async sendUploadBytes(uploadUrl: string, body: Readable, contentLength: number): Promise<void> {
    if (!isSlackUploadUrl(uploadUrl)) {
      throw clientError('invalid_upload_url', 'Slack named an upload address that is not https on a slack.com host.');
    }
    try {
      await axios.post(uploadUrl, body, {
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(contentLength) },
        timeout: REQUEST_TIMEOUT_MS,
        maxBodyLength: Infinity,
        maxRedirects: 0,
      });
    } catch (error) {
      throw asClientError(error);
    }
  }

  // The stored credentials go through the default instance, one request at a time, and each request gets them
  // only after its own address passed isSlackFileUrl: nothing is forwarded by axios, and a redirect to any
  // other host is refused unfollowed. The body is a stream the caller must consume or destroy.
  async openFileDownload(fileUrl: string): Promise<FileDownload> {
    const token = await this.storedToken();
    let address = fileUrl;
    for (let redirects = 0; ; redirects += 1) {
      if (!isSlackFileUrl(address)) throw offListError(address, redirects);
      const response = await this.requestFile(address, token);
      if (response.status < 300) {
        return { body: response.data, contentType: headerText(response.headers['content-type']) };
      }
      response.data.destroy();
      const next = redirectTarget(address, headerText(response.headers.location));
      if (next === undefined || redirects === MAX_DOWNLOAD_REDIRECTS) {
        throw clientError('download_failed', 'Slack answered a redirect that could not be followed.');
      }
      address = next;
    }
  }

  private async requestFile(address: string, token: TokenRecord): Promise<AxiosResponse<Readable>> {
    try {
      return await axios.get<Readable>(address, {
        headers: authHeaders(token),
        responseType: 'stream',
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 400,
      });
    } catch (error) {
      if (isAxiosError(error)) (error.response?.data as Readable | undefined)?.destroy();
      throw asClientError(error);
    }
  }

  private async fetchDirectory(): Promise<SlackUser[]> {
    const members: SlackUser[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.get<UsersListResponse>('users.list', { limit: DIRECTORY_PAGE_SIZE, cursor });
      members.push(...page.members);
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return members;
  }

  private async get<T extends SlackResponse>(slackMethod: string, params: SlackArguments = {}): Promise<T> {
    const token = await this.storedToken();
    return this.send(() =>
      this.http.get<T>(slackMethod, { params, headers: authHeaders(token), baseURL: baseUrlFor(token) }),
    );
  }

  private async post<T extends SlackResponse>(slackMethod: string, data?: SlackArguments): Promise<T> {
    const token = await this.storedToken();
    return this.send(() =>
      this.http.post<T>(slackMethod, data, { headers: authHeaders(token), baseURL: baseUrlFor(token) }),
    );
  }

  private async send<T extends SlackResponse>(request: () => Promise<AxiosResponse<T>>): Promise<T> {
    let response: AxiosResponse<T>;
    try {
      response = await request();
    } catch (error) {
      throw asClientError(error);
    }
    if (response.data.ok !== true) {
      throw slackCodeError(typeof response.data.error === 'string' ? response.data.error : 'unknown_error');
    }
    return response.data;
  }

  private async storedToken(): Promise<TokenRecord> {
    const token = await readToken(this.paths);
    if (!token) throw clientError('not_connected', 'No Slack token is stored for this module.');
    return token;
  }
}

// A web session needs the `d` cookie beside its token; neither works alone. An app token carries no cookie.
function authHeaders(token: TokenRecord): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token.access_token}` };
  return token.cookie ? { ...headers, Cookie: `d=${token.cookie}` } : headers;
}

function baseUrlFor(token: TokenRecord): string {
  return token.cookie ? SLACK_WEB_API_BASE_URL : SLACK_API_BASE_URL;
}

// A write that Slack answered late may already be applied, so a timeout or reset never resends it.
function isPostRequest(config: { method?: string }): boolean {
  return config.method?.toLowerCase() === 'post';
}

function isSlackUploadUrl(uploadUrl: string): boolean {
  try {
    const { protocol, hostname } = new URL(uploadUrl);
    return protocol === 'https:' && hostname.endsWith(SLACK_HOST_SUFFIX);
  } catch {
    return false;
  }
}

function isSlackFileUrl(address: string): boolean {
  try {
    const { protocol, hostname } = new URL(address);
    return protocol === 'https:' && SLACK_FILE_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

// The first address comes from Slack's file record; any later one is a redirect target that redirectTarget parsed.
function offListError(address: string, redirects: number): Error {
  if (redirects === 0) {
    return clientError(
      'file_not_downloadable',
      'Slack named a download address that is not https on a Slack file host.',
    );
  }
  return clientError(
    'download_not_authorized',
    `Slack redirected the download to ${new URL(address).hostname}, which is not an https Slack file host, ` +
      'so it was not followed.',
  );
}

function redirectTarget(from: string, location: string | undefined): string | undefined {
  if (location === undefined) return undefined;
  try {
    return new URL(location, from).href;
  } catch {
    return undefined;
  }
}

function headerText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clientError(code: string, message: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, ...details });
}

function slackCodeError(slackCode: string): Error {
  if (SESSION_REJECTED_CODES.has(slackCode)) {
    return clientError('session_rejected', `Slack no longer accepts the stored token (${slackCode}).`, {
      slack_code: slackCode,
    });
  }
  return clientError('slack_error', `Slack answered ${slackCode}.`, { slack_code: slackCode });
}

// Axios errors carry the request config, which holds the bearer token, so only this module's errors leave it.
function asClientError(error: unknown): unknown {
  if (!isAxiosError(error)) return error;
  const response = error.response;
  if (!response) return clientError('unreachable', 'Slack could not be reached.');
  if (response.status === 429) {
    return clientError('rate_limited', 'Slack rate-limited this call.', {
      retry_after_s: retryAfterSeconds(response.headers),
    });
  }
  const slackCode = slackErrorCode(response.data);
  if (slackCode) return slackCodeError(slackCode);
  return clientError('slack_error', `Slack answered HTTP ${response.status}.`, { http_status: response.status });
}

// Slack's rate-limit windows are one minute; used only when Retry-After is missing or unusable.
function retryAfterSeconds(headers: AxiosResponse['headers']): number {
  const seconds = Number(headers['retry-after']);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_S;
}

function slackErrorCode(data: unknown): string | undefined {
  const body = data as { ok?: unknown; error?: unknown } | null;
  return body?.ok === false && typeof body.error === 'string' ? body.error : undefined;
}
