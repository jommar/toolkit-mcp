import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCallbackListener } from './oauth-callback-server.js';
import { OAUTH_CALLBACK_PATH } from './slack-app.js';
import { canConnect, loopbackRequest, occupyPort } from './__fixtures__/loopback.js';
import { rawLoopbackRequest } from './__fixtures__/fix1-raw-request.js';
import { watchUnhandledRejections } from './__fixtures__/fix1-unhandled-rejections.js';
import { AUTH_CODE_SENTINEL, TOKEN_SENTINEL } from './__fixtures__/synthetic.js';

const STATE_FIXTURE = 'state-fixture-value-0123456789';

type Listener = NonNullable<Awaited<ReturnType<typeof startCallbackListener>>>;

const openListeners: Listener[] = [];

async function startListener(options: Partial<Parameters<typeof startCallbackListener>[0]> = {}) {
  const onCallback = vi.fn(async (_params: { code?: string; state?: string; error?: string }) => ({
    ok: true as boolean,
    code: undefined as string | undefined,
  }));
  const listener = await startCallbackListener({ port: 0, onCallback, ...options } as any);
  if (!listener) throw new Error('expected the listener to start on an ephemeral port');
  openListeners.push(listener);
  return { listener, onCallback };
}

const callbackPath = (query: string) => `${OAUTH_CALLBACK_PATH}?${query}`;

describe('oauth callback listener', () => {
  afterEach(async () => {
    await Promise.all(openListeners.splice(0).map((listener) => listener.close().catch(() => undefined)));
  });

  it('binds the loopback IPv4 address only', async () => {
    const { listener } = await startListener();

    expect(await canConnect('127.0.0.1', listener.port)).toBe(true);
    expect(await canConnect('127.0.0.2', listener.port)).toBe(false);
    expect(await canConnect('::1', listener.port)).toBe(false);
  });

  it('passes the code and state of a GET on the callback path to the handler once and closes after the completion', async () => {
    const { listener, onCallback } = await startListener();

    const response = await loopbackRequest({
      port: listener.port,
      path: callbackPath(`code=${AUTH_CODE_SENTINEL}&state=${STATE_FIXTURE}`),
    });

    expect(response.status).toBe(200);
    expect(onCallback).toHaveBeenCalledTimes(1);
    expect(onCallback).toHaveBeenCalledWith(expect.objectContaining({ code: AUTH_CODE_SENTINEL, state: STATE_FIXTURE }));
    await vi.waitFor(async () => expect(await canConnect('127.0.0.1', listener.port)).toBe(false), {
      timeout: 2000,
      interval: 20,
    });
  });

  it('answers with a static page that never echoes the code, the state or a token', async () => {
    const { listener } = await startListener();

    const response = await loopbackRequest({
      port: listener.port,
      path: callbackPath(`code=${AUTH_CODE_SENTINEL}&state=${STATE_FIXTURE}`),
    });

    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body).not.toContain(AUTH_CODE_SENTINEL);
    expect(response.body).not.toContain(STATE_FIXTURE);
    expect(response.body).not.toContain(TOKEN_SENTINEL);
  });

  it('answers a failed completion with a page that also never echoes the request values', async () => {
    const { listener, onCallback } = await startListener();
    onCallback.mockResolvedValueOnce({ ok: false, code: 'state_mismatch' });

    const response = await loopbackRequest({
      port: listener.port,
      path: callbackPath(`code=${AUTH_CODE_SENTINEL}&state=${STATE_FIXTURE}`),
    });

    expect(response.body.length).toBeGreaterThan(0);
    expect(response.body).not.toContain(AUTH_CODE_SENTINEL);
    expect(response.body).not.toContain(STATE_FIXTURE);
  });

  it.each([
    ['a POST on the callback path', 'POST', callbackPath(`code=${AUTH_CODE_SENTINEL}&state=${STATE_FIXTURE}`)],
    ['a GET on another path', 'GET', `/other?code=${AUTH_CODE_SENTINEL}&state=${STATE_FIXTURE}`],
    ['a GET on the root path', 'GET', '/'],
  ])('answers %s with 404, does not call the handler and keeps listening', async (_label, method, requestPath) => {
    const { listener, onCallback } = await startListener();

    const response = await loopbackRequest({ port: listener.port, path: requestPath, method });

    expect(response.status).toBe(404);
    expect(onCallback).not.toHaveBeenCalled();
    expect(await canConnect('127.0.0.1', listener.port)).toBe(true);
  });

  it('still completes after an unrelated request was refused', async () => {
    const { listener, onCallback } = await startListener();
    await loopbackRequest({ port: listener.port, path: '/favicon.ico' });

    const response = await loopbackRequest({
      port: listener.port,
      path: callbackPath(`code=${AUTH_CODE_SENTINEL}&state=${STATE_FIXTURE}`),
    });

    expect(response.status).toBe(200);
    expect(onCallback).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unparseable bracketed host', 'GET //[ HTTP/1.1'],
    ['a host with an out-of-range port', 'GET //a:99999/ HTTP/1.1'],
  ])(
    'answers %s with a client error or a closed connection, raises no unhandled rejection and keeps the pending login usable',
    async (_label, requestLine) => {
      const rejections = watchUnhandledRejections();
      try {
        const { listener, onCallback } = await startListener();

        const malformed = await rawLoopbackRequest({ port: listener.port, requestLine });
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(rejections.reasons).toEqual([]);
        expect(malformed.kind).not.toBe('silent');
        if (malformed.kind === 'response') {
          expect(malformed.status).toBeGreaterThanOrEqual(400);
          expect(malformed.status).toBeLessThan(500);
        }
        expect(onCallback).not.toHaveBeenCalled();

        const valid = await loopbackRequest({
          port: listener.port,
          path: callbackPath(`code=${AUTH_CODE_SENTINEL}&state=${STATE_FIXTURE}`),
        });

        expect(valid.status).toBe(200);
        expect(onCallback).toHaveBeenCalledTimes(1);
        expect(onCallback).toHaveBeenCalledWith(
          expect.objectContaining({ code: AUTH_CODE_SENTINEL, state: STATE_FIXTURE }),
        );
      } finally {
        rejections.stop();
      }
    },
  );

  it('resolves null when the port is already in use', async () => {
    const occupied = await occupyPort();
    try {
      const listener = await startCallbackListener({ port: occupied.port, onCallback: vi.fn() } as any);

      expect(listener).toBeNull();
    } finally {
      await occupied.release();
    }
  });

  it('closes itself at the TTL without calling the handler', async () => {
    const { listener, onCallback } = await startListener({ ttlMs: 50 });

    await vi.waitFor(async () => expect(await canConnect('127.0.0.1', listener.port)).toBe(false), {
      timeout: 2000,
      interval: 20,
    });

    expect(onCallback).not.toHaveBeenCalled();
  });

  it('refuses connections after close()', async () => {
    const { listener } = await startListener();

    await listener.close();

    expect(await canConnect('127.0.0.1', listener.port)).toBe(false);
  });
});
