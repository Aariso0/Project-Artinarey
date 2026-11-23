import { spawn } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, type XdgPaths } from '@artinarey/core';
import type { ShimReply } from './tools.ts';

export type DaemonClientOptions = {
  paths: XdgPaths;
  cwd?: string;
  pid?: number;
  /** Tests use an in-process server and set this to false. */
  autoStart?: boolean;
  timeoutMs?: number;
};

export type DaemonClient = {
  invoke(method: string, params: Record<string, unknown>): Promise<ShimReply>;
  close(): void;
};

type RpcResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(path);
    socket.once('connect', () => resolvePromise(socket));
    socket.once('error', reject);
  });
}

/** A socket file is not readiness: a crashed daemon can leave a file with no listener. */
function waitForDaemon(path: string, timeoutMs: number): Promise<Socket> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      connectSocket(path).then(resolvePromise, (err: NodeJS.ErrnoException) => {
        if (Date.now() >= deadline) {
          return reject(new Error(`daemon did not start in time: ${err.message}`));
        }
        setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function startDaemon(): void {
  const root = process.env.ARTINAREY_ROOT
    ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(root, 'packages/cli/src/index.ts'), 'daemon', 'start'],
    { cwd: root, env: process.env, stdio: 'ignore', detached: true },
  );
  child.unref();
}

function isShimReply(value: unknown): value is ShimReply {
  return typeof value === 'object' && value !== null
    && typeof (value as ShimReply).text === 'string'
    && typeof (value as ShimReply).isError === 'boolean';
}

/**
 * One connection per agent session. Attaching once ties the connection's lifetime
 * to the session; the daemon releases the binding when this socket closes.
 */
export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
  const autoStart = options.autoStart ?? true;
  const timeoutMs = options.timeoutMs ?? 5000;
  let socket: Socket | undefined;
  let connecting: Promise<Socket> | undefined;
  let closed = false;
  let attached = false;
  const pending = new Map<string, {
    resolve: (response: RpcResponse) => void;
    reject: (err: Error) => void;
  }>();

  async function ensureConnected(): Promise<Socket> {
    if (closed) throw new Error('daemon client closed');
    if (socket && !socket.destroyed) return socket;
    if (!connecting) {
      connecting = (async () => {
        let connected: Socket;
        try {
          connected = await connectSocket(options.paths.socketPath);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (!autoStart || (code !== 'ENOENT' && code !== 'ECONNREFUSED')) throw err;
          startDaemon();
          connected = await waitForDaemon(options.paths.socketPath, timeoutMs);
        }

        connected.setEncoding('utf8');
        let buffer = '';
        connected.on('data', (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end);
            buffer = buffer.slice(end + 1);
            if (!line.trim()) continue;
            const id = JSON.parse(line).id as string;
            const waiting = pending.get(id);
            if (waiting) {
              pending.delete(id);
              waiting.resolve(JSON.parse(line) as RpcResponse);
            }
          }
        });
        connected.on('error', () => {
          // Pending calls are rejected by their timers; keep the process alive.
        });
        connected.on('close', () => {
          socket = undefined;
          attached = false;
          for (const waiting of pending.values()) {
            waiting.reject(new Error('daemon connection closed'));
          }
          pending.clear();
        });
        return connected;
      })().finally(() => { connecting = undefined; });
    }
    const connectionAttempt = connecting;
    const active = await connectionAttempt;
    if (closed) {
      active.destroy();
      throw new Error('daemon client closed');
    }
    socket = active;
    return active;
  }

  function request(active: Socket, method: string, params: Record<string, unknown>): Promise<RpcResponse> {
    return new Promise((resolvePromise, reject) => {
      const id = newId();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`daemon request timed out: ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve(response) {
          clearTimeout(timer);
          resolvePromise(response);
        },
        reject(err) {
          clearTimeout(timer);
          reject(err);
        },
      });
      active.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  return {
    async invoke(method, params) {
      try {
        const active = await ensureConnected();
        if (closed || socket !== active) {
          active.destroy();
          return { text: 'STORE_OFFLINE: daemon client closed', isError: true };
        }
        if (!attached) {
          const handshake = await request(active, 'attach', {
            cwd: options.cwd ?? process.cwd(),
            pid: options.pid ?? process.pid,
          });
          if (!handshake.ok) return { text: handshake.error.message, isError: true };
          attached = true;
        }
        const response = await request(active, method, params);
        if (!response.ok) return { text: response.error.message, isError: true };
        return isShimReply(response.result)
          ? response.result
          : { text: JSON.stringify(response.result), isError: false };
      } catch (err) {
        return { text: `STORE_OFFLINE: ${(err as Error).message}`, isError: true };
      }
    },
    close() {
      closed = true;
      attached = false;
      socket?.destroy();
      socket = undefined;
    },
  };
}
