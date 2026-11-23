import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';

export type RpcRequest = { id: string; method: string; params?: unknown };
export type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export type RpcServer = {
  socketPath: string;
  start(): Promise<void>;
  close(): Promise<void>;
};

const startedAt = new Date().toISOString();

export function handleRequest(request: RpcRequest): RpcResponse {
  if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
    return { id: 'invalid', ok: false, error: { code: 'INVALID_INPUT', message: 'invalid request' } };
  }
  switch (request.method) {
    case 'ping':
      return { id: request.id, ok: true, result: { pong: true, pid: process.pid } };
    case 'status':
      return { id: request.id, ok: true, result: { running: true, pid: process.pid, startedAt } };
    case 'shutdown':
      return { id: request.id, ok: true, result: { shuttingDown: true } };
    default:
      return {
        id: request.id,
        ok: false,
        error: { code: 'NOT_FOUND', message: `unknown method: ${request.method}` },
      };
  }
}

/** Newline-delimited JSON over a 0600 unix socket. M2 adds tool methods here. */
export function createRpcServer(socketPath: string, onShutdown?: () => void): RpcServer {
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  const sockets = new Set<Socket>();

  const rpcServer: RpcServer = {
    socketPath,
    async start() {
      if (existsSync(socketPath)) unlinkSync(socketPath);
      server = createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.setEncoding('utf8');
        let buffer = '';

        socket.on('data', (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;

            let response: RpcResponse;
            let shutdown = false;
            try {
              const request = JSON.parse(line) as RpcRequest;
              shutdown = request?.method === 'shutdown';
              response = handleRequest(request);
            } catch {
              response = {
                id: 'invalid',
                ok: false,
                error: { code: 'INVALID_INPUT', message: 'malformed JSON' },
              };
            }
            socket.write(`${JSON.stringify(response)}\n`);
            if (shutdown) {
              socket.end();
              setImmediate(() => {
                void rpcServer.close();
              });
            }
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server!.once('error', onError);
        server!.listen(socketPath, () => {
          server!.off('error', onError);
          chmodSync(socketPath, 0o600);
          resolve();
        });
      });
    },
    async close() {
      if (!closePromise) {
        closePromise = (async () => {
          if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
          for (const socket of sockets) socket.destroy();
          if (existsSync(socketPath)) unlinkSync(socketPath);
          onShutdown?.();
        })();
      }
      return closePromise;
    },
  };

  return rpcServer;
}
