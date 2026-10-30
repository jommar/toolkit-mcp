import { rawMessage, type RawMessage } from './fake-slack.js';
import { tsFor } from './ids.js';

export interface HistoryShape {
  count: number;
  newestOffset: number;
  botEvery: number;
  botRemainder: number;
}

export interface GeneratedHistory {
  messages: RawMessage[];
  humanTimestamps: string[];
}

/** Newest-first history in which every `botEvery`-th message (from `botRemainder`) is a bot's. */
export function generateHistory(shape: HistoryShape): GeneratedHistory {
  const messages: RawMessage[] = [];
  const humanTimestamps: string[] = [];
  for (let index = 0; index < shape.count; index += 1) {
    const ts = tsFor(shape.newestOffset - index);
    const bot = index % shape.botEvery === shape.botRemainder;
    messages.push(rawMessage({ ts, bot }));
    if (!bot) humanTimestamps.push(ts);
  }
  return { messages, humanTimestamps };
}

export interface GeneratedThread {
  key: string;
  rootTs: string;
  replyTs: string[];
  messages: RawMessage[];
  timestamps: string[];
}

/** A thread whose root sits at `rootOffset` seconds and whose replies follow one second apart. */
export function generateThread(channelId: string, rootOffset: number, replyCount: number): GeneratedThread {
  const rootTs = tsFor(rootOffset);
  const replyTs = Array.from({ length: replyCount }, (_, index) => tsFor(rootOffset + 1 + index));
  const root = rawMessage({ ts: rootTs, threadTs: rootTs, replyCount });
  const replies = replyTs.map((ts) => rawMessage({ ts, threadTs: rootTs }));
  return {
    key: `${channelId}:${rootTs}`,
    rootTs,
    replyTs,
    messages: [root, ...replies],
    timestamps: [rootTs, ...replyTs],
  };
}
