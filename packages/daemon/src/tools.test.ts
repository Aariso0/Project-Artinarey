import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  buildIndex, createPersona, createTask, findMarker, listGitWorktrees, newId, openRegistry,
  queryMail, readPersona, readTasks, releaseShared, resolveXdgPaths, serializeMail,
  updateTask, validateMail, withProjectLock, writeMarker, type Registry,
} from '@artinarey/core';
import { createRpcServer, type RpcResponse, type RpcServer } from './server.ts';
import {
  dispatchTool, invalidateWorktree, releaseConnection, type RpcContext,
} from './tools.ts';

type Client = {
  call(method: string, params?: Record<string, unknown>): Promise<RpcResponse>;
  close(): void;
};

const TEST_OPERATOR_TOKEN = 'test-operator-token';

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not met before deadline');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
        socket.write(`${JSON.stringify({
          id: String(++seq), method, params, operatorToken: TEST_OPERATOR_TOKEN,
        })}\n`);
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

function gitWorktreeLocked(repo: string, path: string): boolean {
  const canonical = realpathSync(path);
  return listGitWorktrees(repo)
    .find((worktree) => realpathSync(worktree.path) === canonical)?.locked === true;
}

/** Seed a mail file directly so tests can simulate mails core validation would reject. */
function seedMail(s: ReturnType<typeof setup>, mail: {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  kind: 'task' | 'receipt' | 'note';
  subject: string;
  action: string;
  in_reply_to?: string;
  body?: string;
}): void {
  const file = join(s.project.storeDir, 'mail', '2026', '11', `${mail.id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeMail({
    id: mail.id,
    thread: mail.id,
    in_reply_to: mail.in_reply_to ?? '',
    from: mail.from,
    to: mail.to,
    cc: mail.cc ?? [],
    subject: mail.subject,
    kind: mail.kind,
    action: mail.action,
    eta: '',
    worktree: '',
    body: mail.body ?? 'seeded mail',
    created_at: '2026-11-24T00:00:00Z',
  }));
}

function reindex(s: ReturnType<typeof setup>): void {
  buildIndex(join(s.paths.cacheRoot, s.project.id, 'index.sqlite'), s.project.storeDir);
}

function receiptTexts(s: ReturnType<typeof setup>): string[] {
  return readdirSync(join(s.project.storeDir, 'mail'), { recursive: true })
    .filter((entry) => String(entry).endsWith('.md'))
    .map((entry) => readFileSync(join(s.project.storeDir, 'mail', String(entry)), 'utf8'))
    .filter((text) => /^kind: receipt$/m.test(text));
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

async function serve(
  s: ReturnType<typeof setup>,
  onConnectionClosed?: () => void,
): Promise<{ server: RpcServer; socketPath: string }> {
  const socketPath = join(s.paths.socketPath);
  mkdirSync(join(s.paths.socketPath, '..'), { recursive: true });
  const server = createRpcServer(socketPath, undefined, { registry: s.registry, paths: s.paths },
    onConnectionClosed, TEST_OPERATOR_TOKEN);
  await server.start();
  return { server, socketPath };
}

/** Raw client that keeps reply ids so pipelining order can be asserted. */
async function rawClient(path: string) {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.setEncoding('utf8');
  const pending = new Map<string, (response: RpcResponse) => void>();
  const replies: RpcResponse[] = [];
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line) as RpcResponse;
      replies.push(response);
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  });
  let seq = 0;
  return {
    write(line: string) { socket.write(`${line}\n`); },
    call(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse> {
      const id = String(++seq);
      return new Promise((resolve) => {
        pending.set(id, resolve);
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    replies,
    resetReplies() { replies.length = 0; },
    close() { socket.destroy(); },
  };
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
  let disconnects = 0;

  const started = await serve(s, () => { disconnects++; });
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
    assert.match(stale.error.message, /claim_persona/);
  }

  await attach(admin, s.worktrees[0]!);
  await claim(admin, dev);
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!)?.id, dev);

  const beforeClose = disconnects;
  holder.close();
  cleanup.clients.splice(cleanup.clients.indexOf(holder), 1);
  await waitUntil(() => disconnects > beforeClose);
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!)?.id, dev,
    'the old connection must not release the new binding');
});

test('a repeat claim of a CLI-created binding does not transfer cleanup ownership', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  s.registry.bindings.bind(dev, s.ids[0]!);
  const cleanup = track(t, s);
  let disconnects = 0;

  const started = await serve(s, () => { disconnects++; });
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);
  const beforeClose = disconnects;
  client.close();
  cleanup.clients.splice(cleanup.clients.indexOf(client), 1);
  await waitUntil(() => disconnects > beforeClose);
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
  await waitUntil(() => !s.registry.bindings.forWorktree(s.ids[0]!));
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

test('pipelined requests reply in order and a mid-flight close leaves no binding', async (t) => {
  const s = setup();
  const first = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const second = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-b', 'Dev B');
  const cleanup = track(t, s);
  let disconnects = 0;
  const started = await serve(s, () => { disconnects++; });
  cleanup.server = started.server;

  const client = await rawClient(started.socketPath);
  cleanup.clients.push({ call: (method, params) => client.call(method, params), close: () => client.close() });
  const handshake = await client.call('attach', { cwd: s.worktrees[0]!, pid: process.pid });
  assert.equal(handshake.ok, true, JSON.stringify(handshake));
  const claimed = await client.call('claim_persona', { persona_id: first });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  client.resetReplies();

  let releaseHold!: () => void;
  const holding = withProjectLock(s.project.storeDir, () => new Promise<void>((resolve) => {
    releaseHold = resolve;
  }));
  // The first request blocks on the store lock; the second must not overtake it.
  client.write(`${JSON.stringify({
    id: '1', method: 'send_mail', params: {
      to: ['user'], subject: 'slow', kind: 'note', action: 'read', body: 'blocked on the lock',
    },
  })}`);
  client.write('{"id":"2","method":"ping","params":{}}');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(client.replies.length, 0,
    `a pipelined reply must not overtake a pending request: ${JSON.stringify(client.replies)}`);
  releaseHold();
  await holding;
  await waitUntil(() => client.replies.length === 2);
  assert.deepEqual(client.replies.map((reply) => reply.id), ['1', '2']);

  // A pipelined claim that arrives while an earlier request is pending must not
  // record a binding after the connection has gone away.
  const beforeClose = disconnects;
  client.write(`${JSON.stringify({
    id: '3', method: 'send_mail', params: {
      to: ['user'], subject: 'in flight', kind: 'note', action: 'read', body: 'connection dies',
    },
  })}`);
  client.write(`${JSON.stringify({ id: '4', method: 'claim_persona', params: { persona_id: second } })}`);
  client.close();
  await waitUntil(() => disconnects > beforeClose);
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!)?.id, undefined,
    'a late claim must not leave a binding after the socket closed');
  assert.ok(first && second);
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

test('receiptExists matches exact frontmatter fields, not substrings or body text', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const devA = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);

  const mailId = newId();
  seedMail(s, { id: mailId, from: 'dev-a', to: ['dev'], kind: 'task', subject: 'review me', action: 'review' });
  // `from: dev-a` contains `from: dev`, and `dev-a` is not `dev`.
  seedMail(s, {
    id: newId(), from: 'dev-a', to: ['dev'], cc: ['senior-dev'], kind: 'receipt', in_reply_to: mailId,
    subject: 'decoy from dev-a', action: 'done',
  });
  // A longer reply id starts with the real id; a body can quote frontmatter.
  seedMail(s, {
    id: newId(), from: 'dev', to: ['user'], kind: 'receipt', in_reply_to: `${mailId}0`,
    subject: 'decoy long id', action: 'done',
  });
  seedMail(s, {
    id: newId(), from: 'dev-a', to: ['dev'], kind: 'note', subject: 'body decoy', action: 'read',
    body: `kind: receipt\nin_reply_to: ${mailId}\nfrom: dev`,
  });
  reindex(s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);
  const done = await client.call('mark_done', { id: mailId, note: 'Done for real.' });
  assert.equal(done.ok, true, JSON.stringify(done));

  const receipts = receiptTexts(s);
  // Two decoy receipts, one body decoy that quotes frontmatter, and the real receipt.
  assert.equal(receipts.length, 4, 'the decoys must not suppress the real receipt');
  assert.ok(receipts.some((text) => text.includes(`in_reply_to: ${mailId}\n`)
    && text.includes('from: dev\n')), 'a receipt with exact fields must be sent');
  assert.ok(devA);
});

test('one throwing binding lookup does not stop the other disconnect releases', async (t) => {
  const s = setup();
  const first = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-a', 'Dev A');
  const second = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-b', 'Dev B');
  track(t, s);
  s.registry.bindings.bind(first, s.ids[0]!);
  s.registry.bindings.bind(second, s.ids[1]!);

  const flaky = {
    bindings: {
      forWorktree(worktreeId: string) {
        if (worktreeId === 'bad') throw new Error('lookup boom');
        return s.registry.bindings.forWorktree(worktreeId);
      },
      release(personaId: string) { s.registry.bindings.release(personaId); },
    },
    projects: { list: () => s.registry.projects.list() },
    worktrees: { list: (projectId: string) => s.registry.worktrees.list(projectId) },
  } as unknown as Registry;
  const ctx: RpcContext = {
    registry: flaky, paths: s.paths,
    claimedBindings: [
      { personaId: 'missing', storeDir: s.project.storeDir, worktreeId: 'bad' },
      { personaId: first, storeDir: s.project.storeDir, worktreeId: s.ids[0]! },
      { personaId: second, storeDir: s.project.storeDir, worktreeId: s.ids[1]! },
    ],
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => releaseConnection(ctx));
    assert.equal(s.registry.bindings.forWorktree(s.ids[0]!), undefined);
    assert.equal(s.registry.bindings.forWorktree(s.ids[1]!), undefined,
      'a later binding must be attempted after an earlier lookup throws');
  } finally {
    console.error = originalError;
  }
});

test('force release keeps the worktree so the holder can claim a persona again', async (t) => {
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
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.error.code, 'INVALID_INPUT');
    assert.match(stale.error.message, /claim_persona/, 'recovery must name the next tool');
  }
  const reclaim = await holder.call('claim_persona', { persona_id: dev });
  assert.equal(reclaim.ok, true, JSON.stringify(reclaim));
  assert.equal(s.registry.bindings.forWorktree(s.ids[0]!)?.id, dev);
});

test('mark_done skips the receipt when senior-dev is not registered', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const cleanup = track(t, s);
  const mailId = newId();
  seedMail(s, { id: mailId, from: 'dev-a', to: ['dev'], kind: 'task', subject: 'seed', action: 'review' });
  reindex(s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);
  const done = await client.call('mark_done', { id: mailId, note: 'Done.' });
  assert.equal(done.ok, true, JSON.stringify(done));
  if (done.ok) assert.match((done.result as { text: string }).text, /no receipt sent/);
  assert.equal(receiptTexts(s).length, 0, 'an unregistered senior-dev must not be cc-ed');
  const doneEvents = readFileSync(join(s.project.storeDir, 'events', 'audit.jsonl'), 'utf8')
    .split('\n').filter((line) => line.includes(`"id":"${mailId}"`)
      && line.includes('"type":"task_done"'));
  assert.equal(doneEvents.length, 1);
});

test('mark_done does not cc senior-dev when the original sender is user or senior-dev', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const fromUser = newId();
  const fromLead = newId();
  seedMail(s, { id: fromUser, from: 'user', to: ['dev'], kind: 'task', subject: 'from user', action: 'review' });
  seedMail(s, {
    id: fromLead, from: 'senior-dev', to: ['dev'], kind: 'task', subject: 'from lead', action: 'review',
  });
  reindex(s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);
  assert.equal((await client.call('mark_done', { id: fromUser, note: 'Done.' })).ok, true);
  assert.equal((await client.call('mark_done', { id: fromLead, note: 'Done.' })).ok, true);
  const receipts = receiptTexts(s);
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((text) => /^cc: \[\]$/m.test(text)),
    'senior-dev is the original sender or user for both tasks');
});

test('mark_done completes when the original sender is unknown and validation stays strict', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const mailId = newId();
  seedMail(s, { id: mailId, from: 'ghost', to: ['dev'], kind: 'task', subject: 'old sender', action: 'review' });
  reindex(s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, dev);
  const done = await client.call('mark_done', { id: mailId, note: 'Done.' });
  assert.equal(done.ok, true, JSON.stringify(done));
  if (done.ok) {
    assert.match((done.result as { text: string }).text, /no receipt sent|no longer registered/);
  }
  assert.equal(receiptTexts(s).length, 0, 'an unknown recipient must not produce a receipt');
  const doneEvents = readFileSync(join(s.project.storeDir, 'events', 'audit.jsonl'), 'utf8')
    .split('\n').filter((line) => line.includes(`"id":"${mailId}"`)
      && line.includes('"type":"task_done"'));
  assert.equal(doneEvents.length, 1, 'task completion is still recorded');

  const checked = validateMail({
    from: 'dev', to: ['ghost'], cc: ['senior-dev'], subject: 'receipt',
    kind: 'receipt', action: 'done', body: 'strict validation',
  }, { knownPersonas: ['dev', 'senior-dev', 'user'], role: 'dev', sharedTasks: [] });
  assert.equal(checked.ok, false, 'core validation must still reject unknown recipients');
  if (!checked.ok) assert.match(checked.reason, /unknown recipient: ghost/);
});

test('a failed new-role claim leaves no orphan persona behind', async (t) => {
  const s = setup();
  const repo = join(s.root, 'repo');
  const worktree = join(s.root, 'git-wt');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'init'], repo);
  git(['worktree', 'add', '-q', '-b', 'feature/orphan', worktree], repo);
  const worktreeId = newId();
  s.registry.worktrees.upsert({
    id: worktreeId, projectId: s.project.id, path: worktree, branch: 'feature/orphan',
  });
  writeMarker(worktree, s.project.id, worktreeId);
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  const attached = await client.call('attach', { cwd: worktree, pid: process.pid });
  assert.equal(attached.ok, true, JSON.stringify(attached));

  const audit = join(s.project.storeDir, 'events', 'audit.jsonl');
  const role = 'dev-orphan';
  // Let createPersona's own audit succeed, then fail only the claim audit after
  // binding/lock/persona state have been committed.
  const originalBind = s.registry.bindings.bind;
  let createdId: string | undefined;
  s.registry.bindings.bind = ((...args: Parameters<typeof originalBind>) => {
    createdId = args[0];
    const bound = originalBind(...args);
    rmSync(audit, { force: true });
    mkdirSync(audit, { recursive: true });
    return bound;
  }) as typeof originalBind;
  const failed = await client.call('claim_persona', { new_role: role, name: 'Orphan' });
  s.registry.bindings.bind = originalBind;
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.ok(createdId, 'the claim should have reached binding');
  assert.equal(s.registry.personas.list(s.project.id).filter((persona) => persona.role === role).length, 0,
    'a failed new-role claim must not leave a persona row');
  assert.equal(existsSync(join(s.project.storeDir, 'personas', createdId)), false,
    'a failed new-role claim must not leave a persona directory');

  rmSync(audit, { recursive: true, force: true });
  const retried = await client.call('claim_persona', { new_role: role, name: 'Orphan' });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(s.registry.personas.list(s.project.id).filter((persona) => persona.role === role).length, 1,
    'a retry must not see an ambiguous role');
});

test('a failed new-role claim before binding leaves no orphan persona behind', async (t) => {
  const s = setup();
  const repo = join(s.root, 'repo');
  const worktree = join(s.root, 'git-wt');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'init'], repo);
  git(['worktree', 'add', '-q', '-b', 'feature/orphan-prebind', worktree], repo);
  const worktreeId = newId();
  s.registry.worktrees.upsert({
    id: worktreeId, projectId: s.project.id, path: worktree, branch: 'feature/orphan-prebind',
  });
  writeMarker(worktree, s.project.id, worktreeId);
  const cleanup = track(t, s);

  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  const attached = await client.call('attach', { cwd: worktree, pid: process.pid });
  assert.equal(attached.ok, true, JSON.stringify(attached));

  const role = 'dev-orphan-prebind';
  const originalBind = s.registry.bindings.bind;
  let createdId: string | undefined;
  s.registry.bindings.bind = ((...args: Parameters<typeof originalBind>) => {
    createdId = args[0];
    throw new Error('bind failed');
  }) as typeof originalBind;
  const failed = await client.call('claim_persona', { new_role: role, name: 'Orphan' });
  s.registry.bindings.bind = originalBind;
  assert.equal(failed.ok, false, JSON.stringify(failed));
  assert.ok(createdId, 'the claim should have reached binding');
  assert.equal(s.registry.personas.list(s.project.id).some((persona) => persona.id === createdId), false,
    'a pre-bind failure must not leave a persona row');
  assert.equal(existsSync(join(s.project.storeDir, 'personas', createdId)), false,
    'a pre-bind failure must not leave a persona directory');
});

test('a failed claim audit rolls back binding, persona state and worktree lock', async (t) => {
  const s = setup();
  const repo = join(s.root, 'repo');
  const worktree = join(s.root, 'git-wt');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'init'], repo);
  git(['worktree', 'add', '-q', '-b', 'feature/rollback', worktree], repo);
  const worktreeId = newId();
  s.registry.worktrees.upsert({
    id: worktreeId, projectId: s.project.id, path: worktree, branch: 'feature/rollback',
  });
  writeMarker(worktree, s.project.id, worktreeId);
  const persona = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-rollback', 'Rollback');
  const cleanup = track(t, s);
  let disconnects = 0;

  const started = await serve(s, () => { disconnects++; });
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  const attached = await client.call('attach', { cwd: worktree, pid: process.pid });
  assert.equal(attached.ok, true, JSON.stringify(attached));

  const audit = join(s.project.storeDir, 'events', 'audit.jsonl');
  rmSync(audit, { force: true });
  mkdirSync(audit, { recursive: true });
  const claimed = await client.call('claim_persona', { persona_id: persona });
  assert.equal(claimed.ok, false, JSON.stringify(claimed));
  assert.equal(s.registry.bindings.forWorktree(worktreeId), undefined,
    'a failed claim must not leave an unowned binding');
  const state = readPersona(s.project.storeDir, persona);
  assert.equal(state.state, 'new', 'persona state must be restored');
  assert.equal(state.home_worktree_id, null);
  assert.equal(state.role, 'dev-rollback');
  assert.equal(gitWorktreeLocked(repo, worktree), false, 'the acquired worktree lock must be released');

  const beforeClose = disconnects;
  client.close();
  cleanup.clients.splice(cleanup.clients.indexOf(client), 1);
  await waitUntil(() => disconnects > beforeClose);
  assert.equal(s.registry.bindings.forWorktree(worktreeId), undefined,
    'disconnect must not have an unowned binding to release');
});

test('assign_task rejects overlapping scopes and creates disjoint tasks', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, lead);

  const first = await client.call('assign_task', {
    persona_id: dev, title: 'one', scope: ['src/a.ts'], body: 'do it',
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const overlap = await client.call('assign_task', {
    persona_id: dev, title: 'two', scope: ['src'], body: 'do it',
  });
  assert.equal(overlap.ok, false, JSON.stringify(overlap));
  assert.equal(overlap.error.code, 'LEASE_OVERLAP');
  const disjoint = await client.call('assign_task', {
    persona_id: dev, title: 'three', scope: ['docs/x.md'], body: 'do it',
  });
  assert.equal(disjoint.ok, true, JSON.stringify(disjoint));
  assert.equal(readTasks(s.project.storeDir).length, 2);
});

test('only the senior dev may assign; only the assignee may update or request scope', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const started = await serve(s);
  cleanup.server = started.server;
  const leadClient = await openClient(started.socketPath);
  const worker = await openClient(started.socketPath);
  cleanup.clients.push(leadClient, worker);

  await attach(leadClient, s.worktrees[0]!);
  await claim(leadClient, lead);
  const created = await leadClient.call('assign_task', {
    persona_id: dev, title: 'one', scope: ['src/a.ts'], body: 'do it',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const taskId = readTasks(s.project.storeDir)[0]!.id;

  await attach(worker, s.worktrees[1]!);
  await claim(worker, dev);
  const forbiddenAssign = await worker.call('assign_task', {
    persona_id: dev, title: 'nope', scope: ['other'], body: 'do it',
  });
  assert.equal(forbiddenAssign.ok, false);
  assert.equal(forbiddenAssign.error.code, 'FORBIDDEN_ROLE');

  const updated = await worker.call('task_update', { task_id: taskId, status: 'blocked', note: 'stuck' });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.equal(readTasks(s.project.storeDir)[0]!.status, 'blocked');

  const scoped = await worker.call('request_scope', {
    task_id: taskId, paths: ['docs/x.md'], reason: 'need docs',
  });
  assert.equal(scoped.ok, true, JSON.stringify(scoped));
});

test('assign_task names the committed task on mail failure and recovers with task_id', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, lead);

  const args = { persona_id: dev, title: 'retry me', scope: ['src/a.ts'] };
  const failed = await client.call('assign_task', { ...args, body: 'API_KEY=do-not-send' });
  assert.equal(failed.ok, false, JSON.stringify(failed));
  if (failed.ok) return;
  assert.equal(failed.error.code, 'MAIL_REJECTED');
  const taskId = (failed.error as { taskId?: string }).taskId;
  assert.ok(taskId, 'the committed task id must be returned');
  assert.match(failed.error.message, new RegExp(taskId));
  assert.match(failed.error.message, /task_id/);
  assert.equal(readTasks(s.project.storeDir).length, 1, 'the task survived the mail failure');

  const unknown = await client.call('assign_task', {
    ...args, body: 'do it', task_id: 'missing-task',
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, 'NOT_FOUND');
  assert.equal(readTasks(s.project.storeDir).length, 1, 'recovery must not create a task');

  const recovered = await client.call('assign_task', {
    ...args, body: 'do it', task_id: taskId,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  if (recovered.ok) assert.match((recovered.result as { text: string }).text, new RegExp(taskId));
  assert.equal(readTasks(s.project.storeDir).length, 1);
  reindex(s);
  const tasks = queryMail(join(s.paths.cacheRoot, s.project.id, 'index.sqlite'))
    .filter((mail) => mail.kind === 'task' && mail.subject === 'Task: retry me');
  assert.equal(tasks.length, 1, 'recovery must send exactly one notification');
  assert.match(readFileSync(tasks[0]!.file, 'utf8'), new RegExp(`in_reply_to: ${taskId}`));
});

test('assign_task names the committed task on index failure and only reindexes on recovery', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, lead);

  const index = join(s.paths.cacheRoot, s.project.id, 'index.sqlite');
  mkdirSync(index, { recursive: true }); // buildIndex cannot open a directory as a DB
  const args = { persona_id: dev, title: 'index me', scope: ['docs/a.md'], body: 'do it' };
  const failed = await client.call('assign_task', args);
  assert.equal(failed.ok, false, JSON.stringify(failed));
  if (failed.ok) return;
  assert.equal(failed.error.code, 'INDEX_ERROR');
  const taskId = (failed.error as { taskId?: string }).taskId;
  assert.ok(taskId);
  assert.match(failed.error.message, new RegExp(taskId));
  assert.equal(readTasks(s.project.storeDir).length, 1);

  rmSync(index, { recursive: true, force: true });
  const recovered = await client.call('assign_task', { ...args, task_id: taskId });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(readTasks(s.project.storeDir).length, 1);
  const mails = queryMail(index).filter((mail) => mail.kind === 'task');
  assert.equal(mails.length, 1, 'recovery must not resend the committed notification');
  assert.equal(mails[0]?.subject, 'Task: index me');
});

test('task_update from done reclaims the lease before reactivating', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const other = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev-2', 'Dev Two');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const started = await serve(s);
  cleanup.server = started.server;
  const leadClient = await openClient(started.socketPath);
  const worker = await openClient(started.socketPath);
  cleanup.clients.push(leadClient, worker);
  await attach(leadClient, s.worktrees[0]!);
  await claim(leadClient, lead);
  await attach(worker, s.worktrees[1]!);
  await claim(worker, dev);

  const created = await leadClient.call('assign_task', {
    persona_id: dev, title: 'first', scope: ['package.json'], body: 'do it',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const taskId = readTasks(s.project.storeDir).find((task) => task.title === 'first')!.id;
  const done = await worker.call('task_update', { task_id: taskId, status: 'done', note: 'finished' });
  assert.equal(done.ok, true, JSON.stringify(done));

  // A different task now owns the shared file; reactivation must not steal it.
  const second = await leadClient.call('assign_task', {
    persona_id: other, title: 'second', scope: ['package.json'], body: 'do it',
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  const secondId = readTasks(s.project.storeDir).find((task) => task.title === 'second')!.id;
  const blocked = await worker.call('task_update', {
    task_id: taskId, status: 'in_progress', note: 'resume',
  });
  assert.equal(blocked.ok, false, JSON.stringify(blocked));
  if (!blocked.ok) assert.equal(blocked.error.code, 'LEASE_OVERLAP');
  assert.equal(readTasks(s.project.storeDir).find((task) => task.id === taskId)!.status, 'done');

  updateTask(s.project.storeDir, secondId, { status: 'done' });
  releaseShared(s.project.storeDir, secondId);
  const retried = await worker.call('task_update', {
    task_id: taskId, status: 'in_progress', note: 'resume',
  });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(readTasks(s.project.storeDir).find((task) => task.id === taskId)!.status, 'in_progress');
  const claims = readFileSync(join(s.project.storeDir, 'events', 'leases.jsonl'), 'utf8')
    .split('\n').filter((line) => line.includes('"type":"shared_claim"')
      && line.includes(`"taskId":"${taskId}"`));
  assert.equal(claims.length, 2, 'reactivation must reclaim the shared lease');
});

test('assign_task rejects invalid scope entries before persisting a task or claim', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, lead);

  const leaseFile = join(s.project.storeDir, 'events', 'leases.jsonl');
  const claimEvents = (): string[] => existsSync(leaseFile)
    ? readFileSync(leaseFile, 'utf8').split('\n')
      .filter((line) => line.includes('"type":"shared_claim"'))
    : [];

  for (const [index, scope] of [[''], ['../x'], ['/abs'], ['package.json', '../x']].entries()) {
    const rejected = await client.call('assign_task', {
      persona_id: dev, title: `invalid ${index}`, scope, body: 'do it',
    });
    assert.equal(rejected.ok, false, JSON.stringify(rejected));
    if (!rejected.ok) {
      assert.equal(rejected.error.code, 'INVALID_INPUT');
      assert.match(rejected.error.message, /repo-relative/);
    }
    assert.equal(readTasks(s.project.storeDir).length, 0,
      `scope ${JSON.stringify(scope)} must not persist a task`);
    assert.equal(claimEvents().length, 0,
      `scope ${JSON.stringify(scope)} must not leave a shared claim`);
  }

  const valid = await client.call('assign_task', {
    persona_id: dev, title: 'valid after rejections', scope: ['src/a.ts'], body: 'do it',
  });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  assert.equal(readTasks(s.project.storeDir).length, 1);
});

test('assign_task normalizes scopes for assignment, claim and recovery', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, lead);

  const args = { persona_id: dev, title: 'normalized', scope: ['./src//a.ts', './package.json'] };
  const failed = await client.call('assign_task', { ...args, body: 'API_KEY=do-not-send' });
  assert.equal(failed.ok, false, JSON.stringify(failed));
  if (failed.ok) return;
  assert.equal(failed.error.code, 'MAIL_REJECTED');
  const taskId = (failed.error as { taskId?: string }).taskId;
  assert.ok(taskId, 'the committed task id must be returned');

  const tasks = readTasks(s.project.storeDir);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0]!.scope, ['src/a.ts', 'package.json'], 'committed scope must be normalized');
  const leaseFile = join(s.project.storeDir, 'events', 'leases.jsonl');
  const claimEvents = (): string[] => existsSync(leaseFile)
    ? readFileSync(leaseFile, 'utf8').split('\n')
      .filter((line) => line.includes('"type":"shared_claim"'))
    : [];
  assert.equal(claimEvents().length, 1, 'the shared file must be claimed once');
  assert.match(claimEvents()[0]!, /"files":\["package.json"\]/);

  const invalidRecovery = await client.call('assign_task', {
    ...args, scope: ['src/a.ts', '../x'], body: 'do it', task_id: taskId,
  });
  assert.equal(invalidRecovery.ok, false);
  if (!invalidRecovery.ok) assert.equal(invalidRecovery.error.code, 'INVALID_INPUT');
  const mismatch = await client.call('assign_task', {
    ...args, scope: ['src/a.ts'], body: 'do it', task_id: taskId,
  });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.error.code, 'INVALID_INPUT');
  assert.equal(readTasks(s.project.storeDir).length, 1, 'rejected recovery must not recreate a task');
  assert.equal(claimEvents().length, 1, 'rejected recovery must not add a claim');

  const recovered = await client.call('assign_task', {
    ...args, scope: ['src/a.ts', 'package.json/'], body: 'do it', task_id: taskId,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(readTasks(s.project.storeDir).length, 1, 'recovery must reuse the committed task');
  assert.equal(claimEvents().length, 1, 'recovery must not reclaim an already held file');

  reindex(s);
  const mails = queryMail(join(s.paths.cacheRoot, s.project.id, 'index.sqlite'))
    .filter((mail) => mail.kind === 'task' && mail.subject === 'Task: normalized');
  assert.equal(mails.length, 1, 'recovery must send exactly one notification');
  assert.match(readFileSync(mails[0]!.file, 'utf8'), new RegExp(`in_reply_to: ${taskId}`));
});

test('assign_task recovery rejects duplicate spellings that hide a committed path', async (t) => {
  const s = setup();
  const dev = createPersona(s.registry, s.project.storeDir, s.project.id, 'dev', 'Dev');
  const lead = createPersona(s.registry, s.project.storeDir, s.project.id, 'senior-dev', 'Lead');
  const cleanup = track(t, s);
  const started = await serve(s);
  cleanup.server = started.server;
  const client = await openClient(started.socketPath);
  cleanup.clients.push(client);
  await attach(client, s.worktrees[0]!);
  await claim(client, lead);

  const args = { persona_id: dev, title: 'dedup recovery', scope: ['src/a.ts', './package.json'] };
  const failed = await client.call('assign_task', { ...args, body: 'API_KEY=do-not-send' });
  assert.equal(failed.ok, false, JSON.stringify(failed));
  if (failed.ok) return;
  assert.equal(failed.error.code, 'MAIL_REJECTED');
  const taskId = (failed.error as { taskId?: string }).taskId;
  assert.ok(taskId, 'the committed task id must be returned');

  const committed = readTasks(s.project.storeDir);
  assert.deepEqual(committed[0]!.scope, ['src/a.ts', 'package.json']);
  const leaseFile = join(s.project.storeDir, 'events', 'leases.jsonl');
  const claimEvents = (): string[] => existsSync(leaseFile)
    ? readFileSync(leaseFile, 'utf8').split('\n')
      .filter((line) => line.includes('"type":"shared_claim"'))
    : [];
  assert.equal(claimEvents().length, 1);
  reindex(s);
  const index = join(s.paths.cacheRoot, s.project.id, 'index.sqlite');
  const taskMails = () => queryMail(index).filter((mail) => mail.kind === 'task'
    && mail.subject === 'Task: dedup recovery');
  assert.equal(taskMails().length, 0);

  const rejected = await client.call('assign_task', {
    ...args, scope: ['src/a.ts', './src/a.ts'], body: 'do it', task_id: taskId,
  });
  assert.equal(rejected.ok, false, JSON.stringify(rejected));
  if (!rejected.ok) assert.equal(rejected.error.code, 'INVALID_INPUT');
  assert.deepEqual(readTasks(s.project.storeDir), committed,
    'rejected recovery must not mutate the committed task');
  assert.equal(claimEvents().length, 1, 'rejected recovery must not add a claim');
  reindex(s);
  assert.equal(taskMails().length, 0, 'rejected recovery must not send mail');

  const recovered = await client.call('assign_task', {
    ...args, scope: ['./package.json/', 'src//a.ts'], body: 'do it', task_id: taskId,
  });
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.deepEqual(readTasks(s.project.storeDir), committed,
    'recovery must reuse the committed task');
  assert.equal(claimEvents().length, 1, 'recovery must not add a claim');
  reindex(s);
  assert.equal(taskMails().length, 1, 'reordered equivalent recovery sends one notification');
  assert.match(readFileSync(taskMails()[0]!.file, 'utf8'), new RegExp(`in_reply_to: ${taskId}`));
});

test('attached identities resolve the current store after a Move', async (t) => {
  const s = setup();
  track(t, s);
  const persona = s.registry.personas.create({
    projectId: s.project.id, role: 'dev0', name: 'Dev Zero',
  });
  s.registry.bindings.bind(persona.id, s.ids[0]!);
  mkdirSync(s.project.storeDir, { recursive: true });
  const moved = join(s.root, 'moved-store');
  mkdirSync(moved, { recursive: true });
  s.registry.projects.updateStoreDir(s.project.id, moved);

  const ctx: RpcContext = {
    registry: s.registry, paths: s.paths,
    identity: {
      projectId: s.project.id, worktreeId: s.ids[0]!, markerDir: s.worktrees[0]!,
      storeDir: s.project.storeDir, personaId: persona.id, role: 'dev0',
    },
  };
  const response = await dispatchTool({
    id: '1', method: 'report', params: { now: 'now', done: 'done', next: 'next', blocked: '' },
  }, ctx);
  assert.equal(response.ok, true, response.ok ? '' : response.error.message);
  assert.ok(existsSync(join(moved, 'personas', persona.id, 'status.md')));
  assert.equal(existsSync(join(s.project.storeDir, 'personas', persona.id, 'status.md')), false);
  invalidateWorktree(ctx, s.ids[0]!);
  assert.equal(ctx.identity?.storeDir, moved);
});

test('run_task rejects an unclaimed connection before dispatch', async (t) => {
  const s = setup();
  track(t, s);
  let prompts = 0;
  const ctx: RpcContext = {
    registry: s.registry, paths: s.paths,
    identity: {
      projectId: s.project.id, worktreeId: s.ids[0]!, markerDir: s.worktrees[0]!,
      storeDir: s.project.storeDir,
    },
    model: {
      prompt: async () => {
        prompts += 1;
        return { text: 'should not run', done: true };
      },
    } as unknown as RpcContext['model'],
  };
  const response = await dispatchTool(
    { id: '1', method: 'run_task', params: { task_id: 'any-task' } }, ctx,
  );
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'INVALID_INPUT');
  assert.equal(prompts, 0);
});

test('run_task authorises by persona role, not persona id', async (t) => {
  const s = setup();
  track(t, s);
  const dev = s.registry.personas.create({
    projectId: s.project.id, role: 'dev0', name: 'Dev Zero',
  });
  const senior = s.registry.personas.create({
    projectId: s.project.id, role: 'senior-dev', name: 'Senior Dev',
  });
  s.registry.bindings.bind(dev.id, s.ids[0]!);
  s.registry.bindings.bind(senior.id, s.ids[1]!);
  mkdirSync(s.project.storeDir, { recursive: true });
  const taskId = newId();
  createTask(s.project.storeDir, {
    id: taskId, projectId: s.project.id, title: 'Assigned work',
    scope: ['src/a.ts'], assignee: 'dev0', status: 'in_progress',
    branch: null, worktreeId: null, createdAt: new Date().toISOString(),
  });

  let prompts = 0;
  const model = {
    prompt: async () => {
      prompts += 1;
      return { text: 'done', done: true };
    },
  } as unknown as RpcContext['model'];
  const context = (worktreeIndex: number, personaId: string, role: string): RpcContext => ({
    registry: s.registry, paths: s.paths, model,
    identity: {
      projectId: s.project.id, worktreeId: s.ids[worktreeIndex]!,
      markerDir: s.worktrees[worktreeIndex]!, storeDir: s.project.storeDir,
      personaId, role,
    },
  });

  const assigned = await dispatchTool(
    { id: '1', method: 'run_task', params: { task_id: taskId } },
    context(0, dev.id, 'dev0'),
  );
  assert.equal(assigned.ok, true, assigned.ok ? '' : assigned.error.message);
  assert.equal(prompts, 1);

  const other = await dispatchTool(
    { id: '2', method: 'run_task', params: { task_id: taskId } },
    context(1, senior.id, 'senior-dev'),
  );
  assert.equal(other.ok, false);
  if (!other.ok) assert.equal(other.error.code, 'FORBIDDEN_ROLE');
  assert.equal(prompts, 1, 'another role must never reach the model');
});
