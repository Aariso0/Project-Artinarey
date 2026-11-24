import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  appendSession, buildIndex, newId, openRegistry, resolveXdgPaths, serializeMail,
  sessionLogFile, writeMarker, type SessionSummary,
} from '@artinarey/core';
import {
  handleGuiRequest, type GuiMail, type GuiPersona, type GuiProject, type GuiWorktree,
} from './gui.ts';
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
  assert.ok(fieldCount > 0);
  assert.doesNotMatch(JSON.stringify(rows), /private body/i);
}

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
