import { existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import {
  ArtinareyError, newId, openRegistry, type Registry, type XdgPaths,
} from '@artinarey/core';
import { acquireLock } from './lock.ts';
import { createRpcServer, type RpcResponse } from './server.ts';

export * from './lock.ts';
export * from './server.ts';
export * from './tools.ts';

export function daemonPaths(paths: XdgPaths): { socketPath: string; lockFile: string } {
  return {
    socketPath: paths.socketPath,
    lockFile: join(dirname(paths.socketPath), 'daemon.pid'),
  };
}

export async function startDaemon(paths: XdgPaths): Promise<{ socketPath: string }> {
  const { socketPath, lockFile } = daemonPaths(paths);
  mkdirSync(dirname(socketPath), { recursive: true });
  const lock = await acquireLock(lockFile);
  let registry: Registry | undefined;
  try {
    registry = openRegistry(paths.registryFile);
    const opened = registry;
    const server = createRpcServer(socketPath, () => {
      lock.release();
      opened.close();
    }, { registry: opened, paths });
    await server.start();
    return { socketPath };
  } catch (err) {
    lock.release();
    registry?.close();
    throw err;
  }
}

function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== 'object') return false;
  const response = value as Record<string, unknown>;
  if (typeof response.id !== 'string') return false;
  if (response.ok === true) return 'result' in response;
  if (response.ok === false) {
    const error = response.error as Record<string, unknown> | undefined;
    return Boolean(error && typeof error.code === 'string' && typeof error.message === 'string');
  }
  return false;
}

function rpcCall(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 2000,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ArtinareyError('STORE_OFFLINE', 'daemon request timed out'));
    }, timeoutMs);

    socket.on('connect', () => socket.write(`${JSON.stringify({ id: newId(), method, params })}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      clearTimeout(timer);
      try {
        const parsed: unknown = JSON.parse(buffer.slice(0, end));
        if (!isRpcResponse(parsed)) throw new ArtinareyError('STORE_OFFLINE', 'invalid RPC reply');
        resolve(parsed);
      } catch (err) {
        reject(err instanceof Error ? err : new ArtinareyError('STORE_OFFLINE', 'invalid RPC reply'));
      } finally {
        socket.destroy();
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      reject(new ArtinareyError('STORE_OFFLINE', 'daemon closed the connection'));
    });
  });
}

/** Generic call used by CLI commands such as `release --force`. */
export function callDaemon(
  paths: XdgPaths,
  method: string,
  params: Record<string, unknown> = {},
): Promise<RpcResponse> {
  return rpcCall(daemonPaths(paths).socketPath, method, params);
}

export async function daemonStatus(paths: XdgPaths): Promise<unknown | undefined> {
  const { socketPath } = daemonPaths(paths);
  try {
    const response = await rpcCall(socketPath, 'status');
    return response.ok ? response.result : undefined;
  } catch {
    return undefined;
  }
}

export async function stopDaemon(paths: XdgPaths): Promise<void> {
  const { socketPath } = daemonPaths(paths);
  const response = await rpcCall(socketPath, 'shutdown');
  if (!response.ok) throw new ArtinareyError('STORE_OFFLINE', response.error.message);
  for (let i = 0; i < 50 && existsSync(socketPath); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (existsSync(socketPath)) {
    throw new ArtinareyError('STORE_OFFLINE', `daemon did not stop; socket still exists: ${socketPath}`);
  }
}
