import { vi } from 'vitest';

export interface RecordedRequest {
  method: string;
  url: string;
  slackMethod: string;
  headers: Record<string, string>;
  params: Record<string, unknown>;
  body: unknown;
  bodyParams: Record<string, string>;
  streamedBytes?: number;
}

export interface HarnessReply {
  status?: number;
  headers?: Record<string, string>;
  data?: unknown;
  networkError?: string;
}

type Responder = (request: RecordedRequest) => HarnessReply | Promise<HarnessReply>;

const SLACK_API_PREFIX = 'https://slack.com/api/';
// A session adopted from the web client is called on the host that issued it.
const SLACK_WEB_API_PREFIX = 'https://app.slack.com/api/';

const state = {
  requests: [] as RecordedRequest[],
  instances: [] as any[],
  responder: (() => ({ data: { ok: true } })) as Responder,
  AxiosError: Error as any,
};

function joinUrl(baseURL: string, url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseURL) return url;
  return `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
}

function slackMethodOf(url: string): string {
  for (const prefix of [SLACK_API_PREFIX, SLACK_WEB_API_PREFIX]) {
    if (url.startsWith(prefix)) return url.slice(prefix.length).split('?')[0];
  }
  return '';
}

function plainHeaders(source: any): Record<string, unknown> {
  if (!source) return {};
  return typeof source.toJSON === 'function' ? source.toJSON() : source;
}

function mergeHeaders(...layers: any[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    for (const [name, value] of Object.entries(plainHeaders(layer))) {
      if (value !== null && typeof value === 'object') {
        Object.assign(merged, mergeHeaders(value));
        continue;
      }
      const key = name.toLowerCase();
      if (value === undefined || value === null || value === false || value === '') delete merged[key];
      else merged[key] = String(value);
    }
  }
  return merged;
}

function basicAuthHeader(auth: any): Record<string, string> {
  if (!auth) return {};
  const encoded = Buffer.from(`${auth.username ?? ''}:${auth.password ?? ''}`).toString('base64');
  return { authorization: `Basic ${encoded}` };
}

function decodeBodyParams(body: unknown): Record<string, string> {
  if (body === undefined || body === null) return {};
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    const text = body.toString();
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return stringifyValues(parsed);
    } catch {
      return Object.fromEntries(new URLSearchParams(text).entries());
    }
    return {};
  }
  if (typeof body === 'object' && typeof (body as any).pipe !== 'function') return stringifyValues(body as any);
  return {};
}

function stringifyValues(source: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value)]));
}

async function drain(stream: AsyncIterable<Buffer | string>): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += chunk.length;
  return bytes;
}

function isStream(body: unknown): body is AsyncIterable<Buffer | string> {
  return !!body && typeof (body as any).pipe === 'function';
}

async function dispatch(instance: any, createConfig: any, requested: any): Promise<any> {
  let config = { ...requested };
  for (const handler of instance.requestHandlers) config = (await handler(config)) ?? config;

  const method = String(config.method ?? 'get').toLowerCase();
  const url = joinUrl(config.baseURL ?? createConfig.baseURL ?? '', config.url ?? '');
  const headers = mergeHeaders(
    createConfig.headers,
    instance.defaults.headers.common,
    basicAuthHeader(createConfig.auth),
    basicAuthHeader(config.auth),
    config.headers,
  );
  const body = config.data;
  const record: RecordedRequest = {
    method,
    url,
    slackMethod: slackMethodOf(url),
    headers,
    params: { ...(config.params ?? {}) },
    body,
    bodyParams: decodeBodyParams(body),
  };
  if (isStream(body)) record.streamedBytes = await drain(body);
  state.requests.push(record);

  const reply = await state.responder(record);
  if (reply.networkError) {
    throw new state.AxiosError(`connect ${reply.networkError}`, reply.networkError, config);
  }
  const status = reply.status ?? 200;
  const response = {
    data: reply.data ?? { ok: true },
    status,
    statusText: '',
    headers: Object.fromEntries(Object.entries(reply.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    config,
    request: {},
  };
  if (status < 200 || status >= 300) {
    throw new state.AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', config, {}, response);
  }
  return response;
}

function makeInstance(createConfig: any = {}): any {
  const requestHandlers: Array<(config: any) => any> = [];
  const defaults = { headers: { common: {} as Record<string, string> } };
  const send = (config: any) => dispatch(instance, createConfig, config);
  const instance: any = Object.assign((config: any) => send(config), {
    requestHandlers,
    defaults,
    createConfig,
    request: send,
    get: (url: string, config: any = {}) => send({ ...config, url, method: 'get' }),
    delete: (url: string, config: any = {}) => send({ ...config, url, method: 'delete' }),
    post: (url: string, data?: unknown, config: any = {}) => send({ ...config, url, data, method: 'post' }),
    put: (url: string, data?: unknown, config: any = {}) => send({ ...config, url, data, method: 'put' }),
    patch: (url: string, data?: unknown, config: any = {}) => send({ ...config, url, data, method: 'patch' }),
    interceptors: {
      request: { use: (handler: (config: any) => any) => requestHandlers.push(handler) },
      response: { use: vi.fn() },
    },
  });
  return instance;
}

export const axiosHarness = {
  get requests(): RecordedRequest[] {
    return state.requests;
  },
  get instances(): any[] {
    return state.instances;
  },
  reset(): void {
    state.requests.length = 0;
    state.responder = () => ({ data: { ok: true } });
  },
  respond(responder: Responder): void {
    state.responder = responder;
  },
  respondBySlackMethod(replies: Record<string, HarnessReply | ((request: RecordedRequest) => HarnessReply)>): void {
    state.responder = (request) => {
      const reply = replies[request.slackMethod];
      if (reply === undefined) return { data: { ok: true } };
      return typeof reply === 'function' ? reply(request) : reply;
    };
  },
  requestsFor(slackMethod: string): RecordedRequest[] {
    return state.requests.filter((request) => request.slackMethod === slackMethod);
  },
};

export async function createAxiosModuleMock(): Promise<any> {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  state.AxiosError = actual.AxiosError;
  const defaultInstance = makeInstance({});
  const create = (config: any = {}) => {
    const instance = makeInstance(config);
    state.instances.push(instance);
    return instance;
  };
  const axiosDefault = Object.assign(defaultInstance, {
    create,
    AxiosError: actual.AxiosError,
    isAxiosError: actual.isAxiosError,
  });
  return {
    default: axiosDefault,
    create,
    AxiosError: actual.AxiosError,
    isAxiosError: actual.isAxiosError,
  };
}

export function forbidFetch(): void {
  vi.stubGlobal('fetch', () => {
    throw new Error('fetch is not allowed in offline tests');
  });
}

export const slackOk = (body: Record<string, unknown> = {}): HarnessReply => ({ data: { ok: true, ...body } });
export const slackFailure = (error: string): HarnessReply => ({ data: { ok: false, error } });
