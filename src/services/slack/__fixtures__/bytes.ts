import { createHash } from 'node:crypto';

export function deterministicBytes(length: number, seed = 12345): Buffer {
  const out = Buffer.allocUnsafe(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = state >>> 24;
  }
  return out;
}

export function oneShotSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
