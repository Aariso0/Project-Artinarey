import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPersona, newId, openRegistry, resolveXdgPaths, writeMarker,
} from '@artinarey/core';
import { createRpcServer } from '@artinarey/daemon';
import { createDaemonClient } from './daemon-client.ts';
import { toMcp } from './tools.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

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
  return { paths, registry, project, cwd, persona, worktreeId };
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

/** A stand-in daemon so auto-start tests never touch the real XDG runtime dir. */
function fakeDaemonRoot(root: string): string {
  const fakeRoot = join(root, 'fake-root');
  const entry = join(fakeRoot, 'packages', 'cli', 'src', 'index.ts');
  mkdirSync(dirname(entry), { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules'), join(fakeRoot, 'node_modules'), 'dir');
  writeFileSync(entry, [
    "import { mkdirSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';",
    "import { createServer } from 'node:net';",
    "import { dirname } from 'node:path';",
    'const socketPath = process.env.FAKE_DAEMON_SOCKET;',
    'mkdirSync(dirname(socketPath), { recursive: true });',
    'if (existsSync(socketPath)) unlinkSync(socketPath);',
    'writeFileSync(process.env.FAKE_DAEMON_PID, String(process.pid));',
    'createServer((socket) => {',
    "  socket.setEncoding('utf8');",
    "  let buffer = '';",
    "  socket.on('data', (chunk) => {",
    '    buffer += chunk;',
    '    let end;',
    "    while ((end = buffer.indexOf('\\n')) >= 0) {",
    '      const line = buffer.slice(0, end);',
    '      buffer = buffer.slice(end + 1);',
    '      const id = JSON.parse(line).id;',
    '      socket.write(`${JSON.stringify({ id, ok: true, result: { text: \'ok\', isError: false } })}\\n`);',
    '    }',
    '  });',
    '}).listen(socketPath);',
  ].join('\n'));
  return fakeRoot;
}

test('a stale socket file triggers auto-start and connection retries', async () => {
  const s = setup();
  const runtimeDir = dirname(s.paths.socketPath);
  const pidFile = join(runtimeDir, 'fake-daemon.pid');
  const fakeRoot = fakeDaemonRoot(runtimeDir);
  writeFileSync(s.paths.socketPath, 'stale');
  const previous = {
    root: process.env.ARTINAREY_ROOT,
    socket: process.env.FAKE_DAEMON_SOCKET,
    pid: process.env.FAKE_DAEMON_PID,
  };
  process.env.ARTINAREY_ROOT = fakeRoot;
  process.env.FAKE_DAEMON_SOCKET = s.paths.socketPath;
  process.env.FAKE_DAEMON_PID = pidFile;

  const client = createDaemonClient({
    paths: s.paths, cwd: s.cwd, pid: process.pid, timeoutMs: 2000,
  });
  try {
    const reply = await client.invoke('check_in', {});
    assert.equal(reply.isError, false, reply.text);
    assert.equal(reply.text, 'ok');
  } finally {
    client.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, 'utf8').trim())); } catch { /* already gone */ }
    }
    s.registry.close();
  }
});

test('close during connection setup discards the late socket', async () => {
  const s = setup();
  const server = createRpcServer(s.paths.socketPath, undefined, {
    registry: s.registry, paths: s.paths,
  });
  await server.start();

  const client = createDaemonClient({
    paths: s.paths, cwd: s.cwd, pid: process.pid, autoStart: false,
  });
  try {
    const pending = client.invoke('claim_persona', { persona_id: s.persona });
    client.close();
    const reply = await pending;
    assert.equal(reply.isError, true);
    assert.match(reply.text, /STORE_OFFLINE/);
    assert.equal(s.registry.bindings.forWorktree(s.worktreeId), undefined);
  } finally {
    client.close();
    await server.close();
    s.registry.close();
  }
});
