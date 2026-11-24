import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fileMode, newId, readServeState, serveStateFile, writeServeState, type ServeState,
} from '@artinarey/core';
import {
  OpencodeAdapter, type FetchFn, type SpawnFn, type SpawnedProcess,
} from './opencode.ts';

type Call = { url: string; method?: string; headers?: Record<string, string>; body?: string };

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
      url, method: init?.method, headers: init?.headers, body: init?.body,
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
