export interface RefItem {
  ref?: string;
}

export interface BatchPage<T> {
  items: T[];
  hasMore: boolean;
  nextPageToken?: string;
}

export interface BatchError {
  code: string;
  message: string;
  retry_after_s?: number;
}

export type BatchEntry<T> =
  | { ref: string; index: number; status: 'ok'; items: T[]; hasMore: boolean; nextPageToken?: string }
  | { ref: string; index: number; status: 'error'; error: BatchError }
  | { ref: string; index: number; status: 'not_attempted'; hasMore: true; nextPageToken: string };

export interface BatchLimits {
  maxItems: number;
  concurrency?: number;
  callBudget?: number;
  /** Upstream calls spent so far; checked before each item starts. Defaults to one call per item started. */
  callsSpent?: () => number;
  maxResponseChars?: number;
}

export interface BatchOptions<I, T> {
  key: (item: I) => string;
  exec: (item: I) => Promise<BatchPage<T>>;
  resume: (item: I, keptCount: number) => string;
  limits: BatchLimits;
}

export interface BatchOutcome<T> {
  results: BatchEntry<T>[];
  truncated: boolean;
}

type Outcome<T> = { ok: true; page: BatchPage<T> } | { ok: false; error: BatchError };
type ResumeAt = (index: number, keptCount: number) => string;

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_CALL_BUDGET = 50;
const DEFAULT_MAX_RESPONSE_CHARS = 100_000;
const RATE_LIMITED_CODE = 'rate_limited';
const UNCODED_FAILURE_CODE = 'slack_error';

export async function runBatch<I extends RefItem, T>(
  items: I[],
  options: BatchOptions<I, T>,
): Promise<BatchOutcome<T>> {
  const { key, exec, resume, limits } = options;
  if (items.length > limits.maxItems) throw batchTooLarge(items.length, limits.maxItems);

  const outcomes = await fetchUnique(firstItemPerKey(items, key), exec, limits);
  const resumeAt: ResumeAt = (index, keptCount) => resume(items[index], keptCount);
  const entries = items.map((item, index) => {
    const groupKey = key(item);
    return entryFor(index, item.ref ?? groupKey, outcomes.get(groupKey), resumeAt);
  });
  return fitToCeiling(entries, resumeAt, limits.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS);
}

export function describeFailure(error: unknown): BatchError {
  const details = (error instanceof Object ? error : {}) as { code?: unknown; retry_after_s?: unknown };
  return {
    code: typeof details.code === 'string' ? details.code : UNCODED_FAILURE_CODE,
    message: error instanceof Error ? error.message : String(error),
    retry_after_s: typeof details.retry_after_s === 'number' ? details.retry_after_s : undefined,
  };
}

function batchTooLarge(count: number, maxItems: number): Error {
  return Object.assign(
    new Error(`slack.batch_too_large: ${count} items were sent, at most ${maxItems} fit in one call; split the list`),
    { code: 'batch_too_large' },
  );
}

function firstItemPerKey<I>(items: I[], key: (item: I) => string): Map<string, I> {
  const firstItems = new Map<string, I>();
  for (const item of items) {
    const groupKey = key(item);
    if (!firstItems.has(groupKey)) firstItems.set(groupKey, item);
  }
  return firstItems;
}

async function fetchUnique<I, T>(
  firstItems: Map<string, I>,
  exec: (item: I) => Promise<BatchPage<T>>,
  limits: BatchLimits,
): Promise<Map<string, Outcome<T>>> {
  const pending = [...firstItems];
  const outcomes = new Map<string, Outcome<T>>();
  const concurrency = limits.concurrency ?? DEFAULT_CONCURRENCY;
  const callBudget = limits.callBudget ?? DEFAULT_CALL_BUDGET;
  let nextPending = 0;
  let itemsStarted = 0;
  let rateLimited = false;
  const callsSpent = limits.callsSpent ?? (() => itemsStarted);

  const worker = async (): Promise<void> => {
    while (!rateLimited && callsSpent() < callBudget && nextPending < pending.length) {
      const [groupKey, item] = pending[nextPending];
      nextPending += 1;
      itemsStarted += 1;
      const outcome = await attempt(item, exec);
      outcomes.set(groupKey, outcome);
      if (!outcome.ok && outcome.error.code === RATE_LIMITED_CODE) rateLimited = true;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return outcomes;
}

async function attempt<I, T>(item: I, exec: (item: I) => Promise<BatchPage<T>>): Promise<Outcome<T>> {
  try {
    return { ok: true, page: await exec(item) };
  } catch (error) {
    return { ok: false, error: describeFailure(error) };
  }
}

function entryFor<T>(
  index: number,
  ref: string,
  outcome: Outcome<T> | undefined,
  resumeAt: ResumeAt,
): BatchEntry<T> {
  if (outcome === undefined) return notAttempted(ref, index, resumeAt(index, 0));
  if (!outcome.ok) return { ref, index, status: 'error', error: outcome.error };
  const { items, hasMore, nextPageToken } = outcome.page;
  return { ref, index, status: 'ok', items, hasMore, nextPageToken };
}

function notAttempted<T>(ref: string, index: number, cursor: string): BatchEntry<T> {
  return { ref, index, status: 'not_attempted', hasMore: true, nextPageToken: cursor };
}

interface CeilingState {
  used: number;
  cut: boolean;
}

function fitToCeiling<T>(entries: BatchEntry<T>[], resumeAt: ResumeAt, maxChars: number): BatchOutcome<T> {
  const state: CeilingState = { used: 0, cut: false };
  const results = entries.map((entry) => fitEntry(entry, resumeAt, maxChars, state));
  return { results, truncated: state.cut };
}

function fitEntry<T>(entry: BatchEntry<T>, resumeAt: ResumeAt, maxChars: number, state: CeilingState): BatchEntry<T> {
  if (entry.status !== 'ok' || entry.items.length === 0) return entry;
  const kept = state.cut ? 0 : countFitting(entry.items, state, maxChars);
  if (kept === entry.items.length) return entry;

  state.cut = true;
  if (kept === 0) return notAttempted(entry.ref, entry.index, resumeAt(entry.index, 0));
  return { ...entry, items: entry.items.slice(0, kept), hasMore: true, nextPageToken: resumeAt(entry.index, kept) };
}

function countFitting<T>(messages: T[], state: CeilingState, maxChars: number): number {
  let kept = 0;
  for (const message of messages) {
    const size = JSON.stringify(message).length;
    // The first message always goes out, so one oversized message cannot stall paging on an empty page.
    if (state.used > 0 && state.used + size > maxChars) break;
    state.used += size;
    kept += 1;
  }
  return kept;
}
