import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPersona, findMarker, newId, openRegistry, resolveXdgPaths, writeMarker,
} from '@artinarey/core';
import { createRpcServer, type RpcResponse, type RpcServer } from './server.ts';

type Client = {
  call(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  close(): void;
};

async function openClient(path: string): Promise<Client> {
  const socket: Socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const pending: Array<(response: RpcResponse) => void> = [];
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const next = pending.shift();
      if (next && line.trim()) next(JSON.parse(line) as RpcResponse);
    }
  });

  let seq = 0;
  return {
    call(method, params) {
      return new Promise<RpcResponse>((resolve) => {
        pending.push(resolve);
        socket.write(`${JSON.stringify({ id: String(++seq), method, params })}\n`);
      });
    },
    close() {
      socket.destroy();
    },
  };
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function setup() {
  const root = join(tmpdir(), `artinarey-tools-${newId()}`);
  const runtime = join(root, 'runtime');
  for (const dir of [join(root, 'config'), join(root, 'data'), join(root, 'cache'), runtime]) {
    mkdirSync(dir, { recursive: true });
  }
  const paths = resolveXdgPaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: runtime,
  });
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Tools', repoCommonDir: '/r/.git', storeDir: join(paths.dataRoot, 'store'),
  });
  const worktrees = [join(root, 'wt1'), join(root, 'wt2')];
  const ids = worktrees.map(() => newId());
  worktrees.forEach((path, i) => {
    mkdirSync(path, { recursive: true });
    registry.worktrees.upsert({ id: ids[i]!, projectId: project.id, path, branch: null });
    writeMarker(path, project.id, ids[i]!);
  });
  return { root, paths, registry, project, worktrees, ids };
}

async function serve(s: ReturnType<typeof setup>): Promise<{ server: RpcServer; socketPath: string }> {
  const socketPath = join(s.paths.socketPath);
  mkdirSync(join(s.paths.socketPath, '..'), { recursive: true });
  const server = createRpcServer(socketPath, undefined, { registry: s.registry, paths: s.paths });
  await server.start();
  return { server, socketPath };
}

async function attach(client: Client, cwd: string): Promise<void> {
  const response = await client.call('attach', { cwd, pid: process.pid });
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(findMarker(cwd), 'fixture marker must exist');
}

async function claim(client: Client, personaId: string): Promise<void> {
  const response = await client.call('claim_persona', { persona_id: personaId });
  assert.equal(response.ok, true, JSON.stringify(response));
}

test('tool calls before attach are refused with NO_PROJECT', async () => {
  const s = setup();
  const { server, socketPath } = await serve(s);
  const client = await openClient(socketPath);

  const response = await client.call('check_in');
  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.error.code, 'NO_PROJECT');
    assert.match(response.error.message, /init|attach/);
  }

  client.close();
  await server.close();
  s.registry.close();
});

test('attach, claim and send_mail work over RPC; disconnect releases the binding', async () => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const { server, socketPath } = await serve(s);
  const client = await openClient(socketPath);

  await attach(client, s.worktrees[0]!);
  await claim(client, dev);
  const sent = await client.call('send_mail', {
    to: ['senior-dev'], subject: 'rpc mail', kind: 'question',
    action: 'review', body: 'Please review the RPC slice.',
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));

  const files = readdirSync(join(s.project.storeDir, 'mail'), { recursive: true })
    .filter((f) => String(f).endsWith('.md'));
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(s.project.storeDir, 'mail', String(files[0])), 'utf8'), /rpc mail/);

  assert.ok(s.registry.bindings.forWorktree(s.ids[0]!), 'binding exists while connected');
  client.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!), undefined, 'disconnect releases the binding');

  await server.close();
  s.registry.close();
});

test('inbox, read_mail, report, check_in, worktrees and mark_done dispatch through RPC', async () => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const { server, socketPath } = await serve(s);

  const sender = await openClient(socketPath);
  try {
  await attach(sender, s.worktrees[0]!);
  await claim(sender, dev);
  const sent = await sender.call('send_mail', {
    to: ['senior-dev'], subject: 'needs review', kind: 'task',
    action: 'review the shim', body: 'The shim is ready for review.',
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const mailId = sent.ok
    ? (sent.result as { text: string }).text.match(/Sent (\S+) to/)?.[1] ?? ''
    : '';
  assert.ok(mailId, 'send_mail must report the mail id');

  const receiver = await openClient(socketPath);
  await attach(receiver, s.worktrees[1]!);
  await claim(receiver, lead);

  const inbox = await receiver.call('inbox');
  assert.equal(inbox.ok, true, JSON.stringify(inbox));
  if (inbox.ok) {
    const text = inbox.result as { text: string };
    assert.match(text.text, /needs review/);
    assert.match(text.text, /unread: 1/);
  }

  const read = await receiver.call('read_mail', { id: mailId });
  assert.equal(read.ok, true, JSON.stringify(read));
  if (read.ok) assert.match((read.result as { text: string }).text, /shim is ready/);

  const afterRead = await receiver.call('inbox');
  assert.equal(afterRead.ok, true);
  if (afterRead.ok) assert.match((afterRead.result as { text: string }).text, /unread: 0/);

  const report = await receiver.call('report', {
    now: 'reviewing the shim', done: 'wrote tests', next: 'review mail', blocked: 'none',
  });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.match(readFileSync(join(s.project.storeDir, 'personas', lead, 'status.md'), 'utf8'), /reviewing the shim/);

  const checkIn = await receiver.call('check_in');
  assert.equal(checkIn.ok, true);
  if (checkIn.ok) assert.match((checkIn.result as { text: string }).text, /senior-dev/);

  const trees = await receiver.call('worktrees');
  assert.equal(trees.ok, true);
  if (trees.ok) assert.ok((trees.result as { text: string }).text.includes(s.worktrees[0]!));

  const done = await receiver.call('mark_done', { id: mailId, note: 'Reviewed and approved.' });
  assert.equal(done.ok, true, JSON.stringify(done));
  const receipts = readdirSync(join(s.project.storeDir, 'mail'), { recursive: true })
    .filter((f) => String(f).endsWith('.md'))
    .map((f) => readFileSync(join(s.project.storeDir, 'mail', String(f)), 'utf8'))
    .filter((text) => /^kind: receipt$/m.test(text));
  assert.equal(receipts.length, 1);

  } finally {
    sender.close();
    await server.close();
    s.registry.close();
  }
});

test('release_force frees a binding held by another live connection', async () => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const { server, socketPath } = await serve(s);

  const holder = await openClient(socketPath);
  await attach(holder, s.worktrees[0]!);
  await claim(holder, dev);
  assert.ok(s.registry.bindings.forWorktree(s.ids[0]!));

  const admin = await openClient(socketPath);
  const forced = await admin.call('release_force', { worktreeId: s.ids[0]! });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!), undefined);

  holder.close();
  admin.close();
  await server.close();
  s.registry.close();
});

test('attach pauses on a registered worktree whose git branch changed', async () => {
  const s = setup();
  const repo = join(s.root, 'repo');
  const worktree = join(s.root, 'branch-changed');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'init'], repo);
  git(['worktree', 'add', '-q', '-b', 'feature/new', worktree], repo);

  const id = newId();
  s.registry.worktrees.upsert({ id, projectId: s.project.id, path: worktree,
    branch: 'registered-branch' });
  writeMarker(worktree, s.project.id, id);
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');

  const { server, socketPath } = await serve(s);
  const client = await openClient(socketPath);
  try {
    const response = await client.call('attach', { cwd: worktree, pid: process.pid });
    assert.equal(response.ok, false, JSON.stringify(response));
    if (!response.ok) {
      assert.equal(response.error.code, 'WORKTREE_UNMANAGED');
      assert.match(response.error.message, /branch changed; confirm the move/);
      assert.match(response.error.message, /feature\/new/, 'message names the changed branch');
    }
    const claim = await client.call('claim_persona', { persona_id: dev });
    assert.equal(claim.ok, false, 'a paused attach must not leave a claimable binding');
    assert.equal(s.registry.bindings.forWorktree(id), undefined);
  } finally {
    client.close();
    await server.close();
    s.registry.close();
  }
});

test('RPC replies always end with unread and next', async () => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const { server, socketPath } = await serve(s);
  const client = await openClient(socketPath);
  await attach(client, s.worktrees[0]!);

  for (const method of ['check_in', 'claim_persona', 'inbox', 'worktrees']) {
    const response = await client.call(method, method === 'claim_persona' ? { persona_id: dev } : {});
    assert.equal(response.ok, true, JSON.stringify(response));
    if (response.ok) {
      const text = (response.result as { text: string }).text;
      assert.match(text, /\nunread: \d+\nnext: \S.*$/);
    }
  }

  client.close();
  await server.close();
  s.registry.close();
});
