import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  createPersona, findMarker, newId, openRegistry, queryMail, resolveXdgPaths, writeMarker,
} from '@artinarey/core';
import { createRpcServer, type RpcResponse, type RpcServer } from './server.ts';

type Client = {
  call(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  close(): void;
};

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met before deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function openClient(path: string): Promise<Client> {
  const socket: Socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolve();
    });
    socket.once('error', onError);
  });

  const pending: Array<{
    resolve: (response: RpcResponse) => void;
    reject: (err: Error) => void;
  }> = [];
  const failPending = (err: Error): void => {
    while (pending.length) pending.shift()!.reject(err);
  };
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const next = pending.shift();
      if (!next) continue;
      try {
        next.resolve(JSON.parse(line) as RpcResponse);
      } catch (err) {
        next.reject(err instanceof Error ? err : new Error('invalid RPC reply'));
      }
    }
  });
  socket.on('error', failPending);
  socket.on('close', () => failPending(new Error('socket closed before a reply')));

  let seq = 0;
  return {
    call(method, params) {
      return new Promise<RpcResponse>((resolve, reject) => {
        pending.push({ resolve, reject });
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

function mailIdOf(response: RpcResponse): string {
  assert.equal(response.ok, true, JSON.stringify(response));
  if (!response.ok) return '';
  return (response.result as { text: string }).text.match(/Sent (\S+) to/)?.[1] ?? '';
}

/** Register cleanup before any assertion so a failed test cannot leak listeners or fixtures. */
function track(t: TestContext, s: ReturnType<typeof setup>) {
  const state: { server?: RpcServer; clients: Client[] } = { clients: [] };
  t.after(async () => {
    for (const client of state.clients) client.close();
    await state.server?.close();
    s.registry.close();
    rmSync(s.root, { recursive: true, force: true });
  });
  return state;
}

test('tool calls before attach are refused with NO_PROJECT', async (t) => {
  const s = setup();
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);

  const response = await client.call('check_in');
  assert.equal(response.ok, false);
  if (!response.ok) {
    assert.equal(response.error.code, 'NO_PROJECT');
    assert.match(response.error.message, /init|attach/);
  }
});

test('attach, claim and send_mail work over RPC; disconnect releases the binding', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);

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
  await waitUntil(() => s.registry.bindings.forWorktree(s.ids[0]!) === undefined);
});

test('inbox shows full ids; cc recipients see and read copied mail', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const observer = createPersona(s.registry, s.project.storeDir, s.project.id, 'observer', 'Observer');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const sender = await openClient(started.socketPath);
  cleanup.clients.push(sender);
  await attach(sender, s.worktrees[0]!);
  await claim(sender, dev);
  const sent = await sender.call('send_mail', {
    to: ['senior-dev'], cc: ['senior-dev', 'observer'], subject: 'needs review', kind: 'task',
    action: 'review the shim', body: 'The shim is ready for review.',
  });
  const mailId = mailIdOf(sent);
  assert.ok(mailId, 'send_mail must report the mail id');

  const ownRead = await sender.call('read_mail', { id: mailId });
  assert.equal(ownRead.ok, true, `sender must be able to read own mail: ${JSON.stringify(ownRead)}`);

  const receiver = await openClient(started.socketPath);
  cleanup.clients.push(receiver);
  await attach(receiver, s.worktrees[1]!);
  await claim(receiver, lead);

  const inbox = await receiver.call('inbox');
  assert.equal(inbox.ok, true, JSON.stringify(inbox));
  if (inbox.ok) {
    const text = (inbox.result as { text: string }).text;
    assert.match(text, /needs review/);
    assert.ok(text.includes(mailId), `inbox must show the full id ${mailId}`);
    assert.match(text, /unread: 1/);
  }

  const read = await receiver.call('read_mail', { id: mailId });
  assert.equal(read.ok, true, JSON.stringify(read));
  if (read.ok) assert.match((read.result as { text: string }).text, /shim is ready/);

  const ccPath = join(s.root, 'wt3');
  mkdirSync(ccPath, { recursive: true });
  const ccWorktree = newId();
  s.registry.worktrees.upsert({ id: ccWorktree, projectId: s.project.id, path: ccPath, branch: null });
  writeMarker(ccPath, s.project.id, ccWorktree);
  const ccClient = await openClient(started.socketPath);
  cleanup.clients.push(ccClient);
  await attach(ccClient, ccPath);
  await claim(ccClient, observer);
  const ccInbox = await ccClient.call('inbox');
  assert.equal(ccInbox.ok, true, JSON.stringify(ccInbox));
  if (ccInbox.ok) assert.match((ccInbox.result as { text: string }).text, /needs review/);
  const ccRead = await ccClient.call('read_mail', { id: mailId });
  assert.equal(ccRead.ok, true, JSON.stringify(ccRead));
});

test('inbox, read_mail, report, check_in, worktrees and mark_done dispatch through RPC', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const sender = await openClient(started.socketPath);
  cleanup.clients.push(sender);
  await attach(sender, s.worktrees[0]!);
  await claim(sender, dev);
  const sent = await sender.call('send_mail', {
    to: ['senior-dev'], subject: 'needs review', kind: 'task',
    action: 'review the shim', body: 'The shim is ready for review.',
  });
  const mailId = mailIdOf(sent);
  assert.ok(mailId, 'send_mail must report the mail id');

  const receiver = await openClient(started.socketPath);
  cleanup.clients.push(receiver);
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
});

test('mark_done is retry-safe', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const sender = await openClient(started.socketPath);
  cleanup.clients.push(sender);
  await attach(sender, s.worktrees[0]!);
  await claim(sender, dev);
  const mailId = mailIdOf(await sender.call('send_mail', {
    to: ['senior-dev'], subject: 'retry me', kind: 'task', action: 'review',
    body: 'Please review.',
  }));
  assert.ok(mailId);

  const receiver = await openClient(started.socketPath);
  cleanup.clients.push(receiver);
  await attach(receiver, s.worktrees[1]!);
  await claim(receiver, lead);
  for (let i = 0; i < 2; i++) {
    const done = await receiver.call('mark_done', { id: mailId, note: 'Done twice.' });
    assert.equal(done.ok, true, JSON.stringify(done));
  }
  const receipts = readdirSync(join(s.project.storeDir, 'mail'), { recursive: true })
    .filter((f) => String(f).endsWith('.md'))
    .map((f) => readFileSync(join(s.project.storeDir, 'mail', String(f)), 'utf8'))
    .filter((text) => /^kind: receipt$/m.test(text));
  assert.equal(receipts.length, 1, 'a retry must not duplicate the receipt');
  const doneEvents = readFileSync(join(s.project.storeDir, 'events', 'audit.jsonl'), 'utf8')
    .split('\n').filter((line) => line.includes('"type":"task_done"'));
  assert.equal(doneEvents.length, 1, 'a retry must not duplicate task_done');
});

test('send_mail reports the committed id when indexing fails', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);

  const index = join(s.paths.cacheRoot, s.project.id, 'index.sqlite');
  mkdirSync(index, { recursive: true });
  t.after(() => rmSync(index, { recursive: true, force: true }));
  const sent = await client.call('send_mail', {
    to: ['senior-dev'], subject: 'committed anyway', kind: 'note', action: 'read',
    body: 'The mail file must survive a broken index.',
  });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  if (sent.ok) {
    const text = (sent.result as { text: string }).text;
    assert.match(text, /^Sent \S+ to senior-dev\./);
    assert.match(text, /Index update failed:/);
  }
});

test('release_force frees a binding held by another live connection', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const holder = await openClient(started.socketPath);
  cleanup.clients.push(holder);
  await attach(holder, s.worktrees[0]!);
  await claim(holder, dev);
  assert.ok(s.registry.bindings.forWorktree(s.ids[0]!));

  const admin = await openClient(started.socketPath);
  cleanup.clients.push(admin);
  const forced = await admin.call('release_force', { worktreeId: s.ids[0]! });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!), undefined);
});

test('force release invalidates the old holder and preserves a reclaimed binding', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const holder = await openClient(started.socketPath);
  cleanup.clients.push(holder);
  await attach(holder, s.worktrees[0]!);
  await claim(holder, dev);

  const admin = await openClient(started.socketPath);
  cleanup.clients.push(admin);
  const forced = await admin.call('release_force', { worktreeId: s.ids[0]! });
  assert.equal(forced.ok, true, JSON.stringify(forced));

  const stale = await holder.call('inbox');
  assert.equal(stale.ok, false, 'the released identity must not stay usable');
  if (!stale.ok) {
    assert.equal(stale.error.code, 'INVALID_INPUT');
    assert.match(stale.error.message, /attach/);
  }

  await attach(admin, s.worktrees[0]!);
  await claim(admin, dev);
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!)?.id, dev);

  holder.close();
  cleanup.clients.splice(cleanup.clients.indexOf(holder), 1);
  await flush();
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!)?.id, dev,
    'the old connection must not release the new binding');
});

test('a repeat claim of a CLI-created binding does not transfer cleanup ownership', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  s.registry.bindings.bind(dev, s.ids[0]!);
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);
  client.close();
  cleanup.clients.splice(cleanup.clients.indexOf(client), 1);
  await flush();
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!)?.id, dev,
    'the real binding owner keeps its binding');
});

test('disconnect releases every binding acquired by the connection', async (t) => {
  const s = setup();
  const first = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const second = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, first);
  await attach(client, s.worktrees[1]!);
  await claim(client, second);
  assert.ok(s.registry.bindings.forWorktree(s.ids[0]!));
  assert.ok(s.registry.bindings.forWorktree(s.ids[1]!));

  client.close();
  cleanup.clients.splice(cleanup.clients.indexOf(client), 1);
  await waitUntil(() => !s.registry.bindings.forWorktree(s.ids[0]!)
    && !s.registry.bindings.forWorktree(s.ids[1]!));
});

test('attach pauses on a registered worktree whose git branch changed', async (t) => {
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
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);

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
});

test('RPC replies always end with unread and next', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);

  for (const method of ['check_in', 'claim_persona', 'inbox', 'worktrees']) {
    const response = await client.call(method, method === 'claim_persona' ? { persona_id: dev } : {});
    assert.equal(response.ok, true, JSON.stringify(response));
    if (response.ok) {
      const text = (response.result as { text: string }).text;
      assert.match(text, /\nunread: \d+\nnext: \S.*$/);
    }
  }
});

test('a repeat claim refreshes ownership so disconnect releases the binding', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);
  await claim(client, dev);

  const claims = readFileSync(join(s.project.storeDir, 'events', 'audit.jsonl'), 'utf8')
    .split('\n').filter((line) => line.includes('"type":"persona_claimed"'));
  assert.equal(claims.length, 2, 'a repeat claim appends another audit line');
  assert.ok(s.registry.bindings.forWorktree(s.ids[0]!));

  client.close();
  cleanup.clients.splice(cleanup.clients.indexOf(client), 1);
  await flush();
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!), undefined,
    'the connection must still own the binding after a repeat claim');
});

test('mark_done rebuilds the index when the receipt already exists', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const sender = await openClient(started.socketPath);
  cleanup.clients.push(sender);
  await attach(sender, s.worktrees[0]!);
  await claim(sender, dev);
  const mailId = mailIdOf(await sender.call('send_mail', {
    to: ['senior-dev'], subject: 'index me on retry', kind: 'task', action: 'review',
    body: 'Please review.',
  }));
  assert.ok(mailId);

  const receiver = await openClient(started.socketPath);
  cleanup.clients.push(receiver);
  await attach(receiver, s.worktrees[1]!);
  await claim(receiver, lead);
  const done = await receiver.call('mark_done', { id: mailId, note: 'Done once.' });
  assert.equal(done.ok, true, JSON.stringify(done));

  const index = join(s.paths.cacheRoot, s.project.id, 'index.sqlite');
  const receipt = queryMail(index).find((mail) => mail.kind === 'receipt');
  assert.ok(receipt, 'the first call must index its receipt');
  // Simulate a committed receipt with a stale index (a prior buildIndex failed).
  const db = new Database(index);
  db.exec(`DELETE FROM mail WHERE id = '${receipt!.id}'`);
  db.close();
  assert.equal(queryMail(index).some((mail) => mail.id === receipt!.id), false);

  const retry = await receiver.call('mark_done', { id: mailId, note: 'Done once.' });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.ok(existsSync(index));
  assert.ok(queryMail(index).some((mail) => mail.id === receipt!.id),
    'a retry with an existing receipt must rebuild the index');
  const receipts = readdirSync(join(s.project.storeDir, 'mail'), { recursive: true })
    .filter((f) => String(f).endsWith('.md'))
    .map((f) => readFileSync(join(s.project.storeDir, 'mail', String(f)), 'utf8'))
    .filter((text) => /^kind: receipt$/m.test(text));
  assert.equal(receipts.length, 1, 'a retry must not send a second receipt');
});

test('send_mail indexes a committed mail even when the audit append fails', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);

  const audit = join(s.project.storeDir, 'events', 'audit.jsonl');
  rmSync(audit, { force: true });
  mkdirSync(audit, { recursive: true });
  const sent = await client.call('send_mail', {
    to: ['senior-dev'], subject: 'partial but committed', kind: 'note', action: 'read',
    body: 'The mail file is durable.',
  });
  assert.equal(sent.ok, false, JSON.stringify(sent));
  if (!sent.ok) {
    assert.equal(sent.error.code, 'MAIL_PARTIAL');
    assert.match(sent.error.message, /do not resend/i);
  }

  const index = join(s.paths.cacheRoot, s.project.id, 'index.sqlite');
  const mails = queryMail(index);
  assert.equal(mails.length, 1, 'the committed mail must be indexed');
  assert.equal(mails[0]?.subject, 'partial but committed');
});

test('a failed best-effort reindex never replaces the MAIL_PARTIAL error', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);

  const audit = join(s.project.storeDir, 'events', 'audit.jsonl');
  rmSync(audit, { force: true });
  mkdirSync(audit, { recursive: true });
  const index = join(s.paths.cacheRoot, s.project.id, 'index.sqlite');
  mkdirSync(index, { recursive: true }); // buildIndex cannot open a directory as a DB
  const sent = await client.call('send_mail', {
    to: ['senior-dev'], subject: 'partial and unindexed', kind: 'note', action: 'read',
    body: 'The index is broken too.',
  });
  assert.equal(sent.ok, false, JSON.stringify(sent));
  if (!sent.ok) {
    assert.equal(sent.error.code, 'MAIL_PARTIAL', 'the original error must survive');
    assert.match(sent.error.message, /do not resend/i);
  }
});
