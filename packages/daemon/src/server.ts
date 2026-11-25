import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { authorizeOperator, isOperatorMethod } from './operator.ts';
import {
  dispatchTool, invalidateWorktree, isToolMethod, releaseConnection, type RpcContext,
} from './tools.ts';

export type RpcRequest = {
  id: string;
  method: string;
  params?: unknown;
  operatorToken?: string;
};
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

const SUPERVISOR_METHODS = new Set([
  'approvals', 'approval_status', 'approve', 'auto_approve', 'sessions', 'stop_session',
  'evaluate_permission',
]);

export function isSupervisorMethod(method: string): boolean {
  return SUPERVISOR_METHODS.has(method);
}

const MODEL_METHODS = new Set(['model_status', 'model_prompt']);

export function isModelMethod(method: string): boolean {
  return MODEL_METHODS.has(method);
}

/** Operator-only M8 controls; the key never crosses this boundary. */
export async function handleModelRequest(
  request: RpcRequest,
  ctx?: RpcContext,
): Promise<RpcResponse> {
  const model = ctx?.model;
  if (!model) {
    return {
      id: request.id, ok: false,
      error: { code: 'ADAPTER_OFFLINE', message: 'model adapter is unavailable' },
    };
  }
  const params = request.params && typeof request.params === 'object'
    ? request.params as Record<string, unknown> : {};
  try {
    if (request.method === 'model_status') {
      return { id: request.id, ok: true, result: model.status() };
    }
    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    if (!prompt) throw new Error('model_prompt needs a prompt');
    const result = await model.prompt({
      prompt,
      system: typeof params.system === 'string' ? params.system : undefined,
    });
    return { id: request.id, ok: true, result };
  } catch (err) {
    return {
      id: request.id, ok: false,
      error: {
        code: (err as { code?: string }).code ?? 'ADAPTER_OFFLINE',
        message: (err as Error).message ?? 'model adapter failed',
      },
    };
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** User/CLI-facing control methods. They never read a per-connection identity. */
export async function handleSupervisorRequest(
  request: RpcRequest,
  ctx?: RpcContext,
): Promise<RpcResponse> {
  const supervisor = ctx?.supervisor;
  if (!supervisor) {
    return {
      id: request.id, ok: false,
      error: { code: 'NO_PROJECT', message: 'session supervisor is unavailable' },
    };
  }
  const params = request.params && typeof request.params === 'object'
    ? request.params as Record<string, unknown> : {};
  try {
    switch (request.method) {
      case 'approvals':
        return {
          id: request.id, ok: true,
          result: { approvals: supervisor.approvals(str(params.projectId)) },
        };
      case 'approval_status': {
        const id = str(params.id);
        if (!id) throw new Error('approval_status needs an id');
        const approval = supervisor.approvals().find((a) => a.id === id);
        return {
          id: request.id, ok: true,
          result: { status: approval?.status ?? 'unknown', approval: approval ?? null },
        };
      }
      case 'approve': {
        const id = str(params.id);
        const by = str(params.by);
        if (!id || !by) throw new Error('approve needs an id and an actor');
        if (params.decision !== 'approved' && params.decision !== 'rejected') {
          throw new Error('approve needs a decision of approved or rejected');
        }
        const result = await supervisor.approve(id, params.decision, by);
        return { id: request.id, ok: true, result };
      }
      case 'auto_approve': {
        const worktreeId = str(params.worktreeId);
        if (!worktreeId || typeof params.enabled !== 'boolean') {
          throw new Error('auto_approve needs worktreeId and enabled');
        }
        supervisor.toggle(worktreeId, params.enabled);
        return { id: request.id, ok: true, result: { worktreeId, enabled: params.enabled } };
      }
      case 'sessions': {
        const projectId = str(params.projectId);
        if (!projectId) throw new Error('sessions needs a projectId');
        return { id: request.id, ok: true, result: { sessions: supervisor.sessions(projectId) } };
      }
      case 'stop_session': {
        const id = str(params.id);
        if (!id) throw new Error('stop_session needs an id');
        return { id: request.id, ok: true, result: { stopped: await supervisor.stopSession(id) } };
      }
      case 'evaluate_permission': {
        const projectId = str(params.projectId);
        const worktreeId = str(params.worktreeId);
        const sessionId = str(params.sessionId);
        if (!projectId || !worktreeId || !sessionId) {
          throw new Error('evaluate_permission needs projectId, worktreeId and sessionId');
        }
        return {
          id: request.id, ok: true,
          result: supervisor.evaluatePermission({
            projectId, worktreeId, sessionId,
            action: str(params.action),
            resources: Array.isArray(params.resources)
              ? params.resources.filter((r): r is string => typeof r === 'string') : [],
            command: str(params.command),
          }),
        };
      }
      default:
        return {
          id: request.id, ok: false,
          error: { code: 'NOT_FOUND', message: `unknown method: ${request.method}` },
        };
    }
  } catch (err) {
    return {
      id: request.id, ok: false,
      error: {
        code: (err as { code?: string }).code ?? 'INVALID_INPUT',
        message: (err as Error).message ?? 'request failed',
      },
    };
  }
}

async function dispatchRequest(
  request: RpcRequest,
  ctx?: RpcContext,
  shared?: RpcContext,
  operatorToken?: string,
): Promise<RpcResponse> {
  if (isOperatorMethod(request.method)
      && (!operatorToken || !authorizeOperator(request.operatorToken, operatorToken))) {
    return {
      id: request.id,
      ok: false,
      error: { code: 'FORBIDDEN', message: 'operator authorization required' },
    };
  }
  if (isControl(request.method)) return handleRequest(request);
  if (isModelMethod(request.method)) return handleModelRequest(request, ctx ?? shared);
  if (isSupervisorMethod(request.method)) return handleSupervisorRequest(request, ctx ?? shared);
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
  operatorToken?: string,
): RpcServer {
  let server: Server | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  const sockets = new Set<Socket>();
  const contexts = new Set<RpcContext>();
  const closed = new Set<Promise<void>>();
  const dispatches = new Set<Promise<void>>();

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
          const pending = queued.then(async () => {
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
                response = await dispatchRequest(request, ctx, shared, operatorToken);
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
          queued = pending;
          dispatches.add(pending);
          void pending.then(
            () => { dispatches.delete(pending); },
            () => { dispatches.delete(pending); },
          );
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
          // In-flight dispatch must settle before the registry closes.
          await Promise.allSettled([...dispatches]);
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
