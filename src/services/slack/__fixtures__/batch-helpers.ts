export interface BatchItem {
  id: string;
  ref?: string;
}

export const keyOf = (item: BatchItem): string => item.id;

export const resumeCursorOf = (item: BatchItem, keptCount: number): string => `resume:${item.id}:${keptCount}`;

export function failure(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`fixture failure ${code}`), { code, ...extra });
}

export function page<T>(items: T[], extra: Record<string, unknown> = {}) {
  return { items, hasMore: false, ...extra };
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function numberedItems(count: number, prefix = 'item'): BatchItem[] {
  return Array.from({ length: count }, (_unused, index) => ({ id: `${prefix}-${index + 1}` }));
}

export function messageOf(owner: string, index: number, textLength = 100) {
  return {
    ts: `1700000000.${String(index + 1).padStart(6, '0')}`,
    owner,
    text: 'x'.repeat(textLength),
  };
}

export const tick = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));
