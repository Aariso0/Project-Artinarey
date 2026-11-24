import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ArtinareyError, fileMode, newId, readServeState, serveStateFile, writeServeState, type ServeState,
} from '@artinarey/core';
import {
  OpencodeAdapter, type FetchFn, type HttpResponse, type SpawnFn, type SpawnedProcess,
} from './opencode.ts';
import { MODEL_KEY_ENV } from './model-wire.ts';

type Call = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

function setup() {
  const root = join(tmpdir(), `artinarey-adapter-${newId()}`);
  const logDir = join(root, 'logs');
  mkdirSync(logDir, { recursive: true });
  return { root, logDir, stateFile: serveStateFile(join(root, 'config')) };
}

function fakeFetch(handler: (call: Call) => { ok: boolean; status: number; body: unknown }): {
  fetchImpl: FetchFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: FetchFn = async (url, init) => {
    const call: Call = {
      url, method: init?.method, headers: init?.headers, body: init?.body, signal: init?.signal,
    };
    calls.push(call);
    const result = handler(call);
    return { ...result, json: async () => result.body };
  };
  return { fetchImpl, calls };
}

function fakeSpawn(pid = 4242): { spawnImpl: SpawnFn; calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> } {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const spawnImpl: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child: SpawnedProcess = {
      pid,
      once() { return child; },
      unref() { return child; },
    };
    return child;
  };
  return { spawnImpl, calls };
}

test('ensureServe reuses a live server without spawning', async () => {
  const s = setup();
  try {
    const state: ServeState = {
      pid: process.pid, port: 40123, password: 'pw', startedAt: 'old',
    };
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir,
      fetchImpl: fakeFetch(() => ({ ok: true, status: 200, body: {} })).fetchImpl,
      spawnImpl: fakeSpawn().spawnImpl,
    });
    // Seed the state by hand through the 0600 writer.
    writeServeState(s.stateFile, state);
    const result = await serve.ensureServe();
    assert.deepEqual(result, state);
    assert.equal(readServeState(s.stateFile)?.startedAt, 'old');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('ensureServe starts one loopback server, persists a 0600 handle, and binds the per-request directory', async () => {
  const s = setup();
  try {
    const { fetchImpl, calls } = fakeFetch((call) => ({
      ok: true, status: 200,
      body: call.url.endsWith('/api/info') ? { ok: true }
        : call.url.endsWith('/api/session') ? { id: 'vendor-session' } : {},
    }));
    const { spawnImpl, calls: spawns } = fakeSpawn(process.pid);
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir,
      fetchImpl, spawnImpl,
      pickPort: async () => 45678,
      password: () => 'secret',
      readyTimeoutMs: 100,
    });
    const state = await serve.ensureServe();
    assert.equal(state.pid, process.pid);
    assert.equal(state.port, 45678);
    assert.equal(state.password, 'secret');
    assert.equal(fileMode(s.stateFile), 0o600);
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0]!.command, 'opencode');
    assert.deepEqual(spawns[0]!.args, ['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    assert.equal((spawns[0]!.options.env as Record<string, string>).OPENCODE_PASSWORD, 'secret');
    assert.match(fetchCalls(calls, '/api/info')[0]!.headers?.Authorization ?? '', /^Basic /);

    const sessionId = await serve.createSession(state, '/worktrees/dev');
    assert.equal(sessionId, 'vendor-session');
    const create = fetchCalls(calls, '/api/session')[0]!;
    assert.equal(create.method, 'POST');
    assert.deepEqual(JSON.parse(create.body ?? '{}'), { location: { directory: '/worktrees/dev' } });

    await serve.sendPrompt(state, sessionId, 'hello', 'm1');
    const prompt = fetchCalls(calls, '/api/session/vendor-session/prompt')[0]!;
    assert.deepEqual(JSON.parse(prompt.body ?? '{}'), { id: 'm1', text: 'hello' });

    await serve.interrupt(state, sessionId);
    assert.equal(fetchCalls(calls, '/api/session/vendor-session/interrupt').length, 1);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a dead serve handle is replaced, not reused', async () => {
  const s = setup();
  try {
    writeServeState(s.stateFile, {
      pid: 99999999, port: 1, password: 'old', startedAt: 'old',
    });
    let started = 0;
    const { fetchImpl } = fakeFetch(() => {
      started++;
      return { ok: true, status: 200, body: {} };
    });
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir,
      fetchImpl, spawnImpl: fakeSpawn(process.pid).spawnImpl,
      pickPort: async () => 48000, password: () => 'fresh', readyTimeoutMs: 100,
    });
    const state = await serve.ensureServe();
    assert.equal(state.pid, process.pid);
    assert.equal(state.password, 'fresh');
    assert.ok(started >= 1);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('stopServe kills the recorded pid and clears the handle', async () => {
  const s = setup();
  try {
    writeServeState(s.stateFile, {
      pid: process.pid, port: 1, password: 'pw', startedAt: 'now',
    });
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir,
      fetchImpl: fakeFetch(() => ({ ok: true, status: 200, body: {} })).fetchImpl,
      spawnImpl: fakeSpawn().spawnImpl,
    });
    // Killing our own pid with signal 0 is a liveness probe, not a termination.
    const original = process.kill;
    let killed = 0;
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number) => {
      if (signal === undefined) killed++;
      return original(pid, signal ?? 0);
    }) as typeof process.kill;
    try {
      assert.equal(serve.stopServe(), true);
    } finally {
      (process as { kill: typeof process.kill }).kill = original;
    }
    assert.equal(killed, 1);
    assert.equal(readServeState(s.stateFile), undefined);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

function fetchCalls(calls: Call[], suffix: string): Call[] {
  return calls.filter((call) => call.url.endsWith(suffix));
}

function hangingFetch(onCall?: (init?: Parameters<FetchFn>[1]) => void): FetchFn {
  return (_url, init) => new Promise<HttpResponse>((_resolve, reject) => {
    if (init?.signal?.aborted) { reject(new Error('aborted')); return; }
    // Register before onCall: the callback may abort synchronously.
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    onCall?.(init);
  });
}

/** A fake child uses this process's live pid; suppress the real signal. */
async function withoutKill<T>(run: () => Promise<T>): Promise<T> {
  const original = process.kill;
  (process as { kill: typeof process.kill }).kill = (() => true) as typeof process.kill;
  try {
    return await run();
  } finally {
    (process as { kill: typeof process.kill }).kill = original;
  }
}

test('a hung readiness fetch is aborted at the deadline with a typed error', async () => {
  const s = setup();
  try {
    const signals: Array<AbortSignal | undefined> = [];
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir,
      fetchImpl: hangingFetch((init) => signals.push(init?.signal)),
      spawnImpl: fakeSpawn(process.pid).spawnImpl,
      pickPort: async () => 45679, password: () => 'pw', readyTimeoutMs: 40,
    });
    const started = Date.now();
    await withoutKill(() => assert.rejects(serve.ensureServe(), (err: unknown) => err instanceof ArtinareyError
      && err.code === 'STORE_OFFLINE' && /did not become ready/.test(err.message)));
    assert.ok(Date.now() - started < 1000, 'the deadline must bound the readiness check');
    assert.ok(signals.length > 0, 'readiness must pass a signal to fetch');
    assert.ok(signals.every((signal) => signal?.aborted === true));
    assert.equal(readServeState(s.stateFile), undefined);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('request fetches are bounded too and surface STORE_OFFLINE', async () => {
  const s = setup();
  try {
    const signals: Array<AbortSignal | undefined> = [];
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir,
      fetchImpl: hangingFetch((init) => signals.push(init?.signal)),
      readyTimeoutMs: 30,
    });
    await assert.rejects(
      serve.createSession({
        pid: process.pid, port: 45680, password: 'pw', startedAt: 'now',
      }, '/worktrees/dev'),
      (err: unknown) => err instanceof ArtinareyError
        && err.code === 'STORE_OFFLINE' && /aborted/.test(err.message),
    );
    assert.ok(signals.length > 0);
    assert.equal(signals[0]?.aborted, true);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('an async spawn error takes the STORE_OFFLINE launch failure path', async () => {
  const s = setup();
  try {
    let emitError: ((err: Error) => void) | undefined;
    const spawnImpl: SpawnFn = () => {
      const child: SpawnedProcess = {
        pid: process.pid,
        once(event, listener) {
          if (event === 'error') emitError = listener as (err: Error) => void;
          return child;
        },
        unref() { return child; },
      };
      return child;
    };
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir,
      fetchImpl: hangingFetch(() => emitError?.(new Error('spawn exploded'))),
      spawnImpl, pickPort: async () => 45681, password: () => 'pw', readyTimeoutMs: 1000,
    });
    await withoutKill(() => assert.rejects(serve.ensureServe(), (err: unknown) => err instanceof ArtinareyError
      && err.code === 'STORE_OFFLINE' && /spawn exploded/.test(err.message)));
    assert.equal(readServeState(s.stateFile), undefined);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a synchronous spawn throw is a typed launch failure', async () => {
  const s = setup();
  try {
    const spawnImpl: SpawnFn = () => { throw new Error('ENOENT opencode'); };
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir,
      fetchImpl: fakeFetch(() => ({ ok: true, status: 200, body: {} })).fetchImpl,
      spawnImpl, pickPort: async () => 45682, password: () => 'pw',
    });
    await assert.rejects(serve.ensureServe(), (err: unknown) => err instanceof ArtinareyError
      && err.code === 'STORE_OFFLINE' && /failed to spawn/.test(err.message));
    assert.equal(readServeState(s.stateFile), undefined);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a state write failure kills the spawned child and surfaces STORE_OFFLINE', async () => {
  const s = setup();
  try {
    const { fetchImpl } = fakeFetch(() => ({ ok: true, status: 200, body: {} }));
    const { spawnImpl } = fakeSpawn(process.pid);
    let unrefCalls = 0;
    const trackedSpawn: SpawnFn = (command, args, options) => {
      const child = spawnImpl(command, args, options);
      return { ...child, unref() { unrefCalls++; return child; } };
    };
    const killed: number[] = [];
    const original = process.kill;
    (process as { kill: typeof process.kill }).kill = ((pid: number, signal?: number) => {
      if (signal === undefined) killed.push(pid);
      return true;
    }) as typeof process.kill;
    try {
      const serve = new OpencodeAdapter({
        stateFile: s.stateFile, logDir: s.logDir, fetchImpl, spawnImpl: trackedSpawn,
        writeStateImpl: () => { throw new Error('state write failed'); },
        pickPort: async () => 45686, password: () => 'pw', readyTimeoutMs: 100,
      });
      await assert.rejects(serve.ensureServe(), (err: unknown) => err instanceof ArtinareyError
        && err.code === 'STORE_OFFLINE' && /state write failed/.test(err.message));
    } finally {
      (process as { kill: typeof process.kill }).kill = original;
    }
    assert.deepEqual(killed, [process.pid]);
    assert.equal(unrefCalls, 0);
    assert.equal(readServeState(s.stateFile), undefined);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('concurrent ensureServe calls share one start and the guard clears', async () => {
  const s = setup();
  try {
    const { fetchImpl } = fakeFetch(() => ({ ok: true, status: 200, body: {} }));
    const { spawnImpl, calls: spawns } = fakeSpawn(process.pid);
    let releasePort!: (port: number) => void;
    let portCalls = 0;
    const pickPort = () => {
      portCalls++;
      return portCalls === 1
        ? new Promise<number>((resolve) => { releasePort = resolve; })
        : Promise.resolve(45685);
    };
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir, fetchImpl, spawnImpl, pickPort,
      password: () => 'pw', readyTimeoutMs: 100,
    });
    const first = serve.ensureServe();
    const second = serve.ensureServe();
    releasePort(45683);
    const [one, two] = await Promise.all([first, second]);
    assert.strictEqual(one, two);
    assert.equal(spawns.length, 1);

    // Once settled, a dead handle may start a fresh server again.
    writeServeState(s.stateFile, {
      pid: 99999999, port: 1, password: 'old', startedAt: 'old',
    });
    await serve.ensureServe();
    assert.equal(spawns.length, 2);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('opencode serve never inherits ARTINAREY_MODEL_KEY', async () => {
  const s = setup();
  try {
    const { fetchImpl } = fakeFetch(() => ({ ok: true, status: 200, body: {} }));
    const { spawnImpl, calls: spawns } = fakeSpawn(process.pid);
    const serve = new OpencodeAdapter({
      stateFile: s.stateFile, logDir: s.logDir, fetchImpl, spawnImpl,
      env: { PATH: process.env.PATH ?? '', [MODEL_KEY_ENV]: 'secret-in-adapter-only' },
      pickPort: async () => 45687, password: () => 'pw', readyTimeoutMs: 100,
    });
    await withoutKill(() => serve.ensureServe());
    const env = spawns[0]?.options.env as Record<string, string | undefined>;
    assert.equal(env[MODEL_KEY_ENV], undefined);
    assert.equal(env.OPENCODE_PASSWORD, 'pw');
    assert.equal(env.PATH, process.env.PATH ?? '');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('interruptSession uses the persisted serve state', async () => {
  const s = setup();
  try {
    const { fetchImpl, calls } = fakeFetch(() => ({ ok: true, status: 200, body: {} }));
    const serve = new OpencodeAdapter({ stateFile: s.stateFile, logDir: s.logDir, fetchImpl });
    writeServeState(s.stateFile, {
      pid: process.pid, port: 45684, password: 'pw', startedAt: 'now',
    });
    await serve.interruptSession('session 1');
    const interrupt = fetchCalls(calls, '/api/session/session%201/interrupt')[0]!;
    assert.equal(interrupt.method, 'POST');
    assert.deepEqual(JSON.parse(interrupt.body ?? '{}'), {});

    rmSync(s.stateFile, { force: true });
    await assert.rejects(serve.interruptSession('session 1'), (err: unknown) => err instanceof ArtinareyError
      && err.code === 'STORE_OFFLINE' && /not running/.test(err.message));
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});
