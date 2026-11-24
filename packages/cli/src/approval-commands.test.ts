import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, openRegistry, resolveXdgPaths } from '@artinarey/core';
import {
  createRpcServer, loadOrCreateOperatorToken, type RpcContext, type RpcServer,
} from '@artinarey/daemon';
import { main } from './index.ts';

type Captured = { code: number; out: string; err: string };

function setup() {
  const root = join(tmpdir(), `artinarey-approval-cli-${newId()}`);
  const paths = resolveXdgPaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  });
  mkdirSync(join(paths.configDir), { recursive: true });
  mkdirSync(join(paths.socketPath, '..'), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    PATH: process.env.PATH ?? '',
  };
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Approvals', repoCommonDir: '/r/.git', storeDir: join(paths.dataRoot, 'store'),
  });
  return { root, env, paths, registry, project };
}

async function serve(s: ReturnType<typeof setup>, supervisor: Record<string, unknown>) {
  const server = createRpcServer(s.paths.socketPath, undefined,
    { registry: s.registry, paths: s.paths, supervisor } as unknown as RpcContext,
    undefined, loadOrCreateOperatorToken(s.paths));
  await server.start();
  return server;
}

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<Captured> {
  const originalLog = console.log;
  const originalError = console.error;
  let out = '';
  let err = '';
  console.log = (s: unknown) => { out += `${String(s)}\n`; };
  console.error = (s: unknown) => { err += `${String(s)}\n`; };
  try {
    const code = await main(args, env, join(tmpdir()));
    return { code, out, err };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

const approval = {
  id: 'a1', projectId: 'p', kind: 'spawn_cap', status: 'pending',
  summary: 'cap reached for dev1',
};

test('approvals lists pending requests from the daemon', async () => {
  const s = setup();
  let server: RpcServer | undefined;
  try {
    server = await serve(s, { approvals: () => [approval] });
    const result = await run(['approvals'], s.env);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /a1/);
    assert.match(result.out, /pending/);
    assert.match(result.out, /cap reached for dev1/);
  } finally {
    await server?.close();
    s.registry.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('approvals with no pending requests says so', async () => {
  const s = setup();
  let server: RpcServer | undefined;
  try {
    server = await serve(s, { approvals: () => [] });
    const result = await run(['approvals'], s.env);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /no approvals/);
  } finally {
    await server?.close();
    s.registry.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('approve resolves through the daemon and reports any resumed spawn', async () => {
  const s = setup();
  let server: RpcServer | undefined;
  try {
    const seen: unknown[] = [];
    server = await serve(s, {
      approve: async (id: string, decision: string, by: string) => {
        seen.push([id, decision, by]);
        return {
          approval: { id, status: decision },
          spawn: { message: `Started dev1 in /wt (session v1).` },
        };
      },
    });
    const result = await run(['approve', 'a1'], s.env);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /a1: approved/);
    assert.match(result.out, /Started dev1/);
    assert.deepEqual(seen, [['a1', 'approved', 'user']]);

    seen.length = 0;
    const rejected = await run(['approve', 'a1', '--reject'], s.env);
    assert.equal(rejected.code, 0, rejected.err);
    assert.match(rejected.out, /a1: rejected/);
    assert.deepEqual(seen, [['a1', 'rejected', 'user']]);
  } finally {
    await server?.close();
    s.registry.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('auto-approve requires a worktree and a valid on/off value', async () => {
  const s = setup();
  const result = await run(['auto-approve', 'wt1'], s.env);
  assert.equal(result.code, 2);
  assert.match(result.err, /usage/);
});

test('auto-approve toggles through the daemon', async () => {
  const s = setup();
  let server: RpcServer | undefined;
  try {
    const seen: unknown[] = [];
    server = await serve(s, {
      toggle: (id: string, enabled: boolean) => seen.push([id, enabled]),
    });
    const result = await run(['auto-approve', 'wt1', 'on'], s.env);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /auto-approve wt1: on/);
    assert.deepEqual(seen, [['wt1', true]]);
  } finally {
    await server?.close();
    s.registry.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('sessions lists running sessions from the daemon', async () => {
  const s = setup();
  let server: RpcServer | undefined;
  try {
    server = await serve(s, {
      sessions: () => [{
        id: 's1', status: 'running', personaId: 'dev1', vendorSessionId: 'v1',
      }],
    });
    const result = await run(['sessions', s.project.id], s.env);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /s1/);
    assert.match(result.out, /dev1/);
    assert.match(result.out, /v1/);
  } finally {
    await server?.close();
    s.registry.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});
