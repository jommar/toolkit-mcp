import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { vi } from 'vitest';
import { settle, type Settled } from './settle.js';

export interface AdapterCall {
  method: string;
  slackMethod: string;
}

export type AdapterReply =
  | { networkError: string }
  | { status?: number; headers?: Record<string, string>; data?: unknown };

const RETRY_CLOCK_STEP_MS = 1000;
const RETRY_CLOCK_REAL_TIME_BUDGET_MS = 4000;

/**
 * Makes axios.create hand out real axios instances whose network layer is the given responder, so the
 * response interceptors the client installs (the retry among them) actually run.
 */
export async function useRealAxiosInstances(respond: (call: AdapterCall) => AdapterReply) {
  const actual = await vi.importActual<typeof import('axios')>('axios');
  const calls: AdapterCall[] = [];

  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const call: AdapterCall = {
      method: String(config.method).toLowerCase(),
      slackMethod: String(config.url).split('/').pop() ?? '',
    };
    calls.push(call);

    const reply = respond(call);
    if ('networkError' in reply) throw new actual.AxiosError(`connect ${reply.networkError}`, reply.networkError, config);

    const status = reply.status ?? 200;
    const response: AxiosResponse = {
      data: reply.data ?? { ok: true },
      status,
      statusText: '',
      headers: reply.headers ?? {},
      config,
      request: {},
    };
    if (status >= 200 && status < 300) return response;
    const code = status >= 500 ? actual.AxiosError.ERR_BAD_RESPONSE : actual.AxiosError.ERR_BAD_REQUEST;
    throw new actual.AxiosError(`Request failed with status code ${status}`, code, config, {}, response);
  };

  const create = vi
    .spyOn(axios, 'create')
    .mockImplementation((config) => actual.default.create({ ...config, adapter }));
  return { calls, restore: () => create.mockRestore() };
}

/** The retry waits on setTimeout, so the clock is stepped forward until the call settles. */
export async function settleWithRetryClock<T>(run: () => Promise<T>): Promise<Settled<T>> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let finished = false;
    const outcome = settle(run).finally(() => {
      finished = true;
    });
    const giveUpAt = performance.now() + RETRY_CLOCK_REAL_TIME_BUDGET_MS;
    while (!finished && performance.now() < giveUpAt) {
      await vi.advanceTimersByTimeAsync(RETRY_CLOCK_STEP_MS);
    }
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}
