import test from 'node:test';
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPersona, newId, openRegistry, resolveXdgPaths, writeMarker,
} from '@artinarey/core';
import { createRpcServer } from '@artinarey/daemon';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function setup() {
  const root = join(tmpdir(), `artinarey-mcp-${newId()}`);
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  };
  for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
  const paths = resolveXdgPaths(env);
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Mcp', repoCommonDir: '/r/.git', storeDir: join(env.XDG_DATA_HOME, 'store'),
  });
  const worktreeId = newId();
  const cwd = join(root, 'worktree');
  mkdirSync(cwd);
  registry.worktrees.upsert({ id: worktreeId, projectId: project.id, path: cwd, branch: null });
  writeMarker(cwd, project.id, worktreeId);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-mcp', 'Mcp Dev');
  return { env, paths, registry, project, cwd, worktreeId, persona };
}

function waitForReply(child: ChildProcess, id: number, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      child.stdout?.off('data', onData);
      reject(new Error(`no MCP reply for ${id}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number };
        if (message.id === id) {
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          resolvePromise(message);
          return;
        }
      }
    };
    child.stdout?.on('data', onData);
  });
}

test('closing a stdio session closes the daemon socket and drops the binding', async () => {
  const s = setup();
  const server = createRpcServer(s.paths.socketPath, undefined, {
    registry: s.registry, paths: s.paths,
  });
  await server.start();
  const require = createRequire(import.meta.url);
  const child = spawn(process.execPath, [
    '--import', require.resolve('tsx/esm'), join(repoRoot, 'packages/shim/src/index.ts'),
  ], {
    cwd: s.cwd,
    env: { ...process.env, ...s.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    const send = (value: unknown) => child.stdin.write(`${JSON.stringify(value)}\n`);
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-06-18', capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });
    await waitForReply(child, 1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'claim_persona', arguments: { persona_id: s.persona } },
    });
    const reply = await waitForReply(child, 2) as { result?: { isError?: boolean } };
    assert.notEqual(reply.result?.isError, true);
    assert.equal(s.registry.bindings.forWorktree(s.worktreeId)?.id, s.persona);

    child.stdin.end();
    const exited = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 3000);
      child.once('exit', () => { clearTimeout(timer); done(true); });
    });
    assert.equal(exited, true, 'shim must exit when its stdio session closes');
    assert.equal(s.registry.bindings.forWorktree(s.worktreeId), undefined);
  } finally {
    if (child.exitCode === null) child.kill();
    await server.close();
    s.registry.close();
  }
});
