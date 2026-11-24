import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  newId, resolveXdgPaths, type XdgPaths,
} from '@artinarey/core';
import { stopDaemon } from './index.ts';
import { loadOrCreateOperatorToken, operatorTokenPath } from './operator.ts';
import { createRpcServer, type RpcResponse, type RpcServer } from './server.ts';
import type { RpcContext } from './tools.ts';

function setup(): XdgPaths {
  const root = join(tmpdir(), `artinarey-operator-${newId()}`);
  const paths = resolveXdgPaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  });
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(dirname(paths.socketPath), { recursive: true });
  return paths;
}

function rawRpc(path: string, request: Record<string, unknown>): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      if (!settled) reject(new Error('RPC timed out'));
    }, 2000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
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

test('the operator token is created once with mode 0600 and reused', () => {
  const paths = setup();
  try {
    const token = loadOrCreateOperatorToken(paths);
    assert.match(token, /^[0-9a-f]{64}$/);
    const file = operatorTokenPath(paths);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadOrCreateOperatorToken(paths), token);
  } finally {
    rmSync(dirname(dirname(paths.configDir)), { recursive: true, force: true });
  }
});

test('every operator-only method is FORBIDDEN on a raw socket without a token', async () => {
  const paths = setup();
  let server: RpcServer | undefined;
  try {
    const token = loadOrCreateOperatorToken(paths);
    server = createRpcServer(paths.socketPath, undefined, undefined, undefined, token);
    await server.start();
    for (const method of [
      'shutdown', 'approve', 'auto_approve', 'stop_session', 'release_force',
    ]) {
      const response = await rawRpc(paths.socketPath, { id: method, method, params: {} });
      assert.equal(response.ok, false, method);
      if (!response.ok) assert.equal(response.error.code, 'FORBIDDEN', method);
    }
    const ping = await rawRpc(paths.socketPath, { id: 'ping', method: 'ping' });
    assert.equal(ping.ok, true);
  } finally {
    await server?.close();
    rmSync(dirname(dirname(paths.configDir)), { recursive: true, force: true });
  }
});

test('a raw socket with the operator token reaches an operator method', async () => {
  const paths = setup();
  let server: RpcServer | undefined;
  try {
    const token = loadOrCreateOperatorToken(paths);
    const seen: unknown[] = [];
    const supervisor = {
      approve: async (id: string, decision: string, by: string) => {
        seen.push([id, decision, by]);
        return { approval: { id, status: decision } };
      },
      approvals: () => [],
      evaluatePermission: () => ({ effect: 'allow' }),
    };
    server = createRpcServer(paths.socketPath, undefined,
      { supervisor } as unknown as RpcContext, undefined, token);
    await server.start();

    const approved = await rawRpc(paths.socketPath, {
      id: 'a1', method: 'approve', params: { id: 'approval', decision: 'approved', by: 'user' },
      operatorToken: token,
    });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    assert.deepEqual(seen, [['approval', 'approved', 'user']]);

    // Agent/plugin calls stay available without the operator token.
    const evaluated = await rawRpc(paths.socketPath, {
      id: 'e1', method: 'evaluate_permission',
      params: { projectId: 'p', worktreeId: 'wt', action: 'shell', resources: [] },
    });
    assert.equal(evaluated.ok, true, JSON.stringify(evaluated));
    if (evaluated.ok) assert.deepEqual(evaluated.result, { effect: 'allow' });
  } finally {
    await server?.close();
    rmSync(dirname(dirname(paths.configDir)), { recursive: true, force: true });
  }
});

test('stopDaemon sends the operator token and shuts a token-protected server down', async () => {
  const paths = setup();
  let server: RpcServer | undefined;
  try {
    server = createRpcServer(paths.socketPath, undefined, undefined, undefined,
      loadOrCreateOperatorToken(paths));
    await server.start();
    await stopDaemon(paths);
    assert.equal(existsSync(paths.socketPath), false);
  } finally {
    await server?.close();
    rmSync(dirname(dirname(paths.configDir)), { recursive: true, force: true });
  }
});
