import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRpcServer, handleRequest, type RpcResponse } from './server.ts';

function socketPath(): string {
  return join(tmpdir(), `artinarey-sock-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
}

function rpc(path: string, request: unknown): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      resolve(JSON.parse(buffer.slice(0, end)) as RpcResponse);
      socket.end();
    });
    socket.on('error', reject);
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
  await server.start();
  assert.equal(existsSync(path), true);

  const pong = await rpc(path, { id: '1', method: 'ping' });
  assert.equal(pong.id, '1');
  assert.equal(pong.ok, true);
  if (pong.ok) assert.equal((pong.result as { pid: number }).pid, process.pid);

  const unknown = await rpc(path, { id: '2', method: 'missing' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'NOT_FOUND');

  await rpc(path, { id: '3', method: 'shutdown' });
  await server.close();
  assert.equal(existsSync(path), false);
});
