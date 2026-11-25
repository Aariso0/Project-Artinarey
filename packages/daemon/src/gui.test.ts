import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendJournal, appendSession, buildIndex, createTask, loadConfig, newId, openRegistry,
  resolveXdgPaths, serializeMail, sessionLogFile, withProjectLock, writeMarker,
  type SessionSummary,
} from '@artinarey/core';
import {
  handleGuiRequest, type GuiMail, type GuiPersona, type GuiProject, type GuiWorktree,
} from './gui.ts';
import {
  moveFinalPath, moveIncomingPath, moveJournalPath, movePaths, readMove, resumeMove, startMove,
  type MoveStatus,
} from './move.ts';
import type { RpcResponse } from './server.ts';
import type { RpcContext } from './tools.ts';

function setup() {
  const root = join(tmpdir(), `artinarey-gui-${newId()}`);
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
    name: 'Gui', repoCommonDir: join(root, 'repo', '.git'), storeDir: join(paths.dataRoot, 'store'),
  });
  const worktreePaths = [join(root, 'wt1'), join(root, 'wt2')];
  const worktreeIds = worktreePaths.map(() => newId());
  worktreePaths.forEach((path, i) => {
    mkdirSync(path, { recursive: true });
    registry.worktrees.upsert({ id: worktreeIds[i]!, projectId: project.id, path, branch: null });
    writeMarker(path, project.id, worktreeIds[i]!);
  });
  const senior = registry.personas.create({ projectId: project.id, role: 'senior-dev', name: 'Senior Dev' });
  const dev = registry.personas.create({ projectId: project.id, role: 'dev0', name: 'Dev Zero' });
  registry.bindings.bind(senior.id, worktreeIds[0]!);
  registry.bindings.bind(dev.id, worktreeIds[1]!);
  return {
    root, paths, registry, project, worktreePaths, worktreeIds,
    personaIds: [senior.id, dev.id],
  };
}

type Fixture = ReturnType<typeof setup>;

/** Register cleanup before any assertion so a failed test cannot leak a fixture. */
function track(t: TestContext, s: Fixture) {
  t.after(() => {
    s.registry.close();
    rmSync(s.root, { recursive: true, force: true });
  });
}

function ctx(s: Fixture): RpcContext {
  return { registry: s.registry, paths: s.paths };
}

function seedRunningSession(s: Fixture, personaId: string, worktreeId: string): void {
  const session: SessionSummary = {
    id: newId(),
    projectId: s.project.id,
    worktreeId,
    personaId,
    vendor: 'opencode',
    vendorSessionId: 'vendor-session',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    logFile: sessionLogFile(s.paths.cacheRoot, s.project.id),
  };
  appendSession(session.logFile, session);
}

function seedMail(s: Fixture, index: number, createdAt: string, recipient = 'dev0'): void {
  const id = `mail-${String(index).padStart(4, '0')}`;
  const file = join(s.project.storeDir, 'mail', '2026', '11', `${id}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeMail({
    id,
    thread: 'thread-1',
    in_reply_to: '',
    from: 'senior-dev',
    to: [recipient],
    cc: [],
    subject: `Subject ${index}`,
    kind: 'note',
    action: '',
    eta: '',
    worktree: '',
    body: 'private body',
    created_at: createdAt,
  }));
}

/** One project, one senior dev, two developers, three worktrees and one mail per agent. */
function setupAcceptance(t: TestContext): Fixture {
  const s = setup();
  track(t, s);
  const branches = ['main', 'artinarey/dev0', 'artinarey/dev1'];
  const thirdPath = join(s.root, 'wt3');
  mkdirSync(thirdPath, { recursive: true });
  const thirdId = newId();
  s.worktreePaths.push(thirdPath);
  s.worktreeIds.push(thirdId);
  s.worktreePaths.forEach((path, i) => {
    s.registry.worktrees.upsert({ id: s.worktreeIds[i]!, projectId: s.project.id, path, branch: branches[i] });
    writeMarker(path, s.project.id, s.worktreeIds[i]!);
  });
  const secondDev = s.registry.personas.create({
    projectId: s.project.id, role: 'dev1', name: 'Dev One',
  });
  s.personaIds.push(secondDev.id);
  s.registry.bindings.bind(secondDev.id, thirdId);

  const recipients = ['senior-dev', 'dev0', 'dev1'];
  recipients.forEach((recipient, i) => {
    seedMail(s, i + 1, new Date(Date.UTC(2026, 10, 24, 12, 0, i)).toISOString(), recipient);
  });
  buildIndex(join(s.paths.cacheRoot, s.project.id, 'index.sqlite'), s.project.storeDir);
  return s;
}

/** GUI results are snapshots: no body, token, secret or read-state key may be present. */
function assertReadOnlyResponse(response: RpcResponse): void {
  assert.equal(response.ok, true);
  const rows: unknown = response.ok ? response.result : [];
  let fieldCount = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [field, nested] of Object.entries(value)) {
        fieldCount += 1;
        assert.doesNotMatch(field,
          /^(body|token|secret|read|unread|isRead|readAt|read_at|readState|hasRead|.*Body|.*Token|.*Secret)$/i,
          `forbidden field: ${field}`);
        visit(nested);
      }
    }
  };
  visit(rows);
  if (Array.isArray(rows) && rows.length > 0) assert.ok(fieldCount > 0);
  assert.doesNotMatch(JSON.stringify(rows), /private body/i);
}

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

test('gui.openProject and gui.cloneProject register both setup paths', async (t) => {
  const s = setup();
  track(t, s);
  const source = join(s.root, 'source');
  mkdirSync(source);
  gitIn(source, 'init', '-q', '-b', 'main');
  gitIn(source, 'config', 'user.email', 'test@example.com');
  gitIn(source, 'config', 'user.name', 'Test');
  writeFileSync(join(source, 'README.md'), 'hello\n');
  gitIn(source, 'add', 'README.md');
  gitIn(source, 'commit', '-q', '-m', 'initial');

  const opened = await handleGuiRequest({
    id: '1', method: 'gui.openProject', params: { path: source },
  }, ctx(s));
  assertReadOnlyResponse(opened);
  const first = opened.ok ? opened.result as { projectId: string; path: string; name: string } : null;
  assert.ok(first);
  assert.equal(first.path, source);
  assert.equal(first.name, 'source');
  assert.ok(s.registry.worktrees.list(first.projectId).some((row) => row.path === source));

  const target = join(s.root, 'fresh', 'copy');
  const cloned = await handleGuiRequest({
    id: '2', method: 'gui.cloneProject', params: { url: source, target },
  }, ctx(s));
  assertReadOnlyResponse(cloned);
  const second = cloned.ok ? cloned.result as { projectId: string; path: string } : null;
  assert.ok(second);
  assert.equal(second.path, target);
  assert.ok(s.registry.worktrees.list(second.projectId).some((row) => row.path === target));

  const projects = s.registry.projects.list();
  assert.equal(projects.length, 3, 'the seeded project plus both setup paths');
});

test('project setup methods reject missing input with a typed error', async (t) => {
  const s = setup();
  track(t, s);
  for (const method of ['gui.openProject', 'gui.cloneProject']) {
    const reply = await handleGuiRequest({ id: '1', method, params: {} }, ctx(s));
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.equal(reply.error.code, 'INVALID_INPUT');
  }
});

test('gui.projects marks a missing store offline and rejects non-gui methods', async (t) => {
  const s = setup();
  track(t, s);
  const ok = await handleGuiRequest({ id: '1', method: 'gui.projects' }, ctx(s));
  assert.equal(ok.ok, true);
  const projects = (ok.ok ? ok.result : []) as GuiProject[];
  assert.equal(projects[0]?.status, 'offline');

  const bad = await handleGuiRequest({ id: '2', method: 'send_mail' }, ctx(s));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'FORBIDDEN_METHOD');

  const missing = await handleGuiRequest({ id: '3', method: 'gui.nope' }, ctx(s));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'NOT_FOUND');

  mkdirSync(s.project.storeDir, { recursive: true });
  writeFileSync(join(s.project.storeDir, 'project.json'), '{"schema_version":1}\n');
  const active = await handleGuiRequest({ id: '4', method: 'gui.projects' }, ctx(s));
  assert.equal(active.ok, true);
  const activeProject = (active.ok ? active.result as GuiProject[] : [])[0];
  assert.equal(activeProject?.status, 'active');
  assert.ok(activeProject && activeProject.bytes > 0 && activeProject.freeBytes > 0);
});

test('gui.personas and gui.worktrees render registry state read-only', async (t) => {
  const s = setup();
  track(t, s);
  const people = await handleGuiRequest(
    { id: '1', method: 'gui.personas', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(people.ok, true);
  const rows = people.ok ? people.result as GuiPersona[] : [];
  assert.deepEqual(rows.map((p) => p.role), ['senior-dev', 'dev0']);
  assert.equal(rows.find((p) => p.role === 'dev0')?.worktreeId, s.worktreeIds[1]);
  const trees = await handleGuiRequest(
    { id: '2', method: 'gui.worktrees', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(trees.ok, true);
  assert.equal((trees.ok ? trees.result as GuiWorktree[] : [])[0]?.autoApprove, false);
});

test('gui.personas reports a matching running session', async (t) => {
  const s = setup();
  track(t, s);
  seedRunningSession(s, s.personaIds[1]!, s.worktreeIds[1]!);

  const response = await handleGuiRequest(
    { id: '1', method: 'gui.personas', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(response.ok, true);
  const rows = response.ok ? response.result as GuiPersona[] : [];
  assert.equal(rows.find((p) => p.id === s.personaIds[1])?.running, true);
  assert.equal(rows.find((p) => p.id === s.personaIds[0])?.running, false);
});

test('gui.mail returns metadata only, newest first, with a bounded limit', async (t) => {
  const s = setup();
  track(t, s);
  for (let i = 0; i <= 500; i++) {
    seedMail(s, i, new Date(Date.UTC(2026, 10, 24, 0, 0, i)).toISOString());
  }
  buildIndex(join(s.paths.cacheRoot, s.project.id, 'index.sqlite'), s.project.storeDir);

  const response = await handleGuiRequest({
    id: '3', method: 'gui.mail', params: { projectId: s.project.id, limit: 999 },
  }, ctx(s));
  assert.equal(response.ok, true);
  const rows = response.ok ? response.result as GuiMail[] : [];
  assert.equal(rows.length, 500);
  assert.deepEqual(Object.keys(rows[0]!).sort(),
    ['cc', 'createdAt', 'from', 'id', 'kind', 'subject', 'thread', 'to'].sort());
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1]!.createdAt >= rows[i]!.createdAt, `row ${i} is newer than its predecessor`);
  }
  assert.equal(rows[0]!.subject, 'Subject 500');

  const defaulted = await handleGuiRequest(
    { id: '5', method: 'gui.mail', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(defaulted.ok, true);
  const defaultRows = defaulted.ok ? defaulted.result as GuiMail[] : [];
  assert.equal(defaultRows.length, 100);
  assert.deepEqual(defaultRows.map((mail) => mail.subject),
    Array.from({ length: 100 }, (_, i) => `Subject ${500 - i}`));

  const filtered = await handleGuiRequest({
    id: '4', method: 'gui.mail', params: { projectId: s.project.id, recipient: 'dev0', limit: 2 },
  }, ctx(s));
  assert.equal(filtered.ok, true);
  assert.deepEqual(
    (filtered.ok ? filtered.result as GuiMail[] : []).map((mail) => mail.subject),
    ['Subject 500', 'Subject 499'],
  );
});

test('gui.mail rejects missing, unknown and traversal project ids', async (t) => {
  const s = setup();
  track(t, s);
  seedMail(s, 0, '2026-11-24T00:00:00.000Z');
  buildIndex(join(s.paths.cacheRoot, s.project.id, 'index.sqlite'), s.project.storeDir);

  const cases: Array<[string, string | undefined]> = [
    ['1', undefined],
    ['2', 'no-such-project'],
    ['3', '..'],
    ['4', '../../etc'],
  ];
  for (const [id, projectId] of cases) {
    const response = await handleGuiRequest({
      id,
      method: 'gui.mail',
      params: projectId === undefined ? {} : { projectId },
    }, ctx(s));
    assert.equal(response.ok, false, id);
    if (!response.ok) assert.equal(response.error.code, 'INVALID_REQUEST', id);
  }

  const valid = await handleGuiRequest(
    { id: '5', method: 'gui.mail', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(valid.ok, true);
  assert.equal((valid.ok ? valid.result as GuiMail[] : []).length, 1);
});

test('acceptance fixture shows one senior dev and two developers with their mail', async (t) => {
  const s = setupAcceptance(t);
  const responses: Record<string, RpcResponse> = {};
  responses.projects = await handleGuiRequest({ id: '1', method: 'gui.projects' }, ctx(s));
  responses.personas = await handleGuiRequest(
    { id: '2', method: 'gui.personas', params: { projectId: s.project.id } }, ctx(s));
  responses.worktrees = await handleGuiRequest(
    { id: '3', method: 'gui.worktrees', params: { projectId: s.project.id } }, ctx(s));
  responses.mail = await handleGuiRequest(
    { id: '4', method: 'gui.mail', params: { projectId: s.project.id } }, ctx(s));
  for (const [method, response] of Object.entries(responses)) {
    assertReadOnlyResponse(response);
    assert.ok(response.ok, method);
  }

  const projects = responses.projects.ok ? responses.projects.result as GuiProject[] : [];
  assert.deepEqual(projects.map((project) => ({
    id: project.id, name: project.name, storeDir: project.storeDir, status: project.status,
  })), [{
    id: s.project.id, name: 'Gui', storeDir: s.project.storeDir, status: 'active',
  }]);

  const people = responses.personas.ok ? responses.personas.result as GuiPersona[] : [];
  assert.equal(people.length, 3);
  assert.deepEqual(people.map((persona) => persona.role).sort(), ['dev0', 'dev1', 'senior-dev']);
  assert.deepEqual(people.map((persona) => persona.name).sort(), ['Dev One', 'Dev Zero', 'Senior Dev']);
  assert.deepEqual(people.map((persona) => persona.worktreeId).sort(), [...s.worktreeIds].sort());

  const trees = responses.worktrees.ok ? responses.worktrees.result as GuiWorktree[] : [];
  assert.equal(trees.length, 3);
  assert.deepEqual(trees.map((tree) => tree.id).sort(), [...s.worktreeIds].sort());
  assert.deepEqual(trees.map((tree) => tree.path).sort(), [...s.worktreePaths].sort());
  assert.deepEqual(trees.map((tree) => tree.branch).sort(),
    ['artinarey/dev0', 'artinarey/dev1', 'main']);

  const mail = responses.mail.ok ? responses.mail.result as GuiMail[] : [];
  assert.equal(mail.length, 3);
  assert.deepEqual(mail.map((message) => message.to[0]).sort(), ['dev0', 'dev1', 'senior-dev']);
  assert.deepEqual(mail.map((message) => message.subject).sort(), [
    'Subject 1', 'Subject 2', 'Subject 3',
  ]);
  assert.deepEqual(mail.map((message) => message.createdAt).sort(), [
    '2026-11-24T12:00:00.000Z', '2026-11-24T12:00:01.000Z', '2026-11-24T12:00:02.000Z',
  ]);
});

function seedTask(s: Fixture, status: 'in_progress' | 'ready_for_review' = 'in_progress') {
  createTask(s.project.storeDir, {
    id: newId(), projectId: s.project.id, title: 'Ship the gate',
    scope: ['src/gate.ts'], assignee: 'dev0', status, branch: null,
    worktreeId: s.worktreeIds[1]!, createdAt: new Date().toISOString(),
  });
}

function supervisorCtx(s: Fixture, overrides: Record<string, unknown> = {}): RpcContext {
  const supervisor = {
    approvals: () => [],
    approve: async (id: string) => ({ approval: { id, status: 'approved' } }),
    toggle: () => {},
    sessions: () => [],
    stopSession: async () => true,
    sendMessage: async () => false,
    ...overrides,
  };
  return { ...ctx(s), supervisor: supervisor as unknown as RpcContext['supervisor'] };
}

test('the full GUI surface returns typed read-only snapshots with no bodies or secrets', async (t) => {
  const s = setupAcceptance(t);
  seedTask(s);
  seedTask(s, 'ready_for_review');
  mkdirSync(join(s.project.storeDir, 'events'), { recursive: true });
  appendJournal(join(s.project.storeDir, 'events', 'audit.jsonl'), {
    type: 'approval', id: 'event-1', summary: 'approved risky call',
    body: 'private body', token: 'super-secret', created_at: '2026-11-25T09:00:00.000Z',
  });
  buildIndex(join(s.paths.cacheRoot, s.project.id, 'index.sqlite'), s.project.storeDir);

  const methods = [
    'gui.projects', 'gui.personas', 'gui.worktrees', 'gui.mail', 'gui.tasks', 'gui.leases',
    'gui.sessions', 'gui.preMerge', 'gui.audit', 'gui.approvals',
  ];
  const readCtx = supervisorCtx(s, {
    approvals: () => [{
      id: 'approval-1', projectId: s.project.id, kind: 'risky_call',
      summary: 'Approved risky call', status: 'pending', worktreeId: null,
      createdAt: '2026-11-25T09:00:00.000Z',
    }],
  });
  for (const method of methods) {
    const response = await handleGuiRequest({
      id: method, method, params: { projectId: s.project.id },
    }, readCtx);
    assertReadOnlyResponse(response);
    if (!response.ok) assert.fail(`${method}: ${response.error.message}`);
  }

  const tasks = await handleGuiRequest(
    { id: 'tasks', method: 'gui.tasks', params: { projectId: s.project.id } }, ctx(s));
  assert.equal((tasks.ok ? tasks.result as unknown[] : []).length, 2);

  const preMerge = await handleGuiRequest(
    { id: 'pre', method: 'gui.preMerge', params: { projectId: s.project.id } }, ctx(s));
  const preMergeRow = (preMerge.ok ? preMerge.result as Array<{ status: string; summary: string }> : [])[0];
  // These fixtures are not git repositories: a failed comparison must never be
  // reported as a verified lease.
  assert.equal(preMergeRow?.status, 'unavailable');
  assert.match(preMergeRow?.summary ?? '', /unavailable/);

  const audit = await handleGuiRequest(
    { id: 'audit', method: 'gui.audit', params: { projectId: s.project.id } }, ctx(s));
  const rows = audit.ok ? audit.result as Array<{ text: string }> : [];
  assert.equal(rows[0]?.text, 'approved risky call');
  assert.doesNotMatch(JSON.stringify(rows), /private body|super-secret/i);
});

test('GUI actions validate input and keep user decisions on the daemon side', async (t) => {
  const s = setupAcceptance(t);
  const supervisor = supervisorCtx(s, {
    approve: async (id: string) => ({ approval: { id, status: 'rejected' } }),
  });

  const approved = await handleGuiRequest({
    id: '1', method: 'gui.approve', params: { id: 'approval-1', decision: 'rejected' },
  }, supervisor);
  assert.deepEqual(approved.ok ? approved.result : null, { id: 'approval-1', status: 'rejected' });

  const invalidDecision = await handleGuiRequest({
    id: '2', method: 'gui.approve', params: { id: 'approval-1', decision: 'maybe' },
  }, supervisor);
  assert.equal(invalidDecision.ok, false);
  if (!invalidDecision.ok) assert.equal(invalidDecision.error.code, 'INVALID_INPUT');

  const auto = await handleGuiRequest(
    { id: '3', method: 'gui.autoApprove', params: { worktreeId: s.worktreeIds[0], enabled: true } },
    ctx(s));
  assert.equal(auto.ok, true);
  const trees = await handleGuiRequest(
    { id: '4', method: 'gui.worktrees', params: { projectId: s.project.id } }, ctx(s));
  assert.equal((trees.ok ? trees.result as Array<{ autoApprove: boolean }> : [])
    .find((tree) => tree.autoApprove)?.autoApprove, true);

  const rehome = await handleGuiRequest({
    id: '5', method: 'gui.setHomeWorktree',
    params: { projectId: s.project.id, personaId: s.personaIds[1], worktreeId: s.worktreeIds[0] },
  }, ctx(s));
  assert.equal(rehome.ok, true);

  const stopped = await handleGuiRequest(
    { id: '6', method: 'gui.stopSession', params: { id: 'session-1' } }, supervisor);
  assert.deepEqual(stopped.ok ? stopped.result : null, { stopped: true });

  const chat = await handleGuiRequest({
    id: '7', method: 'gui.chat',
    params: { projectId: s.project.id, message: 'Please send the plan.' },
  }, ctx(s));
  assert.equal(chat.ok, true);
  const reply = chat.ok ? chat.result as { queued: boolean; copiedTo: string | null } : null;
  assert.equal(reply?.queued, true);
  assert.equal(reply?.copiedTo, null);

  const root = join(s.root, 'new-data-root');
  const setRoot = await handleGuiRequest(
    { id: '8', method: 'gui.setStorage', params: { dataRoot: root } }, ctx(s));
  assert.deepEqual(setRoot.ok ? setRoot.result : null, { dataRoot: root });
  assert.equal(loadConfig(join(s.paths.configDir, 'config.json')).dataRoot, root);

  const storage = await handleGuiRequest({ id: '9', method: 'gui.storage' }, ctx(s));
  assert.equal((storage.ok ? storage.result as { dataRoot: string } : null)?.dataRoot, root);

  const rejectedRoot = await handleGuiRequest(
    { id: '10', method: 'gui.setStorage', params: { dataRoot: 'relative/root' } }, ctx(s));
  assert.equal(rejectedRoot.ok, false);
  if (!rejectedRoot.ok) assert.equal(rejectedRoot.error.code, 'INVALID_INPUT');

  const relativeMove = await handleGuiRequest(
    { id: '11', method: 'gui.movePreflight', params: { projectId: s.project.id, target: 'relative/root' } },
    ctx(s));
  assert.equal(relativeMove.ok, false);
  if (!relativeMove.ok) assert.equal(relativeMove.error.code, 'INVALID_INPUT');
});

test('pre-merge compares a branch against main and applies lease coverage', async (t) => {
  const s = setupAcceptance(t);
  const repo = join(s.root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (args: string[], cwd = repo) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const commit = (cwd: string) => git([
    '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '-q', '-m', 'fixture',
  ], cwd);
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', 'base.txt']);
  commit(repo);
  const branch = 'artinarey/dev0';
  const worktreePath = join(s.root, 'branch-wt');
  git(['worktree', 'add', '-q', '-b', branch, worktreePath]);
  writeFileSync(join(worktreePath, 'outside.ts'), 'outside the lease\n');
  mkdirSync(join(worktreePath, 'src', 'nested'), { recursive: true });
  writeFileSync(join(worktreePath, 'src', 'nested', 'gate.ts'), 'nested file\n');
  git(['add', 'outside.ts', 'src/nested/gate.ts'], worktreePath);
  commit(worktreePath);
  s.registry.worktrees.upsert({
    id: s.worktreeIds[1]!, projectId: s.project.id, path: worktreePath, branch,
  });
  const tasks = [['src/gate.ts'], ['src/', './outside.ts']].map((scope) => createTask(
    s.project.storeDir, {
      id: newId(), projectId: s.project.id, title: 'Review', scope,
      assignee: 'dev0', status: 'ready_for_review', branch,
      worktreeId: s.worktreeIds[1]!, createdAt: new Date().toISOString(),
    },
  ));

  const response = await handleGuiRequest(
    { id: '1', method: 'gui.preMerge', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(response.ok, true);
  const rows = response.ok
    ? response.result as Array<{ id: string; status: string; summary: string }> : [];
  assert.equal(
    rows.find((row) => row.id === tasks[0]!.id)?.status, 'needs-review', JSON.stringify(rows),
  );
  // A normalized literal directory scope covers descendants; an exact-path
  // comparison would leave both committed files flagged as outside the lease.
  assert.equal(
    rows.find((row) => row.id === tasks[1]!.id)?.status, 'verified', JSON.stringify(rows),
  );
});

test('chat reaches a live vendor session and falls back to durable mail', async (t) => {
  const s = setupAcceptance(t);
  const live = supervisorCtx(s, { sendMessage: async () => true });
  const sent = await handleGuiRequest({
    id: '1', method: 'gui.chat',
    params: { projectId: s.project.id, message: 'Hello live session', sessionId: 'session-1' },
  }, live);
  const reply = sent.ok ? sent.result as { queued: boolean } : null;
  assert.equal(sent.ok, true);
  assert.equal(reply?.queued, false);

  const queued = await handleGuiRequest({
    id: '2', method: 'gui.chat',
    params: { projectId: s.project.id, message: 'Hello offline session', sessionId: 'session-1' },
  }, ctx(s));
  assert.equal((queued.ok ? queued.result as { queued: boolean } : null)?.queued, true);
});

test('chat queues mail to senior-dev before any persona is registered', async (t) => {
  const s = setup();
  track(t, s);
  const fresh = s.registry.projects.create({
    name: 'Fresh', repoCommonDir: join(s.root, 'fresh', '.git'),
    storeDir: join(s.paths.dataRoot, 'fresh'),
  });
  assert.equal(s.registry.personas.list(fresh.id).length, 0);

  const reply = await handleGuiRequest({
    id: '1', method: 'gui.chat',
    params: { projectId: fresh.id, message: 'Hello before any session' },
  }, ctx(s));
  assert.equal(reply.ok, true, reply.ok ? '' : reply.error.message);
  assert.equal((reply.ok ? reply.result as { queued: boolean } : null)?.queued, true);

  const mail = await handleGuiRequest({
    id: '2', method: 'gui.mail', params: { projectId: fresh.id },
  }, ctx(s));
  assert.equal((mail.ok ? mail.result as unknown[] : []).length, 1);
});

test('chat resolves the store path under the mail lock during a store switch', async (t) => {
  const s = setup();
  track(t, s);
  const movedStore = join(s.paths.dataRoot, 'moved');
  mkdirSync(movedStore, { recursive: true });

  let chat!: Promise<RpcResponse>;
  // Hold the same lock a store switch uses: the chat path must be read after
  // the registry changes, not from the snapshot taken before the request.
  await withProjectLock(s.project.id, async () => {
    chat = handleGuiRequest({
      id: '1', method: 'gui.chat',
      params: { projectId: s.project.id, message: 'Hello during a move' },
    }, ctx(s));
    s.registry.projects.updateStoreDir(s.project.id, movedStore);
  });

  const reply = await chat;
  assert.equal(reply.ok, true, reply.ok ? '' : reply.error.message);
  const mail = await handleGuiRequest({
    id: '2', method: 'gui.mail', params: { projectId: s.project.id },
  }, ctx(s));
  assert.equal((mail.ok ? mail.result as unknown[] : []).length, 1);
  assert.equal(existsSync(join(s.project.storeDir, 'mail')), false, 'old store received the mail');
});

test('chat reports a committed mail when indexing fails after the write', async (t) => {
  const s = setup();
  track(t, s);
  const index = join(s.paths.cacheRoot, s.project.id, 'index.sqlite');
  mkdirSync(dirname(index), { recursive: true });
  mkdirSync(index); // buildIndex cannot open a directory as a database

  const reply = await handleGuiRequest({
    id: '1', method: 'gui.chat',
    params: { projectId: s.project.id, message: 'Index will fail' },
  }, ctx(s));
  assert.equal(reply.ok, false);
  if (!reply.ok) {
    assert.equal(reply.error.code, 'MAIL_PARTIAL');
    assert.match(reply.error.message, /mail \S+ is committed/);
    assert.match(reply.error.message, /do not resend/);
    assert.match(reply.error.message, new RegExp(`reindex ${s.project.id}\\b`));
  }
  const files = readdirSync(join(s.project.storeDir, 'mail'), { recursive: true });
  assert.equal(files.some((file) => String(file).endsWith('.md')), true, 'mail was not committed');
});

test('Move preflight is read-only; a crash mid-copy resumes and verifies', async (t) => {
  const s = setupAcceptance(t);
  const sourceFile = join(s.project.storeDir, 'project.json');
  writeFileSync(sourceFile, '{"schema_version":1}\n');
  const target = join(s.root, 'destination');
  mkdirSync(target, { recursive: true });

  const preview = await handleGuiRequest({
    id: '1', method: 'gui.movePreflight', params: { projectId: s.project.id, target },
  }, ctx(s));
  assert.equal(preview.ok, true);
  const planned = preview.ok ? preview.result as MoveStatus : undefined;
  assert.equal(planned?.phase, 'preflight');
  assert.equal(existsSync(moveJournalPath(s.paths, s.project.id)), false);

  // A real child process dies with SIGKILL mid-move, leaving a torn journal and
  // a partial `.incoming`. The survivor must discard both, not trust them.
  const journal: MoveStatus = {
    ...planned!, phase: 'copying', startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const [journalPath, incomingPath, state] = JSON.parse(process.argv[1]);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    fs.mkdirSync(incomingPath, { recursive: true });
    fs.writeFileSync(journalPath, JSON.stringify(state) + '\\n');
    fs.writeFileSync(path.join(incomingPath, 'project.json'), 'partial bytes');
    process.kill(process.pid, 'SIGKILL');
  `;
  const killed = spawnSync(process.execPath, ['--import', 'tsx', '-e', script, JSON.stringify([
    moveJournalPath(s.paths, s.project.id), moveIncomingPath(journal), journal,
  ])], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(killed.signal, 'SIGKILL');

  const resumed = await startMove(ctx(s), s.project.id, target);
  assert.equal(resumed.phase, 'done', resumed.error ?? '');
  assert.equal(resumed.verified, true);
  const finalFile = join(moveFinalPath(resumed), 'project.json');
  assert.equal(readFileSync(finalFile, 'utf8'), readFileSync(sourceFile, 'utf8'));
  assert.ok(existsSync(join(moveFinalPath(resumed), 'manifest.json')));
  assert.equal(s.registry.projects.get(s.project.id)?.storeDir, moveFinalPath(resumed));

  const undone = await handleGuiRequest(
    { id: '2', method: 'gui.moveUndo', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(undone.ok, true);
  assert.equal(s.registry.projects.get(s.project.id)?.storeDir, s.project.storeDir);
});

test('an offline drive is typed, durable, and resumes on Reconnect', async (t) => {
  const s = setupAcceptance(t);
  writeFileSync(join(s.project.storeDir, 'project.json'), '{"schema_version":1}\n');
  const target = join(s.root, 'offline-destination');
  mkdirSync(target, { recursive: true });

  const preview = await handleGuiRequest({
    id: '1', method: 'gui.movePreflight', params: { projectId: s.project.id, target },
  }, ctx(s));
  const planned = preview.ok ? preview.result as MoveStatus : undefined;
  const journal: MoveStatus = {
    ...planned!, phase: 'copying', startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(moveJournalPath(s.paths, s.project.id)), { recursive: true });
  writeFileSync(moveJournalPath(s.paths, s.project.id), `${JSON.stringify(journal)}\n`);
  rmSync(target, { recursive: true, force: true });

  const offline = await resumeMove(ctx(s), s.project.id);
  assert.equal(offline.phase, 'offline');
  assert.match(offline.error ?? '', /STORE_OFFLINE/);
  const status = await handleGuiRequest(
    { id: '2', method: 'gui.moveStatus', params: { projectId: s.project.id } }, ctx(s));
  assert.equal((status.ok ? status.result as MoveStatus : undefined)?.phase, 'offline');

  mkdirSync(target, { recursive: true });
  const reconnected = await startMove(ctx(s), s.project.id, target);
  assert.equal(reconnected.phase, 'done');
  assert.equal(readMove(ctx(s), s.project.id).phase, 'done');
});

test('delete-old is an explicit second confirmation after a completed move', async (t) => {
  const s = setupAcceptance(t);
  writeFileSync(join(s.project.storeDir, 'project.json'), '{"schema_version":1}\n');
  const target = join(s.root, 'delete-target');
  mkdirSync(target, { recursive: true });

  const moved = await startMove(ctx(s), s.project.id, target);
  assert.equal(moved.phase, 'done');
  assert.ok(existsSync(s.project.storeDir));

  const deleted = await handleGuiRequest(
    { id: '1', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.deepEqual(deleted.ok ? deleted.result : null, { deleted: true });
  assert.equal(existsSync(s.project.storeDir), false);
  assert.equal(readMove(ctx(s), s.project.id).oldDeleted, true);

  const secondDelete = await handleGuiRequest(
    { id: '2', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(secondDelete.ok, false);
});

test('moving an already moved store excludes only the root manifest from the inventory', async (t) => {
  const s = setupAcceptance(t);
  const firstTarget = join(s.root, 'first-target');
  const secondTarget = join(s.root, 'second-target');
  mkdirSync(firstTarget);
  mkdirSync(secondTarget);
  mkdirSync(join(s.project.storeDir, 'nested'));
  writeFileSync(join(s.project.storeDir, 'nested', 'manifest.json'), 'payload\n');

  const first = await startMove(ctx(s), s.project.id, firstTarget);
  assert.equal(first.phase, 'done', first.error ?? '');
  const second = await startMove(ctx(s), s.project.id, secondTarget);
  assert.equal(second.phase, 'done', second.error ?? '');
  const manifest = JSON.parse(readFileSync(join(moveFinalPath(second), 'manifest.json'), 'utf8'));
  assert.equal(Object.hasOwn(manifest.files, 'manifest.json'), false);
  assert.equal(manifest.files['nested/manifest.json'],
    createHash('sha256').update('payload\n').digest('hex'));

  const deleted = await handleGuiRequest(
    { id: '1', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.deepEqual(deleted.ok ? deleted.result : deleted.error, { deleted: true });
  assert.equal(existsSync(moveFinalPath(first)), false);
});

test('delete-old refuses when the moved store lost a manifest file', async (t) => {
  const s = setupAcceptance(t);
  const target = join(s.root, 'missing-final-file-target');
  mkdirSync(target, { recursive: true });
  const guarded = 'guarded file\n';
  writeFileSync(join(s.project.storeDir, 'guard.md'), guarded);
  const moved = await startMove(ctx(s), s.project.id, target);
  assert.equal(moved.phase, 'done', moved.error ?? '');
  const final = moveFinalPath(moved);

  rmSync(join(final, 'guard.md'));
  const missing = await handleGuiRequest(
    { id: '1', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, 'MOVE_CHANGED');
  assert.ok(existsSync(s.project.storeDir), 'the last copy must not be deleted');

  writeFileSync(join(final, 'guard.md'), 'tampered file\n');
  const changed = await handleGuiRequest(
    { id: '2', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.equal(changed.error.code, 'MOVE_CHANGED');
  assert.ok(existsSync(s.project.storeDir));

  writeFileSync(join(final, 'guard.md'), guarded);
  const deleted = await handleGuiRequest(
    { id: '3', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(deleted.ok, true, deleted.ok ? '' : deleted.error.message);
});

test('mail written between verification and the switch is carried into the moved store', async (t) => {
  const s = setupAcceptance(t);
  const target = join(s.root, 'late-target');
  mkdirSync(target, { recursive: true });
  const preview = await handleGuiRequest({
    id: '1', method: 'gui.movePreflight', params: { projectId: s.project.id, target },
  }, ctx(s));
  assert.equal(preview.ok, true, preview.ok ? '' : preview.error.message);
  const planned = preview.ok ? preview.result as MoveStatus : undefined;
  const paths = movePaths(target, s.project.id);
  mkdirSync(paths.final, { recursive: true });
  const seed = '{"schema_version":1}\n';
  writeFileSync(join(s.project.storeDir, 'project.json'), seed);
  writeFileSync(join(paths.final, 'project.json'), seed);
  writeFileSync(join(paths.final, 'manifest.json'), `${JSON.stringify({
    schema: 1, files: { 'project.json': createHash('sha256').update(seed).digest('hex') },
  })}\n`);
  writeFileSync(join(s.project.storeDir, 'late-mail.md'), 'accepted while switching\n');
  mkdirSync(dirname(moveJournalPath(s.paths, s.project.id)), { recursive: true });
  writeFileSync(moveJournalPath(s.paths, s.project.id), `${JSON.stringify({
    ...planned!, phase: 'switching', checkpoint: 'switching',
  })}\n`);

  const resumed = await resumeMove(ctx(s), s.project.id);
  assert.equal(resumed.phase, 'done', resumed.error ?? '');
  assert.equal(readFileSync(join(paths.final, 'late-mail.md'), 'utf8'), 'accepted while switching\n');
  const deleted = await handleGuiRequest(
    { id: '2', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(deleted.ok, true, deleted.ok ? '' : deleted.error.message);
});

test('a late-write sync failure stays offline at the switching checkpoint', async (t) => {
  const s = setupAcceptance(t);
  const target = join(s.root, 'late-sync-failure-target');
  mkdirSync(target, { recursive: true });
  const preview = await handleGuiRequest({
    id: '1', method: 'gui.movePreflight', params: { projectId: s.project.id, target },
  }, ctx(s));
  assert.equal(preview.ok, true, preview.ok ? '' : preview.error.message);
  const planned = preview.ok ? preview.result as MoveStatus : undefined;
  const paths = movePaths(target, s.project.id);
  mkdirSync(paths.final, { recursive: true });
  const seed = 'seed\n';
  writeFileSync(join(paths.final, 'manifest.json'), `${JSON.stringify({
    schema: 1, files: { 'a-late.md': createHash('sha256').update(seed).digest('hex') },
  })}\n`);
  // A directory where the late file should land makes the sync fail before it
  // can write anything, leaving the manifest and source untouched.
  mkdirSync(join(paths.final, 'a-late.md'));
  writeFileSync(join(s.project.storeDir, 'a-late.md'), 'accepted while switching\n');
  mkdirSync(dirname(moveJournalPath(s.paths, s.project.id)), { recursive: true });
  writeFileSync(moveJournalPath(s.paths, s.project.id), `${JSON.stringify({
    ...planned!, phase: 'switching', checkpoint: 'switching',
  })}\n`);

  const stalled = await resumeMove(ctx(s), s.project.id);
  assert.equal(stalled.phase, 'offline', stalled.error ?? '');
  assert.match(stalled.error ?? '', /STORE_OFFLINE/);
  const journal = readMove(ctx(s), s.project.id);
  assert.equal(journal.phase, 'offline');
  assert.equal(journal.checkpoint, 'switching');
  assert.ok(existsSync(s.project.storeDir), 'the original store must remain for recovery');
  assert.equal(existsSync(join(paths.final, 'a-late.md')), true);
  const refusedDelete = await handleGuiRequest(
    { id: '2', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(refusedDelete.ok, false);

  rmSync(join(paths.final, 'a-late.md'), { recursive: true, force: true });
  const resumed = await resumeMove(ctx(s), s.project.id);
  assert.equal(resumed.phase, 'done', resumed.error ?? '');
  assert.equal(readFileSync(join(paths.final, 'a-late.md'), 'utf8'), 'accepted while switching\n');
  assert.equal(readMove(ctx(s), s.project.id).phase, 'done');
});

test('a resumed move merges source and destination journal appends after a failed sync', async (t) => {
  const s = setupAcceptance(t);
  const target = join(s.root, 'late-journal-target');
  mkdirSync(target, { recursive: true });
  const preview = await handleGuiRequest({
    id: '1', method: 'gui.movePreflight', params: { projectId: s.project.id, target },
  }, ctx(s));
  assert.equal(preview.ok, true, preview.ok ? '' : preview.error.message);
  const planned = preview.ok ? preview.result as MoveStatus : undefined;
  const paths = movePaths(target, s.project.id);
  const journal = 'events/audit.jsonl';
  const base = '{"event":"base"}\n';
  const late = '{"event":"source-late"}\n';
  const fresh = '{"event":"destination-fresh"}\n';
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');

  mkdirSync(dirname(join(paths.final, journal)), { recursive: true });
  mkdirSync(dirname(join(s.project.storeDir, journal)), { recursive: true });
  writeFileSync(join(paths.final, journal), base);
  writeFileSync(join(s.project.storeDir, journal), base + late);
  writeFileSync(join(paths.final, 'manifest.json'), `${JSON.stringify({
    schema: 1, files: { [journal]: hash(base), 'a-late.md': hash('seed\n') },
  })}\n`);
  // This blocker fails the first sync before the journal is merged.
  writeFileSync(join(s.project.storeDir, 'a-late.md'), 'accepted while switching\n');
  mkdirSync(join(paths.final, 'a-late.md'));
  mkdirSync(dirname(moveJournalPath(s.paths, s.project.id)), { recursive: true });
  writeFileSync(moveJournalPath(s.paths, s.project.id), `${JSON.stringify({
    ...planned!, phase: 'switching', checkpoint: 'switching',
  })}\n`);

  const stalled = await resumeMove(ctx(s), s.project.id);
  assert.equal(stalled.phase, 'offline', stalled.error ?? '');
  // A new append lands in the live store while the move is offline.
  writeFileSync(join(paths.final, journal), base + fresh);
  rmSync(join(paths.final, 'a-late.md'), { recursive: true, force: true });

  const resumed = await resumeMove(ctx(s), s.project.id);
  assert.equal(resumed.phase, 'done', resumed.error ?? '');
  assert.deepEqual(
    readFileSync(join(paths.final, journal), 'utf8').trim().split('\n'),
    ['{"event":"base"}', '{"event":"source-late"}', '{"event":"destination-fresh"}'],
  );
  const manifest = JSON.parse(readFileSync(join(paths.final, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files[journal], hash(base + late + fresh));
});

test('a failure after the switch keeps its checkpoint and resumes finalisation', async (t) => {
  const s = setupAcceptance(t);
  const target = join(s.root, 'checkpoint-target');
  mkdirSync(target, { recursive: true });
  const preview = await handleGuiRequest({
    id: '1', method: 'gui.movePreflight', params: { projectId: s.project.id, target },
  }, ctx(s));
  assert.equal(preview.ok, true);
  const planned = preview.ok ? preview.result as MoveStatus : undefined;
  mkdirSync(dirname(moveJournalPath(s.paths, s.project.id)), { recursive: true });
  writeFileSync(moveJournalPath(s.paths, s.project.id), `${JSON.stringify({
    ...planned!, phase: 'switching', checkpoint: 'switching',
  })}\n`);

  const offline = await startMove(ctx(s), s.project.id, target);
  assert.equal(offline.phase, 'offline');
  assert.equal(readMove(ctx(s), s.project.id).checkpoint, 'switching');

  const paths = movePaths(target, s.project.id);
  mkdirSync(paths.final, { recursive: true });
  const seed = 'seed\n';
  writeFileSync(join(paths.final, 'project.json'), seed);
  writeFileSync(join(paths.final, 'manifest.json'), `${JSON.stringify({
    schema: 1, files: { 'project.json': createHash('sha256').update(seed).digest('hex') },
  })}\n`);
  const resumed = await resumeMove(ctx(s), s.project.id);
  assert.equal(resumed.phase, 'done', resumed.error ?? '');
  assert.equal(s.registry.projects.get(s.project.id)?.storeDir, paths.final);
});

test('undo and delete-old require unchanged stores, and a new move clears oldDeleted', async (t) => {
  const s = setupAcceptance(t);
  const target = join(s.root, 'guard-target');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(s.project.storeDir, 'guard.md'), 'guarded file\n');
  const moved = await startMove(ctx(s), s.project.id, target);
  assert.equal(moved.phase, 'done');

  writeFileSync(join(moveFinalPath(moved), 'extra.md'), 'new mail in the moved store\n');
  const refusedUndo = await handleGuiRequest(
    { id: '1', method: 'gui.moveUndo', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(refusedUndo.ok, false);
  if (!refusedUndo.ok) assert.equal(refusedUndo.error.code, 'MOVE_CHANGED');
  rmSync(join(moveFinalPath(moved), 'extra.md'));

  rmSync(join(moveFinalPath(moved), 'guard.md'));
  const refusedDeletedUndo = await handleGuiRequest(
    { id: '2', method: 'gui.moveUndo', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(refusedDeletedUndo.ok, false);
  if (!refusedDeletedUndo.ok) assert.equal(refusedDeletedUndo.error.code, 'MOVE_CHANGED');
  writeFileSync(join(moveFinalPath(moved), 'guard.md'), 'guarded file\n');

  writeFileSync(join(s.project.storeDir, 'late.md'), 'late mail in the old store\n');
  const refusedDelete = await handleGuiRequest(
    { id: '2', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(refusedDelete.ok, false);
  if (!refusedDelete.ok) assert.equal(refusedDelete.error.code, 'MOVE_CHANGED');
  assert.ok(existsSync(s.project.storeDir));
  rmSync(join(s.project.storeDir, 'late.md'));

  const deleted = await handleGuiRequest(
    { id: '3', method: 'gui.moveDeleteOld', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(deleted.ok, true);

  const nextTarget = join(s.root, 'next-target');
  mkdirSync(nextTarget, { recursive: true });
  const second = await startMove(ctx(s), s.project.id, nextTarget);
  assert.equal(second.phase, 'done');
  assert.equal(second.oldDeleted, false);
  assert.equal(readMove(ctx(s), s.project.id).oldDeleted, false);
});
