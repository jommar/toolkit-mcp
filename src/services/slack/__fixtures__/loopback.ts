import http from 'node:http';
import net from 'node:net';

export interface LoopbackResponse {
  status: number;
  body: string;
}

export function loopbackRequest(options: {
  port: number;
  path: string;
  method?: string;
  host?: string;
}): Promise<LoopbackResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: options.host ?? '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    request.on('error', reject);
    request.end();
  });
}

export function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export function occupyPort(): Promise<{ port: number; release(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ port, release: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}
