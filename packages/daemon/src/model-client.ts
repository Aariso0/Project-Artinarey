import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelPromptInput } from './model-wire.ts';

export type ModelStatus = {
  state: 'not_configured' | 'starting' | 'ready' | 'offline';
  profile: string;
  model: string;
  hasKey: boolean;
  pid: number | null;
  error: string | null;
};

export type ModelResult = { text: string; done: boolean };

type AdapterReply =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } };

export type ModelSpawnFn = (
  command: string,
  args: string[],
  options: { env: Record<string, string | undefined>; stdio: 'ignore' },
) => ChildProcess;

export type ModelClientOptions = {
  socketPath: string;
  env?: Record<string, string | undefined>;
  /** Test seam: the fake adapter can be an in-process child or a stub. */
  spawn?: ModelSpawnFn;
  adapterFile?: string;
  readyTimeoutMs?: number;
  promptTimeoutMs?: number;
};

const ADAPTER_FILE = fileURLToPath(new URL('./model-adapter.ts', import.meta.url));

function isReply(value: unknown): value is AdapterReply {
  if (!value || typeof value !== 'object') return false;
  const reply = value as Record<string, unknown>;
  if (typeof reply.id !== 'string') return false;
  if (reply.ok === true) return 'result' in reply;
  return reply.ok === false && Boolean(
    reply.error && typeof reply.error === 'object'
    && typeof (reply.error as { code?: unknown }).code === 'string'
    && typeof (reply.error as { message?: unknown }).message === 'string',
  );
}

/**
 * Daemon side of M8. It never reads the key, never calls fetch, and only opens
 * a local unix socket to the adapter child it owns.
 */
export class ModelAdapterClient {
  private readonly socketPath: string;
  private readonly env: Record<string, string | undefined>;
  private readonly spawnFn: ModelSpawnFn;
  private readonly adapterFile: string;
  private readonly readyTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private child: ChildProcess | undefined;
  private current: ModelStatus;

  constructor(options: ModelClientOptions) {
    this.socketPath = options.socketPath;
    this.env = options.env ?? process.env;
    this.spawnFn = options.spawn ?? (spawn as unknown as ModelSpawnFn);
    this.adapterFile = options.adapterFile ?? ADAPTER_FILE;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
    this.promptTimeoutMs = options.promptTimeoutMs ?? 120_000;
    this.current = {
      state: 'not_configured', profile: 'openai-compatible', model: '',
      hasKey: false, pid: null, error: null,
    };
  }

  status(): ModelStatus {
    return { ...this.current };
  }

  private set(next: Partial<ModelStatus>): ModelStatus {
    this.current = { ...this.current, ...next };
    return this.status();
  }

  private get configured(): boolean {
    return Boolean(this.env.ARTINAREY_MODEL_BASE_URL?.trim());
  }

  async start(): Promise<ModelStatus> {
    if (!this.configured) return this.set({ state: 'not_configured', error: null });
    if (this.child && !this.child.killed) return this.status();

    mkdirSync(dirname(this.socketPath), { recursive: true });
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
    this.set({ state: 'starting', error: null });
    // The key stays in the inherited environment; this side never reads it.
    const child = this.spawnFn(process.execPath, ['--import', 'tsx', this.adapterFile], {
      env: { ...this.env, ARTINAREY_MODEL_SOCKET: this.socketPath },
      stdio: 'ignore',
    });
    this.child = child;
    child.once('error', (err) => {
      this.set({ state: 'offline', error: err.message, pid: null });
    });
    child.once('exit', () => {
      // A crashed child cannot clean up its own socket; leave no stale pid or
      // socket behind so callers get a typed offline error, not an OS error.
      if (this.child !== child) return;
      this.child = undefined;
      if (existsSync(this.socketPath)) {
        try { unlinkSync(this.socketPath); } catch { /* already removed */ }
      }
      if (this.current.state !== 'not_configured') {
        this.set({ state: 'offline', error: 'model adapter process exited', pid: null });
      }
    });

    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (!existsSync(this.socketPath)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      try {
        const reply = await this.call<{ running: boolean; profile: string; model: string; hasKey: boolean }>(
          'ping', {}, Math.min(2_000, this.readyTimeoutMs),
        );
        return this.set({
          state: reply.running ? 'ready' : 'offline',
          profile: reply.profile, model: reply.model, hasKey: reply.hasKey, error: null,
          pid: child.pid ?? null,
        });
      } catch {
        // The socket can appear before the listener is accepting; retry briefly.
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return this.set({ state: 'offline', error: 'model adapter did not become ready' });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      if (!stopped) child.kill('SIGKILL');
    }
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* already removed */ }
    }
    this.set({ state: 'not_configured', pid: null });
  }

  async prompt(input: ModelPromptInput): Promise<ModelResult> {
    if (this.current.state === 'not_configured') {
      throw Object.assign(new Error('model adapter is not configured'), {
        code: 'ADAPTER_OFFLINE',
      });
    }
    return this.call<ModelResult>('prompt', input, this.promptTimeoutMs);
  }

  private call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise<T>((resolve, reject) => {
      const socket: Socket = connect(this.socketPath);
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => {
        finish(new Error(`model adapter ${method} timed out`));
        socket.destroy();
      }, timeoutMs);
      const finish = (error: Error | undefined, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(Object.assign(error, {
          code: (error as { code?: string }).code ?? 'ADAPTER_OFFLINE',
        }));
        else resolve(value as T);
      };
      socket.setEncoding('utf8');
      socket.once('connect', () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf('\n');
        if (end === -1) return;
        try {
          const reply: unknown = JSON.parse(buffer.slice(0, end));
          if (!isReply(reply) || reply.id !== id) {
            finish(new Error('model adapter sent an invalid reply'));
          } else if (reply.ok) {
            finish(undefined, reply.result as T);
          } else {
            finish(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
          }
        } catch {
          finish(new Error('model adapter sent malformed JSON'));
        }
      });
      socket.on('error', (err) => finish(Object.assign(err, { code: 'ADAPTER_OFFLINE' })));
      socket.on('close', () => finish(new Error('model adapter closed the connection')));
    });
  }
}
