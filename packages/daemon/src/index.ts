import { existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { ArtinareyError, newId, type XdgPaths } from '@artinarey/core';
import { acquireLock } from './lock.ts';
import { createRpcServer, type RpcResponse } from './server.ts';

export * from './lock.ts';
export * from './server.ts';

export function daemonPaths(paths: XdgPaths): { socketPath: string; lockFile: string } {
  return {
    socketPath: paths.socketPath,
    lockFile: join(dirname(paths.socketPath), 'daemon.pid'),
  };
}

export async function startDaemon(paths: XdgPaths): Promise<{ socketPath: string }> {
  const { socketPath, lockFile } = daemonPaths(paths);
  mkdirSync(dirname(socketPath), { recursive: true });
  const lock = acquireLock(lockFile);
  const server = createRpcServer(socketPath, () => lock.release());
  try {
    await server.start();
  } catch (err) {
    lock.release();
    throw err;
  }
  return { socketPath };
}

function rpcCall(socketPath: string, method: string, timeoutMs = 2000): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ArtinareyError('STORE_OFFLINE', 'daemon request timed out'));
    }, timeoutMs);

    socket.on('connect', () => socket.write(`${JSON.stringify({ id: newId(), method })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, end)) as RpcResponse);
      socket.end();
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
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
}
