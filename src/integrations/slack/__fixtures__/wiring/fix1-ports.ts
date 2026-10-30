import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// The port registered as the redirect address of the shipped app; independent of the module's own constant.
export const PRODUCTION_CALLBACK_PORT = 53682;

const LOOPBACK_HOST = '127.0.0.1';

export async function pickFreePort(): Promise<number> {
  for (;;) {
    const port = await bindAndReleaseEphemeralPort();
    if (port !== PRODUCTION_CALLBACK_PORT) return port;
  }
}

function bindAndReleaseEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface ProductionPortDecoy {
  /** False when some other process already holds the port, which is the situation the decoy stands in for. */
  held: boolean;
  requests: string[];
  release: () => Promise<void>;
}

export async function holdProductionPort(): Promise<ProductionPortDecoy> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('decoy');
  });

  const held = await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(PRODUCTION_CALLBACK_PORT, LOOPBACK_HOST, () => resolve(true));
  });

  return {
    held,
    requests,
    release: () =>
      held
        ? new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
        : Promise.resolve(),
  };
}
