import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  App, AppView, initialScopeState, mailRecipientOptions, scopeReducer, scopedMailQuery,
  typedError, type ScopeState, type Snapshots,
} from './App.tsx';
import { createApi, type DaemonError, type GuiApi, type InvokeFn } from './api.ts';
import {
  ApprovalsView, AuditView, ChatView, PreMergeView, SessionsView, StorageView, TasksView,
} from './components.tsx';

const here = dirname(fileURLToPath(import.meta.url));

const snapshots: Snapshots = {
  projects: [{
    id: 'project-1', name: 'Artinarey', storeDir: '/tmp/artinarey/store',
    bytes: 1_073_741_824, freeBytes: 536_870_912, status: 'active',
  }],
  personas: [
    { id: 'agent-0', role: 'senior-dev', name: 'Senior Dev', worktreeId: 'worktree-0', lastVendorSessionId: null, running: false },
    { id: 'agent-1', role: 'dev0', name: 'Dev Zero', worktreeId: 'worktree-1', lastVendorSessionId: 'vendor-1', running: true },
    { id: 'agent-2', role: 'dev1', name: 'Dev One', worktreeId: 'worktree-2', lastVendorSessionId: null, running: false },
  ],
  worktrees: [
    { id: 'worktree-0', path: '/tmp/artinarey/wt0', branch: 'main', locked: false, prunable: false, personaId: 'agent-0', autoApprove: false },
    { id: 'worktree-1', path: '/tmp/artinarey/wt1', branch: 'dev0', locked: false, prunable: false, personaId: 'agent-1', autoApprove: true },
    { id: 'worktree-2', path: '/tmp/artinarey/wt2', branch: 'dev1', locked: true, prunable: false, personaId: 'agent-2', autoApprove: false },
  ],
  mail: [{
    id: 'mail-1', thread: 'thread-1', from: 'senior-dev', to: ['dev0', 'dev1'],
    cc: ['senior-dev'], subject: 'Subject: seeded route', kind: 'note',
    createdAt: '2026-11-24T10:00:00.000Z',
  }],
  tasks: [{
    id: 'task-1', title: 'Ship the gate', status: 'active', assignee: 'dev0',
    worktreeId: 'worktree-1', updatedAt: '2026-11-25T10:00:00.000Z',
  }],
  leases: [{
    id: 'lease-1', projectId: 'project-1', worktreeId: 'worktree-1', personaId: 'agent-1',
    paths: ['/tmp/artinarey/wt1/src'], reason: 'editing source', expiresAt: null,
  }],
  sessions: [{
    id: 'session-1', projectId: 'project-1', worktreeId: 'worktree-1', personaId: 'agent-1',
    vendor: 'opencode', vendorSessionId: 'vendor-1', status: 'running',
    startedAt: '2026-11-25T09:00:00.000Z', endedAt: null,
  }],
  preMerge: [{
    id: 'check-1', worktreeId: 'worktree-1', status: 'verified',
    summary: 'lease scopes verified', checkedAt: '2026-11-25T09:30:00.000Z',
  }],
  audit: [{
    id: 'event-1', at: '2026-11-25T09:31:00.000Z', type: 'approval',
    text: 'approved risky call',
  }],
  approvals: [{
    id: 'approval-1', projectId: 'project-1', kind: 'spawn_over_cap',
    summary: 'Spawn a fourth developer', status: 'pending',
    worktreeId: null, requestedAt: '2026-11-25T09:32:00.000Z',
  }],
  storage: {
    dataRoot: '/tmp/artinarey',
    projects: [{ id: 'project-1', name: 'Artinarey', storeDir: '/tmp/artinarey/store', bytes: 1024, freeBytes: 512 }],
  },
};

/** Server rendering must never touch the daemon, so any call is a test failure. */
const offlineApi: GuiApi = new Proxy({} as GuiApi, {
  get(_target, property) {
    return () => { throw new Error(`server render called ${String(property)}`); };
  },
});

function renderApp(overrides: Partial<Snapshots> = {}): string {
  return renderToStaticMarkup(createElement(App, {
    api: offlineApi,
    initial: { ...snapshots, ...overrides },
  }));
}

function renderView(component: React.ReactElement): string {
  return renderToStaticMarkup(component);
}

function renderAppView(state?: ScopeState): string {
  return renderToStaticMarkup(createElement(AppView, {
    api: offlineApi,
    snapshots,
    loadedScope: state?.loaded ?? initialScopeState('project-1').loaded,
    error: null,
    loading: false,
    scopeLoading: false,
    section: 'workspace',
    onSection: () => {},
    onChooseProject: () => {},
    onChooseRecipient: () => {},
    onRefresh: () => {},
    onActionError: () => {},
  }));
}

test('the full window renders real state, controls and the four workspace tabs', () => {
  const html = renderApp();
  for (const value of ['Artinarey', 'Senior Dev', 'Dev Zero', 'Dev One', 'Ship the gate',
    '1,073,741,824', '536,870,912', 'worktree-1', '/tmp/artinarey/store']) {
    assert.ok(html.includes(value), `${value} is visible`);
  }
  for (const label of ['Overview', 'Chat', 'Approvals', 'Storage',
    'Tasks &amp; leases', 'Sessions', 'Pre-merge', 'Audit', 'New worktree', 'Adopt']) {
    assert.ok(html.includes(label), `${label} is present`);
  }
  assert.equal(html.match(/role="tab"/g)?.length, 4);
  assert.equal(html.match(/<select\b/g)?.length, 2);
  assert.ok(html.includes('logo-dark.svg'), 'the transparent in-app mark is used');
  assert.doesNotMatch(html, /#0d1117|#161b22|#30363d/);
  assert.match(html, /role="switch"/);
  assert.match(html, /auto-approve/i);
});

test('dialogs are closed by default and do not leak warning text into the window', () => {
  const html = renderApp();
  assert.doesNotMatch(html, /Adopting an unmanaged worktree/);
  assert.doesNotMatch(html, /Worktree blocked/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test('view components render their own empty and loaded states', () => {
  const tasks = renderView(createElement(TasksView, {
    tasks: [], leases: [], autoApprove: {}, onAutoApprove: () => {},
  }));
  assert.match(tasks, /No tasks/);
  assert.match(tasks, /No active leases/);

  const sessions = renderView(createElement(SessionsView, { sessions: snapshots.sessions, onStop: () => {} }));
  assert.match(sessions, /vendor-1/);
  assert.match(sessions, /Stop session session-1/);

  const approvals = renderView(createElement(ApprovalsView, { approvals: snapshots.approvals, onDecide: () => {} }));
  assert.match(approvals, /spawn_over_cap/);
  assert.match(approvals, /Approve/);
  assert.match(approvals, /Reject/);

  const audit = renderView(createElement(AuditView, { rows: snapshots.audit }));
  assert.match(audit, /approved risky call/);

  const premerge = renderView(createElement(PreMergeView, { rows: snapshots.preMerge }));
  assert.match(premerge, /lease scopes verified/);

  const chat = renderView(createElement(ChatView, { replies: [], onSend: () => {}, busy: false }));
  assert.match(chat, /Start a conversation/);
  assert.match(chat, /<input\b/);

  const storage = renderView(createElement(StorageView, {
    storage: snapshots.storage, move: null, target: '', onTarget: () => {},
    onSetRoot: () => {}, onPreflight: () => {}, onMove: () => {}, onReconnect: () => {},
    onUndo: () => {}, onDeleteOld: () => {}, busy: false,
  }));
  assert.match(storage, /Storage settings/);
  assert.match(storage, /Move store/);
  assert.match(storage, /\/tmp\/artinarey/);
});

test('a typed daemon error renders visibly instead of an empty window', () => {
  const html = renderToStaticMarkup(createElement(App, {
    api: offlineApi,
    initial: snapshots,
    initialError: { code: 'BAD_ORIGIN', message: 'Origin not allowed on /rpc' },
  }));
  assert.match(html, /BAD_ORIGIN/);
  assert.match(html, /Origin not allowed on &#x2F;rpc|Origin not allowed on \/rpc/);
  assert.match(html, /role="alert"/);
});

test('App without seeded props is renderable without Tauri globals', () => {
  const html = renderToStaticMarkup(createElement(App, { api: offlineApi }));
  assert.match(html, /Loading|skeleton/i);
});

test('createApi invokes only the daemon_call command for every feature', async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const rowMethods = new Set([
    'gui.projects', 'gui.personas', 'gui.worktrees', 'gui.mail', 'gui.tasks', 'gui.leases',
    'gui.sessions', 'gui.preMerge', 'gui.audit', 'gui.approvals',
  ]);
  const invoke: InvokeFn = async (command, args) => {
    calls.push({ command, args });
    return rowMethods.has(String(args.method)) ? [] : {};
  };
  const api = createApi(invoke);

  await api.projects();
  await api.personas('project-1');
  await api.worktrees('project-1');
  await api.mail({ projectId: 'project-1', recipient: 'dev0' });
  await api.tasks('project-1');
  await api.leases('project-1');
  await api.sessions('project-1');
  await api.preMerge('project-1');
  await api.audit('project-1', 20);
  await api.approvals('project-1');
  await api.approve('approval-1', 'approved', 'user');
  await api.autoApprove('worktree-1', true);
  await api.stopSession('session-1');
  await api.createWorktree('project-1', 'artinarey/dev2');
  await api.adoptWorktree('project-1', '/tmp/wt');
  await api.setHomeWorktree('project-1', 'agent-1', 'worktree-1');
  await api.chat('project-1', 'hello');
  await api.storage();
  await api.setStorage('/tmp/new');
  await api.movePreflight('project-1', '/tmp/target');
  await api.moveStart('project-1', '/tmp/target');
  await api.moveStatus('project-1');
  await api.moveUndo('project-1');
  await api.moveDeleteOld('project-1');

  assert.equal(calls.length, 24);
  assert.deepEqual([...new Set(calls.map((call) => call.command))], ['daemon_call']);
  assert.deepEqual(calls.slice(0, 4), [
    { command: 'daemon_call', args: { method: 'gui.projects', params: {} } },
    { command: 'daemon_call', args: { method: 'gui.personas', params: { projectId: 'project-1' } } },
    { command: 'daemon_call', args: { method: 'gui.worktrees', params: { projectId: 'project-1' } } },
    { command: 'daemon_call', args: { method: 'gui.mail', params: { projectId: 'project-1', recipient: 'dev0' } } },
  ]);
  assert.deepEqual(calls[10], {
    command: 'daemon_call', args: { method: 'gui.approve', params: { id: 'approval-1', decision: 'approved', by: 'user' } },
  });
  assert.deepEqual(calls[17], {
    command: 'daemon_call', args: { method: 'gui.storage', params: {} },
  });
});

test('createApi rejects with the daemon error object, not a blank result', async () => {
  const error: DaemonError = { code: 'BAD_ORIGIN', message: 'rejected' };
  const api = createApi(async () => ({ ok: false, error }));
  for (const call of [() => api.projects(), () => api.approvals(), () => api.storage()]) {
    await assert.rejects(call(), (rejected: unknown) => {
      assert.deepEqual(rejected, error);
      return true;
    });
  }
});

test('createApi accepts a bare object or array result from the native command', async () => {
  assert.deepEqual(await createApi(async () => snapshots.projects).projects(), snapshots.projects);
  assert.deepEqual(await createApi(async () => snapshots.storage).storage(), snapshots.storage);
  assert.deepEqual(await createApi(async () => []).tasks('project-1'), []);
});

test('createApi rejects every malformed reply with BAD_RESPONSE', async () => {
  for (const reply of [{ nested: ['v'] }, { ok: true, result: { nested: true } }, { ok: true, result: null }, 42, null]) {
    const api = createApi(async () => reply);
    await assert.rejects(api.projects(), (rejected: unknown) => {
      assert.deepEqual(rejected, { code: 'BAD_RESPONSE', message: 'malformed daemon reply' });
      return true;
    });
  }
});

test('createApi normalizes thrown errors into typed errors', async () => {
  await assert.rejects(createApi(async () => { throw { code: 'FORBIDDEN', message: 'no' }; }).projects(),
    (rejected: unknown) => {
      assert.deepEqual(rejected, { code: 'FORBIDDEN', message: 'no' });
      return true;
    });
  await assert.rejects(createApi(async () => { throw 'native failure'; }).projects(),
    (rejected: unknown) => {
      assert.deepEqual(rejected, { code: 'INTERNAL_ERROR', message: 'native failure' });
      return true;
    });
});

test('a failed scope change keeps the loaded project on the selectors', () => {
  const loaded = initialScopeState('project-1');
  const requested = scopeReducer(loaded, { type: 'chooseProject', projectId: 'project-2' });
  assert.deepEqual(requested.loaded, { projectId: 'project-1', recipient: 'all' });
  const failed = scopeReducer(requested, { type: 'requestFailed' });
  assert.deepEqual(failed.loaded, loaded.loaded);
  assert.equal(failed.request, null);

  const html = renderAppView(failed);
  const select = html.slice(html.indexOf('<select id="project-select"'));
  assert.match(select.slice(0, select.indexOf('</select>')), /value="project-1" selected=""/);
  assert.doesNotMatch(html, /value="project-2" selected=""/);
});

test('scope helpers derive mail recipients and typed errors', () => {
  assert.deepEqual(mailRecipientOptions(snapshots.personas), ['all', 'senior-dev', 'dev0', 'dev1']);
  assert.deepEqual(scopedMailQuery('project-1', 'all'), { projectId: 'project-1' });
  assert.deepEqual(scopedMailQuery('project-1', 'dev0'), { projectId: 'project-1', recipient: 'dev0' });
  assert.deepEqual(typedError({ code: 'X', message: 'y' }), { code: 'X', message: 'y' });
  assert.deepEqual(typedError('bad'), { code: 'INTERNAL_ERROR', message: 'bad' });
});

test('frontend sources keep the webview free of credentials, ports and HTTP', () => {
  const apiSource = readFileSync(join(here, 'api.ts'), 'utf8');
  const methods = [...new Set([...apiSource.matchAll(/get(?:<[^>]*>)?\('([^']+)'/g)].map((match) => match[1]))].sort();
  assert.deepEqual(methods, [
    'approvals', 'approve', 'audit', 'autoApprove', 'chat', 'createWorktree', 'adoptWorktree',
    'leases', 'mail', 'moveDeleteOld', 'movePreflight', 'moveStart', 'moveStatus', 'moveUndo',
    'personas', 'preMerge', 'projects', 'sessions', 'setHomeWorktree', 'setStorage',
    'stopSession', 'storage', 'tasks', 'worktrees',
  ].sort());
  assert.doesNotMatch(apiSource, /\b(token|port|fetch|localStorage|http|rpc|apiKey|api_key)\b/i);

  for (const file of ['App.tsx', 'components.tsx', 'ui.tsx', 'main.tsx', 'motion.ts']) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.doesNotMatch(source, /\binvoke\s*\(|\btoken\b|\bport\b|\bapiKey\b|fetch\(|localStorage/i, file);
  }
});

test('mail metadata never renders a private body or read-state field', () => {
  const html = renderApp();
  assert.doesNotMatch(html, /private body/i);
  assert.doesNotMatch(html, /\b(readAt|readState|hasRead|isRead)\b/i);
});
