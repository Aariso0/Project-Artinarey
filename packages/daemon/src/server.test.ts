import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Registry, XdgPaths } from '@artinarey/core';
import { createRpcServer, handleRequest, type RpcResponse } from './server.ts';
import type { RpcContext } from './tools.ts';

const OPERATOR_TOKEN = 'test-operator-token';

function socketPath(): string {
  return join(tmpdir(), `artinarey-sock-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met before deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rawRpc(path: string, line: string): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) reject(new Error('RPC timed out'));
    }, 2000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${line}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1 || settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, end)) as RpcResponse);
      } catch (err) {
        reject(err);
      }
      socket.destroy();
    });
    socket.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
  });
}

function rpc(path: string, request: unknown): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      fail(new Error('RPC timed out'));
    }, 2000);
    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(buffer.slice(0, end)) as RpcResponse);
      } catch (err) {
        reject(err);
      }
      socket.destroy();
    });
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('socket closed before a reply')));
  });
}

test('handleRequest answers ping, status, and unknown methods', () => {
  const ping = handleRequest({ id: '1', method: 'ping' });
  assert.equal(ping.ok, true);
  if (ping.ok) assert.equal((ping.result as { pong: boolean }).pong, true);

  const status = handleRequest({ id: '2', method: 'status' });
  assert.equal(status.ok, true);

  const unknown = handleRequest({ id: '3', method: 'nope' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'NOT_FOUND');
});

test('server answers over a unix socket with mode 0600 and shutdown closes it', async () => {
  const path = socketPath();
  const server = createRpcServer(path, undefined, undefined, undefined, OPERATOR_TOKEN);
  try {
    await server.start();
    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600, 'socket mode must be 0600');

    const pong = await rpc(path, { id: '1', method: 'ping' });
    assert.equal(pong.id, '1');
    assert.equal(pong.ok, true);
    if (pong.ok) assert.equal((pong.result as { pid: number }).pid, process.pid);

    const unknown = await rpc(path, { id: '2', method: 'missing' });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, 'NOT_FOUND');

    const shutdown = await rpc(path, {
      id: '3', method: 'shutdown', operatorToken: OPERATOR_TOKEN,
    });
    assert.equal(shutdown.ok, true);
    await waitFor(() => !existsSync(path));
    assert.equal(existsSync(path), false, 'shutdown RPC actually closes the listener');
  } finally {
    await server.close();
  }
});

test('an invalid shutdown request leaves the listener running', async () => {
  const path = socketPath();
  const server = createRpcServer(path, undefined, undefined, undefined, OPERATOR_TOKEN);
  try {
    await server.start();
    const response = await rpc(path, { method: 'shutdown', operatorToken: OPERATOR_TOKEN });
    assert.equal(response.ok, false);
    if (!response.ok) assert.equal(response.error.code, 'INVALID_INPUT');

    const ping = await rpc(path, { id: '2', method: 'ping' });
    assert.equal(ping.ok, true);
    assert.equal(existsSync(path), true);
  } finally {
    await server.close();
  }
});

test('a connection cleanup failure does not hang server.close', async () => {
  const path = socketPath();
  const registry = {
    bindings: { forWorktree() { throw new Error('cleanup boom'); } },
  } as unknown as Registry;
  const server = createRpcServer(path, undefined, {
    registry, paths: {} as XdgPaths,
    claimedBindings: [{ personaId: 'p', storeDir: '/tmp', worktreeId: 'w' }],
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await server.start();
    const client = connect(path);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.on('error', () => {});
    client.destroy();
    await server.close();
  } finally {
    console.error = originalError;
  }
});

test('a dispatch exception replies with the parsed request id, not invalid', async () => {
  const path = socketPath();
  const registry = {
    personas: { list() { throw new Error('dispatch boom'); } },
  } as unknown as Registry;
  const server = createRpcServer(path, undefined, {
    registry, paths: {} as XdgPaths,
    identity: {
      projectId: 'p', worktreeId: 'w', markerDir: '/tmp', storeDir: '/tmp',
      personaId: 'x', role: 'dev',
    },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await server.start();
    const response = await rpc(path, { id: 'req-7', method: 'check_in' });
    assert.equal(response.ok, false);
    assert.equal(response.id, 'req-7', 'a dispatch failure must stay matched to its request');
    if (!response.ok) assert.match(response.error.message, /dispatch boom/);
    // Only a JSON parse failure keeps the reserved id.
    const malformed = await rawRpc(path, '{not json');
    assert.equal(malformed.id, 'invalid');
  } finally {
    console.error = originalError;
    await server.close();
  }
});

test('close runs onShutdown even when the socket cannot be unlinked', async () => {
  const path = socketPath();
  let shutdownCalls = 0;
  const server = createRpcServer(path, () => { shutdownCalls++; });
  await server.start();
  // A directory cannot be unlinked: this forces the failure after server.close().
  rmSync(path);
  mkdirSync(path);
  try {
    await assert.rejects(() => server.close(), (err: NodeJS.ErrnoException) => {
      assert.ok(err.code === 'EISDIR' || err.code === 'EPERM' || err.code === 'EISFAULT');
      return true;
    });
    assert.equal(shutdownCalls, 1, 'the callback must run even when unlink fails');
  } finally {
    rmSync(path, { recursive: true, force: true });
    await server.close().catch(() => {});
  }
});

test('a client socket error does not terminate the daemon', async () => {
  const path = socketPath();
  const server = createRpcServer(path);
  try {
    await server.start();
    const client = connect(path);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    });
    client.on('error', () => {});
    const gone = new Promise<void>((resolve) => client.once('close', resolve));
    client.destroy(new Error('client-side failure'));
    await gone;

    const pong = await rpc(path, { id: '1', method: 'ping' });
    assert.equal(pong.ok, true);
  } finally {
    await server.close();
  }
});

test('close waits for a queued stop_session before onShutdown', async () => {
  const path = socketPath();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let releaseInterrupt!: () => void;
  let interruptSettled = false;
  const interrupt = new Promise<boolean>((resolve) => {
    releaseInterrupt = () => { interruptSettled = true; resolve(true); };
  });
  const order: string[] = [];
  let shutdownCalls = 0;
  let shutdownSawSettled = false;
  const shared = {
    registry: {} as Registry,
    paths: {} as XdgPaths,
    supervisor: {
      stopSession: () => { markStarted(); return interrupt; },
    },
  } as unknown as RpcContext;
  const server = createRpcServer(
    path,
    () => {
      shutdownCalls++;
      shutdownSawSettled = interruptSettled;
      order.push('shutdown');
    },
    shared,
    () => { order.push('connection-closed'); },
    OPERATOR_TOKEN,
  );
  await server.start();
  const client = connect(path);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
  client.on('error', () => {});
  try {
    client.write(`${JSON.stringify({
      id: 'stop-1', method: 'stop_session', params: { id: 's1' },
      operatorToken: OPERATOR_TOKEN,
    })}\n`);
    await started;
    const closing = server.close();
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(shutdownCalls, 0, 'onShutdown must wait for the queued stop_session');
    } finally {
      releaseInterrupt();
      await closing;
    }
    assert.equal(shutdownCalls, 1);
    assert.equal(shutdownSawSettled, true, 'the interrupt must settle before registry shutdown');
    assert.deepEqual(order, ['connection-closed', 'shutdown']);
  } finally {
    client.destroy();
    await server.close().catch(() => {});
  }
});
