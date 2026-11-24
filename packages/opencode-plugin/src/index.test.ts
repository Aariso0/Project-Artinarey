import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { newId, resolveXdgPaths, type XdgPaths } from '@artinarey/core';
import {
  callDaemon, createRpcServer, type RpcContext, type RpcServer,
} from '@artinarey/daemon';
import { evaluateRiskyCall, type DaemonCall, type EvaluateDeps } from './index.ts';

const marker = { projectId: 'p', worktreeId: 'wt' };
const dir = join(tmpdir(), 'project', 'worktree');

type Event = {
  action: string;
  resources: string[];
  effect: 'allow' | 'ask' | 'deny';
  message?: string;
};

function event(action = 'shell', resources = ['curl https://example.com']): Event {
  return { action, resources, effect: 'allow' };
}

function fakeDaemon(
  decision: { effect: string; message?: string; approvalId?: string },
  statuses: string[] = [],
): { call: DaemonCall; calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let index = 0;
  const call: DaemonCall = async (method, params) => {
    calls.push({ method, params });
    if (method === 'evaluate_permission') return { ok: true, result: decision };
    return { ok: true, result: { status: statuses[Math.min(index++, statuses.length - 1)] ?? 'pending' } };
  };
  return { call, calls };
}

const noSleep: EvaluateDeps['sleep'] = async () => {};

test('local shell commands are not sent to the daemon', async () => {
  const { call, calls } = fakeDaemon({ effect: 'allow' });
  const local = event('shell', ['pnpm test']);
  await evaluateRiskyCall(local as never, marker, dir, { call, sleep: noSleep });
  assert.equal(calls.length, 0);
  assert.equal(local.effect, 'allow');
});

test('an allow decision leaves the event untouched', async () => {
  const { call } = fakeDaemon({ effect: 'allow' });
  const e = event();
  await evaluateRiskyCall(e as never, marker, dir, { call, sleep: noSleep });
  assert.equal(e.effect, 'allow');
});

test('a deny decision is mirrored into OpenCode', async () => {
  const { call } = fakeDaemon({ effect: 'deny', message: 'configured deny' });
  const e = event();
  await evaluateRiskyCall(e as never, marker, dir, { call, sleep: noSleep });
  assert.equal(e.effect, 'deny');
  assert.equal(e.message, 'configured deny');
});

test('a daemon failure fails closed rather than silently allowing', async () => {
  const call: DaemonCall = async () => ({ ok: false, error: { message: 'socket missing' } });
  const e = event();
  await evaluateRiskyCall(e as never, marker, dir, { call, sleep: noSleep });
  assert.equal(e.effect, 'deny');
  assert.match(e.message ?? '', /socket missing/);
});

test('an ask blocks until the user approves, then allows', async () => {
  const { call, calls } = fakeDaemon(
    { effect: 'ask', message: 'approval a1', approvalId: 'a1' },
    ['pending', 'pending', 'approved'],
  );
  const e = event();
  await evaluateRiskyCall(e as never, marker, dir, { call, sleep: noSleep, pollMs: 0 });
  assert.equal(e.effect, 'allow');
  assert.equal(e.message, 'Approved a1');
  assert.equal(calls[0]!.method, 'evaluate_permission');
  assert.ok(calls.slice(1).every((c) => c.method === 'approval_status'));
  assert.equal((calls[0]!.params.projectId), 'p');
  assert.equal((calls[0]!.params.worktreeId), 'wt');
});

test('an ask that the user rejects denies the call', async () => {
  const { call } = fakeDaemon(
    { effect: 'ask', message: 'approval a2', approvalId: 'a2' },
    ['pending', 'rejected'],
  );
  const e = event();
  await evaluateRiskyCall(e as never, marker, dir, { call, sleep: noSleep, pollMs: 0 });
  assert.equal(e.effect, 'deny');
  assert.equal(e.message, 'Rejected a2');
});

test('an external-directory access asks even when the command is local', async () => {
  const { call, calls } = fakeDaemon({ effect: 'allow' });
  const e = event('external_directory', ['/etc/*']);
  await evaluateRiskyCall(e as never, marker, dir, { call, sleep: noSleep });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'evaluate_permission');
});

test('the plugin evaluates a risky call through the socket without an operator token', async () => {
  const root = join(tmpdir(), `artinarey-plugin-${newId()}`);
  const paths: XdgPaths = resolveXdgPaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  });
  mkdirSync(dirname(paths.socketPath), { recursive: true });
  let server: RpcServer | undefined;
  try {
    let forwarded: unknown;
    const supervisor = {
      evaluatePermission: (input: unknown) => {
        forwarded = input;
        return { effect: 'allow' };
      },
    };
    server = createRpcServer(paths.socketPath, undefined,
      { supervisor } as unknown as RpcContext);
    await server.start();
    const e = event();
    await evaluateRiskyCall(e as never, marker, dir, {
      call: (method, params) => callDaemon(paths, method, params),
      sleep: noSleep,
    });
    assert.equal(e.effect, 'allow');
    assert.deepEqual(forwarded, {
      projectId: marker.projectId, worktreeId: marker.worktreeId, action: 'shell',
      resources: ['curl https://example.com'], command: 'curl https://example.com',
    });
  } finally {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
