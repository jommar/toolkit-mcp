import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } from './slack-app.js';

const LOOPBACK_HOST = '127.0.0.1';
const PAGE_HEAD = '<!doctype html><meta charset="utf-8"><title>Slack login</title>';
const DONE_PAGE = `${PAGE_HEAD}<p>Slack login finished. You can close this tab and return to your agent.</p>`;
const FAILED_PAGE = `${PAGE_HEAD}<p>Slack login did not finish. Return to your agent for the next step.</p>`;
const NOT_FOUND_PAGE = `${PAGE_HEAD}<p>Not found.</p>`;

export interface RedirectParams {
  code?: string;
  state?: string;
  error?: string;
}

export type CallbackOutcome = { ok: true } | { ok: false; code: string };

export interface CallbackListener {
  readonly port: number;
  close(): Promise<void>;
}

export interface CallbackListenerOptions {
  port?: number;
  /** Omitted means no timer; the listener then stays open until it completes or is closed. */
  ttlMs?: number;
  onCallback: (params: RedirectParams) => Promise<CallbackOutcome>;
}

/** Resolves null when the port is busy, so the caller can fall back to pasting the redirect address. */
export async function startCallbackListener({
  port = OAUTH_CALLBACK_PORT,
  ttlMs,
  onCallback,
}: CallbackListenerOptions): Promise<CallbackListener | null> {
  const server = createServer((request, response) => {
    // Any local process can send a request target that does not parse; it must get an answer, not a rejection.
    void serveCallback(request, response, onCallback, closeOnce).catch(() => respond(response, 400, FAILED_PAGE));
  });
  let closing: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const closeOnce = (): Promise<void> => {
    clearTimeout(timer);
    closing ??= new Promise((resolve) => server.close(() => resolve()));
    return closing;
  };

  try {
    await listenOnLoopback(server, port);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return null;
    throw error;
  }

  if (ttlMs !== undefined) timer = setTimeout(() => void closeOnce(), ttlMs);
  const { port: boundPort } = server.address() as AddressInfo;
  return { port: boundPort, close: closeOnce };
}

function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function serveCallback(
  request: IncomingMessage,
  response: ServerResponse,
  onCallback: CallbackListenerOptions['onCallback'],
  close: () => Promise<void>,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
  if (request.method !== 'GET' || url.pathname !== OAUTH_CALLBACK_PATH) {
    respond(response, 404, NOT_FOUND_PAGE);
    return;
  }

  const outcome = await onCallback({
    code: url.searchParams.get('code') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    error: url.searchParams.get('error') ?? undefined,
  });
  if (!outcome.ok) {
    respond(response, 400, FAILED_PAGE);
    return;
  }
  respond(response, 200, DONE_PAGE, close);
}

// Closing after the page is flushed keeps the browser's response from being cut off.
function respond(response: ServerResponse, status: number, body: string, onFinish?: () => unknown): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body, onFinish);
}
