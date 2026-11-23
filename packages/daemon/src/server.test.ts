import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Registry, XdgPaths } from '@artinarey/core';
import { createRpcServer, handleRequest, type RpcResponse } from './server.ts';

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
  const server = createRpcServer(path);
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

    const shutdown = await rpc(path, { id: '3', method: 'shutdown' });
    assert.equal(shutdown.ok, true);
    await waitFor(() => !existsSync(path));
    assert.equal(existsSync(path), false, 'shutdown RPC actually closes the listener');
  } finally {
    await server.close();
  }
});

test('an invalid shutdown request leaves the listener running', async () => {
  const path = socketPath();
  const server = createRpcServer(path);
  try {
    await server.start();
    const response = await rpc(path, { method: 'shutdown' });
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
