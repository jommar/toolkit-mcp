export interface RejectionWatch {
  reasons: unknown[];
  stop(): void;
}

/** Takes over unhandledRejection for the watch's lifetime, so a rejection is counted instead of failing the run. */
export function watchUnhandledRejections(): RejectionWatch {
  const inherited = process.listeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const reasons: unknown[] = [];
  const record = (reason: unknown) => {
    reasons.push(reason);
  };
  process.on('unhandledRejection', record);
  return {
    reasons,
    stop() {
      process.off('unhandledRejection', record);
      for (const listener of inherited) process.on('unhandledRejection', listener);
    },
  };
}
