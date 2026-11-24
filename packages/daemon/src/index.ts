import { existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import {
  ArtinareyError, loadConfig, newId, openRegistry, serveStateFile,
  type Registry, type XdgPaths,
} from '@artinarey/core';
import { startGuiHttpServer, type GuiHttpServer } from './http.ts';
import { acquireLock } from './lock.ts';
import { ModelAdapterClient } from './model-client.ts';
import { isOperatorMethod, loadOrCreateOperatorToken } from './operator.ts';
import { OpencodeAdapter } from './opencode.ts';
import { createRpcServer, type RpcResponse, type RpcServer } from './server.ts';
import { SessionSupervisor } from './sessions.ts';
import type { RpcContext } from './tools.ts';

export * from './lock.ts';
export * from './operator.ts';
export * from './server.ts';
export * from './tools.ts';
export * from './gui.ts';
export * from './http.ts';
export * from './opencode.ts';
export * from './sessions.ts';
export * from './model-client.ts';

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
  let server: RpcServer | undefined;
  let gui: GuiHttpServer | undefined;
  let model: ModelAdapterClient | undefined;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    lock.release();
    registry?.close();
  };
  try {
    registry = openRegistry(paths.registryFile);
    const opened = registry;
    const logDir = join(paths.cacheRoot, 'logs');
    mkdirSync(logDir, { recursive: true });
    const adapter = new OpencodeAdapter({
      stateFile: serveStateFile(paths.configDir),
      logDir,
      env: process.env,
    });
    const supervisor = new SessionSupervisor({
      registry: opened,
      paths,
      adapter,
      rolesDir: process.env.ARTINAREY_ROLES_DIR ?? join(paths.configDir, 'roles'),
      spawnCap: loadConfig(join(paths.configDir, 'config.json')).spawnCap,
    });
    supervisor.adopt();
    model = new ModelAdapterClient({ socketPath: join(paths.configDir, 'model-adapter.sock') });
    const ctx: RpcContext = { registry: opened, paths, supervisor, model };
    const operatorToken = loadOrCreateOperatorToken(paths);
    server = createRpcServer(socketPath, () => {
      const guiClose = gui?.close();
      if (guiClose) {
        void guiClose.catch((err) => {
          console.error(`GUI server shutdown failed: ${(err as Error).message ?? String(err)}`);
        });
      }
      void model?.stop().catch((err) => {
        console.error(`Model adapter shutdown failed: ${(err as Error).message ?? String(err)}`);
      });
      cleanup();
    }, ctx, undefined, operatorToken);
    await server.start();
    gui = await startGuiHttpServer(paths, ctx);
    await model!.start();
    return { socketPath };
  } catch (err) {
    await model?.stop();
    await gui?.close();
    if (server) await server.close();
    cleanup();
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
  operatorToken?: string,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ArtinareyError('STORE_OFFLINE', 'daemon request timed out'));
    }, timeoutMs);

    socket.on('connect', () => socket.write(`${JSON.stringify({
      id: newId(), method, params, operatorToken,
    })}\n`));
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
  timeoutMs = 2000,
): Promise<RpcResponse> {
  const operatorToken = isOperatorMethod(method)
    ? loadOrCreateOperatorToken(paths) : undefined;
  return rpcCall(daemonPaths(paths).socketPath, method, params, timeoutMs, operatorToken);
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
  const response = await rpcCall(
    socketPath, 'shutdown', {}, 2000, loadOrCreateOperatorToken(paths),
  );
  if (!response.ok) throw new ArtinareyError('STORE_OFFLINE', response.error.message);
  for (let i = 0; i < 50 && existsSync(socketPath); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (existsSync(socketPath)) {
    throw new ArtinareyError('STORE_OFFLINE', `daemon did not stop; socket still exists: ${socketPath}`);
  }
}
