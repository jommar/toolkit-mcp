import { randomBytes } from 'node:crypto';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describeFailure, type BatchError } from '../../services/slack/batch-runner.js';

const CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const TOKEN_BYTES = 24;

export interface FailedWrite {
  index: number;
  status: 'error';
  error: BatchError;
}

export interface IssuedConfirmation {
  confirmation_token: string;
  expires_at: string;
}

export interface RedeemedWrites<R> {
  already_sent: boolean;
  results: Array<R | FailedWrite>;
}

export interface WriteGateOptions {
  now?: () => number;
}

interface Confirmation<T> {
  items: T[];
  expiresAt: number;
  outcome?: Promise<unknown[]>;
}

/** Freezes a preview's items behind one single-use token; only a redeemed token reaches the executor. */
export class WriteGate<T = unknown> {
  private readonly now: () => number;
  private readonly confirmations = new Map<string, Confirmation<T>>();

  constructor(options: WriteGateOptions = {}) {
    // Looked up per call, so a clock replaced after the gate is built is still honored.
    this.now = options.now ?? (() => Date.now());
  }

  issue(items: T[]): IssuedConfirmation {
    this.sweepExpired();
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = this.now() + CONFIRMATION_TTL_MS;
    this.confirmations.set(token, { items: [...items], expiresAt });
    return { confirmation_token: token, expires_at: new Date(expiresAt).toISOString() };
  }

  async redeem<R>(token: string, execute: (item: T, index: number) => Promise<R>): Promise<RedeemedWrites<R>> {
    const confirmation = this.confirmations.get(token);
    if (!confirmation) {
      throw confirmationError(
        'confirmation_unknown',
        'No confirmation matches this token. Preview the items again with slack_prepare_write.',
      );
    }
    if (this.now() >= confirmation.expiresAt) {
      throw confirmationError(
        'confirmation_expired',
        'This confirmation expired, so nothing was sent. Preview the items again with slack_prepare_write.',
      );
    }

    const alreadySent = confirmation.outcome !== undefined;
    confirmation.outcome ??= runInOrder(confirmation.items, execute);
    const results = (await confirmation.outcome) as Array<R | FailedWrite>;
    return { already_sent: alreadySent, results };
  }

  // Runs on each issue, so tokens nobody redeems do not accumulate past their TTL.
  private sweepExpired(): void {
    const now = this.now();
    for (const [token, confirmation] of this.confirmations) {
      if (now >= confirmation.expiresAt) this.confirmations.delete(token);
    }
  }
}

function confirmationError(code: string, sentence: string): McpError {
  return new McpError(ErrorCode.InvalidParams, `slack.${code}: ${sentence}`);
}

async function runInOrder<T, R>(
  items: T[],
  execute: (item: T, index: number) => Promise<R>,
): Promise<Array<R | FailedWrite>> {
  const results: Array<R | FailedWrite> = [];
  for (const [index, item] of items.entries()) {
    results.push(await runOne(item, index, execute));
  }
  return results;
}

async function runOne<T, R>(
  item: T,
  index: number,
  execute: (item: T, index: number) => Promise<R>,
): Promise<R | FailedWrite> {
  try {
    return await execute(item, index);
  } catch (error) {
    return { index, status: 'error', error: describeFailure(error) };
  }
}
