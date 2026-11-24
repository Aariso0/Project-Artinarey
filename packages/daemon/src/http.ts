import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { XdgPaths } from '@artinarey/core';
import { handleGuiRequest } from './gui.ts';
import type { RpcRequest, RpcResponse } from './server.ts';
import type { RpcContext } from './tools.ts';

export type GuiHttpServer = {
  port: number;
  close(): Promise<void>;
};

type Envelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

const MAX_BODY_BYTES = 1024 * 1024;
const BEARER_PREFIX = 'Bearer ';

const STATUS_BY_CODE: Record<string, number> = {
  AUTH_FAILED: 401,
  BAD_HOST: 400,
  BAD_ORIGIN: 400,
  BODY_TOO_LARGE: 413,
  DAEMON_UNREACHABLE: 502,
  BAD_RESPONSE: 502,
  INVALID_REQUEST: 400,
  MAIL_REJECTED: 400,
  FORBIDDEN_METHOD: 403,
  FORBIDDEN_ROLE: 403,
  NOT_FOUND: 404,
  DIRECTORY_BUSY: 409,
  MOVE_CHANGED: 409,
  NEEDS_CONFIRMATION: 409,
  WORKTREE_BLOCKED: 409,
  MAIL_PARTIAL: 409,
  STORE_OFFLINE: 503,
  ADAPTER_OFFLINE: 503,
  INTERNAL_ERROR: 500,
};

function envelope(response: RpcResponse): Envelope {
  return response.ok
    ? { ok: true, result: response.result }
    : { ok: false, error: response.error };
}

function fail(code: string, message: string): Envelope {
  return { ok: false, error: { code, message } };
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** Hash both inputs so timingSafeEqual receives equal-length buffers for any input. */
function tokenMatches(provided: string, expected: string): boolean {
  const supplied = createHash('sha256').update(provided).digest();
  const configured = createHash('sha256').update(expected).digest();
  return timingSafeEqual(supplied, configured);
}

function nativeOrigins(): Set<string> {
  return process.platform === 'win32' || process.platform === 'android'
    ? new Set(['http://tauri.localhost', 'https://tauri.localhost'])
    : new Set(['tauri://localhost']);
}

function validHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function send(res: ServerResponse, payload: Envelope, req?: IncomingMessage): void {
  if (res.headersSent || res.writableEnded) return;
  const status = payload.ok ? 200 : STATUS_BY_CODE[payload.error.code] ?? 500;
  const body = JSON.stringify(payload);
  const headers: Record<string, string | number> = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  // An early rejection can leave request bytes unread; do not reuse that socket.
  if (req && !req.complete) headers.Connection = 'close';
  res.writeHead(status, headers);
  res.end(body);
  if (req && !req.complete) req.resume();
}

/** The token persists across restarts; only its first creation is random. */
function readOrCreateToken(paths: XdgPaths): string {
  mkdirSync(dirname(paths.tokenFile), { recursive: true });
  if (!existsSync(paths.tokenFile)) {
    try {
      writeFileSync(paths.tokenFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      // A concurrent starter may have won the create race; its token is authoritative.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  chmodSync(paths.tokenFile, 0o600);
  return readFileSync(paths.tokenFile, 'utf8').trim();
}

function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
  return new Promise((resolve) => {
    const declared = header(req.headers, 'content-length');
    if (declared !== undefined) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
        send(res, fail('BODY_TOO_LARGE', 'request body exceeds 1 MiB'), req);
        resolve(undefined);
        return;
      }
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let oversized = false;
    req.on('data', (chunk: Buffer | string) => {
      if (oversized) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_BODY_BYTES) {
        oversized = true;
        send(res, fail('BODY_TOO_LARGE', 'request body exceeds 1 MiB'), req);
        resolve(undefined);
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!oversized) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (!oversized) {
        send(res, fail('INVALID_REQUEST', 'request body could not be read'), req);
        resolve(undefined);
      }
    });
  });
}

function parseRequest(raw: string): RpcRequest {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request must be a JSON object');
  }
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.method !== 'string') {
    throw new Error('method must be a string');
  }
  const id = typeof candidate.id === 'string' ? candidate.id : '';
  return { id, method: candidate.method, params: candidate.params };
}

async function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  ctx: RpcContext,
  port: number,
): Promise<void> {
  const authorization = header(req.headers, 'authorization');
  if (!authorization || !authorization.startsWith(BEARER_PREFIX)
      || !tokenMatches(authorization.slice(BEARER_PREFIX.length), token)) {
    send(res, fail('AUTH_FAILED', 'invalid bearer token'), req);
    return;
  }
  if (!validHost(header(req.headers, 'host'), port)) {
    send(res, fail('BAD_HOST', 'Host must be a loopback address on the daemon port'), req);
    return;
  }
  const origin = header(req.headers, 'origin');
  if (!origin || !nativeOrigins().has(origin)) {
    send(res, fail('BAD_ORIGIN', 'Origin is not allowed on the GUI surface'), req);
    return;
  }

  const raw = await readBody(req, res);
  if (raw === undefined) return;

  let request: RpcRequest;
  try {
    request = parseRequest(raw);
  } catch (err) {
    send(res, fail('INVALID_REQUEST', err instanceof Error ? err.message : 'invalid request'), req);
    return;
  }
  // Method names are checked only after auth, headers and body size are settled.
  if (!request.method.startsWith('gui.')) {
    send(res, fail('FORBIDDEN_METHOD', `method not allowed on the GUI surface: ${request.method}`), req);
    return;
  }
  try {
    send(res, envelope(await handleGuiRequest(request, ctx)), req);
  } catch (err) {
    send(res, fail('INTERNAL_ERROR', err instanceof Error ? err.message : 'request failed'), req);
  }
}

/**
 * Loopback-only HTTP surface for the native shell. Agent tools stay on the unix socket.
 */
export async function startGuiHttpServer(paths: XdgPaths, ctx: RpcContext): Promise<GuiHttpServer> {
  const token = readOrCreateToken(paths);
  let port = 0;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    if (closing) {
      send(res, fail('INTERNAL_ERROR', 'daemon is shutting down'), req);
      return;
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      if (!validHost(header(req.headers, 'host'), port)) {
        send(res, fail('BAD_HOST', 'Host must be a loopback address on the daemon port'), req);
        return;
      }
      send(res, { ok: true, result: { running: true } }, req);
      return;
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      // handleRpc checks token, Host, Origin, body size and method name in that order.
      void handleRpc(req, res, token, ctx, port).catch((err) => {
        send(res, fail('INTERNAL_ERROR', err instanceof Error ? err.message : 'request failed'), req);
      });
      return;
    }
    if (!validHost(header(req.headers, 'host'), port)) {
      send(res, fail('BAD_HOST', 'Host must be a loopback address on the daemon port'), req);
      return;
    }
    send(res, fail('NOT_FOUND', `unknown endpoint: ${req.method ?? 'GET'} ${req.url ?? '/'}`), req);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('GUI server did not bind an OS-assigned port'));
        return;
      }
      port = address.port;
      try {
        mkdirSync(paths.configDir, { recursive: true });
        writeFileSync(join(paths.configDir, 'daemon.json'), `${JSON.stringify({ port })}\n`);
      } catch (err) {
        server.close();
        reject(err);
        return;
      }
      resolve();
    });
  });

  return {
    port,
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = new Promise<void>((resolve) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => resolve());
        });
      }
      return closePromise;
    },
  };
}
