import type { AxiosInstance } from 'axios';

export interface RetryOptions {
  maxRetries?: number;
  skipOnCondition?: (config: any) => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** HTTP methods that mutate server state — retried only on errors with NO response (i.e. network failures). */
const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);

export function installRetry(http: AxiosInstance, opts: RetryOptions = {}): void {
  const maxRetries = opts.maxRetries ?? 3;
  const skipOnCondition = opts.skipOnCondition;

  http.interceptors.response.use(undefined, async (error) => {
    const config: any = error.config;
    const status: number | undefined = error.response?.status;
    const retryable =
      status === 429 ||
      status === 403 ||
      (status !== undefined && status >= 500 && status < 600) ||
      error.code === 'ECONNABORTED' ||
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'EAI_AGAIN';
    if (!config || !retryable) throw error;

    // Don't retry write methods if the server responded (request may have already applied)
    const method = config.method?.toLowerCase();
    if (WRITE_METHODS.has(method) && error.response) {
      throw error;
    }

    if (skipOnCondition?.(config)) throw error;

    config.__retryCount = (config.__retryCount ?? 0) + 1;
    if (config.__retryCount > maxRetries) throw error;

    const retryAfter = Number(error.response?.headers?.['retry-after']);
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(500 * 2 ** (config.__retryCount - 1), 8000);
    await sleep(delayMs);
    return http(config);
  });
}
