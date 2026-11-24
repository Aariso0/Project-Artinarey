import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import {
  dispatchTool, invalidateWorktree, isToolMethod, releaseConnection, type RpcContext,
} from './tools.ts';

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

/** Control methods stay synchronous so callers can use them without an event loop. */
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

function isControl(method: string): boolean {
  return method === 'ping' || method === 'status' || method === 'shutdown';
}

async function dispatchRequest(request: RpcRequest, ctx?: RpcContext): Promise<RpcResponse> {
  if (isControl(request.method)) return handleRequest(request);
  if (!ctx) {
    if (!isToolMethod(request.method)) return handleRequest(request);
    return {
      id: request.id,
      ok: false,
      error: { code: 'NO_PROJECT', message: 'no attached session; call attach first' },
    };
  }
  return dispatchTool(request, ctx);
}

/** Newline-delimited JSON over a 0600 unix socket. Each connection owns its identity. */
export function createRpcServer(
  socketPath: string,
  onShutdown?: () => void,
  shared?: RpcContext,
  /** Test seam: fires after per-connection cleanup, including when release fails. */
  onConnectionClosed?: () => void,
): RpcServer {
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const sockets = new Set<Socket>();
  const contexts = new Set<RpcContext>();
  const closed = new Set<Promise<void>>();

  const rpcServer: RpcServer = {
    socketPath,
    async start() {
      mkdirSync(dirname(socketPath), { recursive: true });
      if (existsSync(socketPath)) unlinkSync(socketPath);
      server = createServer((socket) => {
        if (closing) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        let markClosed!: () => void;
        const closedPromise = new Promise<void>((resolve) => { markClosed = resolve; });
        closed.add(closedPromise);
        const ctx: RpcContext | undefined = shared ? { ...shared } : undefined;
        if (ctx) {
          // A forced release affects every connection bound to that worktree.
          ctx.invalidateWorktree = (worktreeId) => {
            for (const active of contexts) invalidateWorktree(active, worktreeId);
          };
          contexts.add(ctx);
        }
        socket.on('error', (err) => {
          console.error(`client socket error: ${(err as Error).message ?? String(err)}`);
          socket.destroy();
        });
        socket.on('close', () => {
          sockets.delete(socket);
          try {
            if (ctx) {
              contexts.delete(ctx);
              releaseConnection(ctx);
            }
          } catch (err) {
            console.error(`connection cleanup failed: ${(err as Error).message ?? String(err)}`);
          } finally {
            closed.delete(closedPromise);
            markClosed();
            onConnectionClosed?.();
          }
        });
        socket.setEncoding('utf8');
        let buffer = '';
        // One queue per connection: replies stay in request order and a loop that
        // awaits a slow tool cannot race a later data event over the same buffer.
        let queued: Promise<void> = Promise.resolve();

        socket.on('data', (chunk: string) => {
          buffer += chunk;
          queued = queued.then(async () => {
            let end: number;
            while (!socket.destroyed && (end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              if (!line.trim()) continue;

              let request: RpcRequest | undefined;
              let response: RpcResponse;
              let shutdown = false;
              try {
                request = JSON.parse(line) as RpcRequest;
              } catch (err) {
                socket.write(`${JSON.stringify({
                  id: 'invalid',
                  ok: false,
                  error: {
                    code: (err as { code?: string }).code ?? 'INVALID_INPUT',
                    message: (err as Error).message ?? 'malformed JSON',
                  },
                } satisfies RpcResponse)}\n`);
                continue;
              }
              try {
                response = await dispatchRequest(request, ctx);
                shutdown = response.ok && request?.method === 'shutdown';
              } catch (err) {
                response = {
                  id: request?.id ?? 'invalid',
                  ok: false,
                  error: {
                    code: (err as { code?: string }).code ?? 'INTERNAL_ERROR',
                    message: (err as Error).message ?? 'request failed',
                  },
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
          }).catch((err) => {
            console.error(`request failed: ${(err as Error).message ?? String(err)}`);
          });
        });
      });

      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server!.once('error', onError);
        server!.listen(socketPath, () => {
          server!.off('error', onError);
          try {
            chmodSync(socketPath, 0o600);
          } catch (err) {
            server!.close();
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
    async close() {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          // Every close handler must release its binding before the registry closes.
          await Promise.allSettled([...closed]);
          closed.clear();
          try {
            if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
            if (existsSync(socketPath)) unlinkSync(socketPath);
          } finally {
            // Lock and registry cleanup must happen even if the socket is unremovable.
            onShutdown?.();
          }
        })();
      }
      return closePromise;
    },
  };

  return rpcServer;
}
