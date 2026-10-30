import net from 'node:net';

export type RawOutcome = { kind: 'response'; status: number } | { kind: 'closed' } | { kind: 'silent' };

const STATUS_LINE = /^HTTP\/1\.[01] (\d{3})/;

/** Writes the request line byte for byte, so targets the HTTP client libraries would refuse can be sent. */
export function rawLoopbackRequest(options: { port: number; requestLine: string; waitMs?: number }): Promise<RawOutcome> {
  const { port, requestLine, waitMs = 750 } = options;
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let received = '';
    let finished = false;

    const outcomeSoFar = (whenNothingCame: RawOutcome): RawOutcome => {
      const status = STATUS_LINE.exec(received)?.[1];
      return status ? { kind: 'response', status: Number(status) } : whenNothingCame;
    };
    const finish = (whenNothingCame: RawOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcomeSoFar(whenNothingCame));
    };
    const timer = setTimeout(() => finish({ kind: 'silent' }), waitMs);

    socket.on('connect', () => socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
    });
    socket.on('close', () => finish({ kind: 'closed' }));
    socket.on('error', () => finish({ kind: 'closed' }));
  });
}
