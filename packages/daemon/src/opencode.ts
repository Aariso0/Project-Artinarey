import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  ArtinareyError, isProcessAlive, readServeState, writeServeState, type ServeState,
} from '@artinarey/core';

/**
 * One `opencode serve` per daemon, reached over REST with fetch and Basic auth
 * (fixed username `opencode`, password from OPENCODE_PASSWORD). No SDK: the
 * typed client's session.create() cannot pass `location.directory`, which is
 * required so one server can handle many worktrees. The server process is
 * detached; the registry, not OpenCode's session list, is the source of truth.
 */

export type HttpResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type FetchFn = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<HttpResponse>;

export type SpawnedProcess = {
  pid?: number;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  unref?(): unknown;
};

export type SpawnFn = (
  command: string,
  args: string[],
  options: Record<string, unknown>,
) => SpawnedProcess;

export type OpencodeAdapterOptions = {
  stateFile: string;
  logDir: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchFn;
  spawnImpl?: SpawnFn;
  pickPort?: () => Promise<number>;
  password?: () => string;
  readyTimeoutMs?: number;
};

function authHeader(password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new ArtinareyError('STORE_OFFLINE', 'could not reserve a loopback port');
  return port;
}

export class OpencodeAdapter {
  private readonly stateFile: string;
  private readonly logDir: string;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchFn;
  private readonly spawnImpl: SpawnFn;
  private readonly pickPort: () => Promise<number>;
  private readonly password: () => string;
  private readonly readyTimeoutMs: number;

  constructor(options: OpencodeAdapterOptions) {
    this.stateFile = options.stateFile;
    this.logDir = options.logDir;
    this.command = options.command ?? 'opencode';
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? (fetch as FetchFn);
    this.spawnImpl = options.spawnImpl ?? (spawn as unknown as SpawnFn);
    this.pickPort = options.pickPort ?? freePort;
    this.password = options.password ?? (() => randomBytes(24).toString('hex'));
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5000;
  }

  private base(state: ServeState): string {
    return `http://127.0.0.1:${state.port}`;
  }

  async reachable(state: ServeState): Promise<boolean> {
    if (!isProcessAlive(state.pid)) return false;
    try {
      const response = await this.fetchImpl(`${this.base(state)}/api/info`, {
        headers: authHeader(state.password),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Reuse a live server, otherwise start a new one and persist its handle. */
  async ensureServe(): Promise<ServeState> {
    const existing = readServeState(this.stateFile);
    if (existing && await this.reachable(existing)) return existing;
    const port = await this.pickPort();
    const password = this.password();
    const log = join(this.logDir, 'opencode-serve.log');
    const logFd = openSync(log, 'a');
    let child: SpawnedProcess;
    try {
      child = this.spawnImpl(this.command,
        ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
        {
          cwd: this.logDir,
          env: { ...this.env, OPENCODE_PASSWORD: password },
          stdio: ['ignore', logFd, logFd],
          detached: true,
        });
    } finally {
      // The child inherits its own descriptor after spawn; the parent closes its copy.
      closeSync(logFd);
    }
    if (!child.pid) throw new ArtinareyError('STORE_OFFLINE', 'opencode serve did not report a pid');
    const state: ServeState = {
      pid: child.pid, port, password, startedAt: new Date().toISOString(),
    };
    const deadline = Date.now() + this.readyTimeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      if (await this.reachable(state)) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!ready) {
      try { process.kill(child.pid); } catch { /* it may already be gone */ }
      throw new ArtinareyError('STORE_OFFLINE', 'opencode serve did not become ready');
    }
    writeServeState(this.stateFile, state);
    child.unref?.();
    return state;
  }

  private async request(
    state: ServeState,
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.fetchImpl(`${this.base(state)}${path}`, {
      method,
      headers: { ...authHeader(state.password), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new ArtinareyError('STORE_OFFLINE',
        `opencode ${method} ${path} failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  /** The directory travels in the body; the SDK's create() has no such field. */
  async createSession(state: ServeState, directory: string): Promise<string> {
    const result = await this.request(state, '/api/session', 'POST', {
      location: { directory },
    }) as { id?: unknown };
    if (typeof result?.id !== 'string' || !result.id) {
      throw new ArtinareyError('STORE_OFFLINE', 'opencode did not return a session id');
    }
    return result.id;
  }

  async sendPrompt(state: ServeState, sessionId: string, text: string, id?: string): Promise<void> {
    await this.request(state, `/api/session/${encodeURIComponent(sessionId)}/prompt`, 'POST', {
      ...(id ? { id } : {}), text,
    });
  }

  async interrupt(state: ServeState, sessionId: string): Promise<void> {
    await this.request(state, `/api/session/${encodeURIComponent(sessionId)}/interrupt`, 'POST', {});
  }

  /** Operator-only teardown of the shared server; daemon shutdown leaves it detached. */
  stopServe(): boolean {
    const state = readServeState(this.stateFile);
    if (!state) return false;
    try {
      process.kill(state.pid);
    } catch {
      // Already gone.
    }
    rmSync(this.stateFile, { force: true });
    return true;
  }
}
