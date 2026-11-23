import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPersona, newId, openRegistry, resolveXdgPaths, writeMarker,
} from '@artinarey/core';
import { createRpcServer } from '@artinarey/daemon';
import { main } from './index.ts';

function root(): string {
  const dir = join(tmpdir(), `artinarey-connect-${newId()}`);
  for (const sub of ['config', 'data', 'cache', 'runtime', 'worktree']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_RUNTIME_DIR: join(dir, 'runtime'),
    PATH: process.env.PATH ?? '',
  };
}

test('connect opencode writes an MCP entry and allow rules without clobbering config', async () => {
  const dir = root();
  const cwd = join(dir, 'worktree');
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({
    theme: 'keep-me',
    mcp: { servers: { other: { type: 'local', command: ['other'] } } },
    permissions: [{ action: 'bash', resource: '*', effect: 'ask' }],
  }));

  let error = '';
  const original = console.error;
  console.error = (s: unknown) => { error += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['connect', 'opencode'], envFor(dir), cwd);
  } finally {
    console.error = original;
  }
  assert.equal(code, 0, error);
  assert.equal(existsSync(join(cwd, 'opencode.json')), true);

  const config = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')) as {
    theme: string;
    mcp: { servers: Record<string, { type: string; command: string[] }> };
    permissions: Array<{ action: string; resource: string; effect: string }>;
  };
  assert.equal(config.theme, 'keep-me');
  assert.ok(config.mcp.servers.other);
  const server = config.mcp.servers.artinarey;
  assert.equal(server.type, 'local');
  assert.ok(server.command.some((part) => part.includes('packages/shim/src/index.ts')));

  const allowed = config.permissions.map((rule) => rule.action);
  for (const tool of [
    'check_in', 'claim_persona', 'inbox', 'read_mail',
    'send_mail', 'mark_done', 'report', 'worktrees',
  ]) {
    assert.ok(allowed.includes(`artinarey_${tool}`), `missing allow rule for ${tool}`);
  }
  assert.ok(allowed.includes('bash'), 'existing rules must survive');
});

test('release <worktree> --force frees a binding through the daemon', async () => {
  const dir = root();
  const env = envFor(dir);
  const paths = resolveXdgPaths(env);
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Release', repoCommonDir: '/r/.git', storeDir: join(dir, 'data', 'store'),
  });
  const worktreeId = newId();
  const cwd = join(dir, 'worktree');
  registry.worktrees.upsert({ id: worktreeId, projectId: project.id, path: cwd, branch: null });
  writeMarker(cwd, project.id, worktreeId);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-a', 'Dev A');
  registry.bindings.bind(persona, worktreeId);

  const server = createRpcServer(paths.socketPath, undefined, { registry, paths });
  await server.start();

  const original = console.log;
  let output = '';
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  try {
    assert.equal(await main(['release', worktreeId, '--force'], env, cwd), 0);
    assert.match(output, /released/);
    assert.equal(registry.bindings.forWorktree(worktreeId), undefined);
  } finally {
    console.log = original;
    await server.close();
    registry.close();
  }
});
