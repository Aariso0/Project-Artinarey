import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPersona, newId, openRegistry, resolveXdgPaths, writeMarker,
} from '@artinarey/core';
import { createRpcServer } from '@artinarey/daemon';
import { createDaemonClient } from './daemon-client.ts';
import { toMcp } from './tools.ts';

function setup() {
  const root = join(tmpdir(), `artinarey-shim-${newId()}`);
  const config = join(root, 'config');
  const data = join(root, 'data');
  const cache = join(root, 'cache');
  const runtime = join(root, 'runtime');
  for (const dir of [config, data, cache, runtime]) mkdirSync(dir, { recursive: true });
  const paths = resolveXdgPaths({
    HOME: root, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache, XDG_RUNTIME_DIR: runtime,
  });
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Shim', repoCommonDir: '/r/.git', storeDir: join(data, 'store'),
  });
  const worktreeId = newId();
  const cwd = join(root, 'worktree');
  mkdirSync(cwd);
  registry.worktrees.upsert({ id: worktreeId, projectId: project.id, path: cwd, branch: null });
  writeMarker(cwd, project.id, worktreeId);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-shim', 'Shim Dev');
  return { paths, registry, project, cwd, persona };
}

test('the shim client attaches once and forwards tool calls to the daemon', async () => {
  const s = setup();
  const server = createRpcServer(s.paths.socketPath, undefined, {
    registry: s.registry, paths: s.paths,
  });
  await server.start();

  const client = createDaemonClient({
    paths: s.paths, cwd: s.cwd, pid: process.pid, autoStart: false,
  });
  try {
    const checkIn = await client.invoke('check_in', {});
    assert.equal(checkIn.isError, false);
    assert.match(checkIn.text, /no bound persona/);
    assert.match(checkIn.text, /\nunread: 0\nnext: claim_persona$/);

    const claimed = await client.invoke('claim_persona', { persona_id: s.persona });
    assert.equal(claimed.isError, false);
    assert.match(claimed.text, /Bound dev-shim/);

    const sent = await client.invoke('send_mail', {
      to: ['user'], subject: 'shim test', kind: 'note', action: 'read', body: 'hello from the shim',
    });
    assert.equal(sent.isError, false, sent.text);
    assert.match(sent.text, /^Sent /);
  } finally {
    client.close();
    await server.close();
    s.registry.close();
  }
});

test('daemon errors become isError replies with the full instruction text', async () => {
  const s = setup();
  const server = createRpcServer(s.paths.socketPath, undefined, {
    registry: s.registry, paths: s.paths,
  });
  await server.start();

  const client = createDaemonClient({
    paths: s.paths, cwd: s.cwd, pid: process.pid, autoStart: false,
  });
  try {
    const reply = await client.invoke('nope', {});
    assert.equal(reply.isError, true);
    assert.match(reply.text, /NOT_FOUND/);
  } finally {
    client.close();
    await server.close();
    s.registry.close();
  }
});

test('MCP results carry the tool text and isError flag', () => {
  const result = toMcp({ text: 'NO_PROJECT: stop', isError: true });
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'NO_PROJECT: stop' }]);
});
