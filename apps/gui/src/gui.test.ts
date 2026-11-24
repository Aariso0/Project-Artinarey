import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  App, AppView, initialScopeState, loadScopedSnapshots, mailRecipientOptions, scopeReducer,
  scopedMailQuery, type ScopeState, type Snapshots,
} from './App.tsx';
import { createApi, type DaemonError, type GuiApi, type InvokeFn } from './api.ts';

const here = dirname(fileURLToPath(import.meta.url));

const snapshots: Snapshots = {
  projects: [{
    id: 'project-1',
    name: 'Artinarey',
    storeDir: '/tmp/artinarey/store',
    bytes: 1_073_741_824,
    freeBytes: 536_870_912,
    status: 'active',
  }],
  personas: [
    {
      id: 'agent-0', role: 'senior-dev', name: 'Senior Dev',
      worktreeId: 'worktree-0', lastVendorSessionId: null, running: false,
    },
    {
      id: 'agent-1', role: 'dev0', name: 'Dev Zero',
      worktreeId: 'worktree-1', lastVendorSessionId: 'vendor-1', running: true,
    },
    {
      id: 'agent-2', role: 'dev1', name: 'Dev One',
      worktreeId: 'worktree-2', lastVendorSessionId: null, running: false,
    },
  ],
  worktrees: [
    {
      id: 'worktree-0', path: '/tmp/artinarey/wt0', branch: 'main',
      locked: false, prunable: false, personaId: 'agent-0', autoApprove: false,
    },
    {
      id: 'worktree-1', path: '/tmp/artinarey/wt1', branch: 'dev0',
      locked: false, prunable: false, personaId: 'agent-1', autoApprove: false,
    },
    {
      id: 'worktree-2', path: '/tmp/artinarey/wt2', branch: 'dev1',
      locked: true, prunable: false, personaId: 'agent-2', autoApprove: false,
    },
  ],
  mail: [{
    id: 'mail-1', thread: 'thread-1', from: 'senior-dev', to: ['dev0', 'dev1'],
    cc: ['senior-dev'], subject: 'Subject: seeded route', kind: 'note',
    createdAt: '2026-11-24T10:00:00.000Z',
  }],
};

/** Server rendering must never touch the daemon, so any call is a test failure. */
const offlineApi: GuiApi = {
  projects: () => { throw new Error('server render called projects'); },
  personas: () => { throw new Error('server render called personas'); },
  worktrees: () => { throw new Error('server render called worktrees'); },
  mail: () => { throw new Error('server render called mail'); },
};

test('renders one senior dev, two developers and read-only mail metadata', () => {
  const html = renderToStaticMarkup(createElement(App, { api: offlineApi, initial: snapshots }));

  assert.match(html, /senior-dev/);
  assert.match(html, /dev0/);
  assert.match(html, /dev1/);
  assert.match(html, /Subject: seeded route/);
  assert.match(html, /\/tmp\/artinarey\/store/);
  assert.match(html, /1,073,741,824/);
  assert.match(html, /536,870,912/);
  assert.match(html, /active/);
  assert.match(html, /thread-1/);
  assert.match(html, /2026-11-24T10:00:00.000Z/);
  assert.match(html, /&#x2F;logo\.svg|\/logo\.svg/);
  assert.equal(html.match(/Scoped to Artinarey/g)?.length, 3);

  assert.equal(html.match(/<select\b/g)?.length, 2);
  assert.equal(html.match(/data-readonly-select="true"/g)?.length, 2);
  assert.match(html, /value="all"/);
  for (const role of ['senior-dev', 'dev0', 'dev1']) {
    assert.ok(html.includes(`>${role}<`), `${role} is a selectable mail recipient`);
  }
  assert.doesNotMatch(html, /data-mutating-action/);
  assert.doesNotMatch(html, /<(input|textarea|button|form)\b/i);
  assert.doesNotMatch(html, /private body/i);
  assert.doesNotMatch(html, /read state/i);
});

/** Mirrors packages/daemon/src/gui.test.ts acceptance fixture, with no live daemon call. */
const acceptanceSnapshots: Snapshots = {
  projects: [{
    id: 'project-1',
    name: 'Gui',
    storeDir: '/tmp/artinarey-acceptance/data/store',
    bytes: 1_073_741_824,
    freeBytes: 536_870_912,
    status: 'active',
  }],
  personas: [
    {
      id: 'persona-0', role: 'senior-dev', name: 'Senior Dev',
      worktreeId: 'worktree-0', lastVendorSessionId: null, running: false,
    },
    {
      id: 'persona-1', role: 'dev0', name: 'Dev Zero',
      worktreeId: 'worktree-1', lastVendorSessionId: null, running: false,
    },
    {
      id: 'persona-2', role: 'dev1', name: 'Dev One',
      worktreeId: 'worktree-2', lastVendorSessionId: null, running: false,
    },
  ],
  worktrees: [
    {
      id: 'worktree-0', path: '/tmp/artinarey-acceptance/wt1', branch: 'main',
      locked: false, prunable: false, personaId: 'persona-0', autoApprove: false,
    },
    {
      id: 'worktree-1', path: '/tmp/artinarey-acceptance/wt2', branch: 'artinarey/dev0',
      locked: false, prunable: false, personaId: 'persona-1', autoApprove: false,
    },
    {
      id: 'worktree-2', path: '/tmp/artinarey-acceptance/wt3', branch: 'artinarey/dev1',
      locked: false, prunable: false, personaId: 'persona-2', autoApprove: false,
    },
  ],
  mail: [
    {
      id: 'mail-0001', thread: 'thread-1', from: 'senior-dev', to: ['senior-dev'],
      cc: [], subject: 'Subject 1', kind: 'note', createdAt: '2026-11-24T12:00:00.000Z',
    },
    {
      id: 'mail-0002', thread: 'thread-1', from: 'senior-dev', to: ['dev0'],
      cc: [], subject: 'Subject 2', kind: 'note', createdAt: '2026-11-24T12:00:01.000Z',
    },
    {
      id: 'mail-0003', thread: 'thread-1', from: 'senior-dev', to: ['dev1'],
      cc: [], subject: 'Subject 3', kind: 'note', createdAt: '2026-11-24T12:00:02.000Z',
    },
  ],
};

test('acceptance fixture renders three agents, three mail rows and no mutating controls', () => {
  const html = renderToStaticMarkup(createElement(App, {
    api: offlineApi, initial: acceptanceSnapshots,
  }));

  for (const name of ['Senior Dev', 'Dev Zero', 'Dev One']) {
    assert.ok(html.includes(name), `${name} is visible`);
  }
  for (const subject of ['Subject 1', 'Subject 2', 'Subject 3']) {
    assert.ok(html.includes(subject), `${subject} is visible`);
  }
  for (const recipient of ['senior-dev', 'dev0', 'dev1']) {
    assert.ok(html.includes(`>${recipient}<`), `${recipient} is a visible mail recipient`);
  }
  assert.equal(html.match(/Scoped to Gui/g)?.length, 3);
  assert.equal(html.match(/<select\b/g)?.length, 2);
  assert.equal(html.match(/data-readonly-select="true"/g)?.length, 2);
  assert.match(html, /value="all"/);
  assert.doesNotMatch(html, /<(input|textarea|button|form)\b/i);
  assert.doesNotMatch(html, /\son(click|change|input|submit)=/i);
  assert.doesNotMatch(html, /data-mutating-action/i);
  assert.doesNotMatch(html, /private body/i);
});

test('the window labels an empty project scope', () => {
  const html = renderToStaticMarkup(createElement(App, {
    api: offlineApi,
    initial: { ...snapshots, projects: [] },
  }));
  assert.equal(html.match(/No project selected/g)?.length, 3);
});

test('a typed daemon error renders visibly instead of an empty window', () => {
  const error: DaemonError = { code: 'BAD_ORIGIN', message: 'Origin not allowed on /rpc' };
  const html = renderToStaticMarkup(createElement(App, { api: offlineApi, initialError: error }));

  assert.match(html, /BAD_ORIGIN/);
  assert.match(html, /Origin not allowed on &#x2F;rpc|Origin not allowed on \/rpc/);
  assert.match(html, /role="alert"/);
});

test('App without seeded props is renderable without Tauri globals', () => {
  const html = renderToStaticMarkup(createElement(App, { api: offlineApi }));
  assert.match(html, /Loading/i);
  assert.doesNotMatch(html, /data-mutating-action/);
});

test('createApi invokes only the four read-only daemon methods', async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke: InvokeFn = async (command, args) => {
    calls.push({ command, args });
    return { ok: true, result: [] };
  };
  const api = createApi(invoke);

  await api.projects();
  await api.personas('project-1');
  await api.worktrees('project-1');
  await api.mail({ projectId: 'project-1', recipient: 'dev0' });

  assert.deepEqual(calls, [
    { command: 'daemon_call', args: { method: 'gui.projects', params: {} } },
    { command: 'daemon_call', args: { method: 'gui.personas', params: { projectId: 'project-1' } } },
    { command: 'daemon_call', args: { method: 'gui.worktrees', params: { projectId: 'project-1' } } },
    {
      command: 'daemon_call',
      args: { method: 'gui.mail', params: { projectId: 'project-1', recipient: 'dev0' } },
    },
  ]);
});

test('createApi rejects with the daemon error object, not a blank result', async () => {
  const error: DaemonError = { code: 'BAD_ORIGIN', message: 'rejected' };
  const api = createApi(async () => ({ ok: false, error }));

  for (const call of [
    () => api.projects(),
    () => api.personas('project-1'),
    () => api.worktrees('project-1'),
    () => api.mail({ projectId: 'project-1' }),
  ]) {
    await assert.rejects(call(), (rejected: unknown) => {
      assert.deepEqual(rejected, error);
      return true;
    });
  }
});

test('createApi accepts a bare array result returned by the native command', async () => {
  const api = createApi(async () => snapshots.projects);
  assert.deepEqual(await api.projects(), snapshots.projects);
  assert.deepEqual(await createApi(async () => []).mail({ projectId: 'project-1' }), []);
});

test('createApi rejects every non-array result with BAD_RESPONSE', async () => {
  const invalidReplies: unknown[] = [
    { nested: ['value'] },
    { ok: true, result: { nested: ['value'] } },
    { ok: true, result: null },
    42,
  ];
  for (const reply of invalidReplies) {
    const api = createApi(async () => reply);
    for (const call of [
      () => api.projects(),
      () => api.personas('project-1'),
      () => api.worktrees('project-1'),
      () => api.mail({ projectId: 'project-1' }),
    ]) {
      await assert.rejects(call(), (rejected: unknown) => {
        assert.deepEqual(rejected, { code: 'BAD_RESPONSE', message: 'malformed daemon reply' });
        return true;
      });
    }
  }
});

test('a selected project and mail recipient reload only the scoped snapshots', async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const api = createApi(async (command, args) => {
    calls.push({ command, args });
    return [];
  });

  await loadScopedSnapshots(api, 'project-1', 'all');
  await loadScopedSnapshots(api, 'project-2', 'dev0');

  assert.deepEqual(calls, [
    { command: 'daemon_call', args: { method: 'gui.personas', params: { projectId: 'project-1' } } },
    { command: 'daemon_call', args: { method: 'gui.worktrees', params: { projectId: 'project-1' } } },
    { command: 'daemon_call', args: { method: 'gui.mail', params: { projectId: 'project-1' } } },
    { command: 'daemon_call', args: { method: 'gui.personas', params: { projectId: 'project-2' } } },
    { command: 'daemon_call', args: { method: 'gui.worktrees', params: { projectId: 'project-2' } } },
    {
      command: 'daemon_call',
      args: { method: 'gui.mail', params: { projectId: 'project-2', recipient: 'dev0' } },
    },
  ]);
});

test('mail recipients are derived from persona roles with an unfiltered option', async () => {
  assert.deepEqual(mailRecipientOptions(snapshots.personas), ['all', 'senior-dev', 'dev0', 'dev1']);
  assert.deepEqual(
    mailRecipientOptions([snapshots.personas[1], snapshots.personas[1]]),
    ['all', 'dev0'],
  );
  assert.deepEqual(scopedMailQuery('project-1', 'all'), { projectId: 'project-1' });
  assert.deepEqual(scopedMailQuery('project-1', 'dev0'), {
    projectId: 'project-1', recipient: 'dev0',
  });
});

const twoProjectSnapshots: Snapshots = {
  ...snapshots,
  projects: [
    ...snapshots.projects,
    { ...snapshots.projects[0], id: 'project-2', name: 'Beta' },
  ],
};

/** React marks the selected option rather than emitting a value on <select>. */
function selectedValue(html: string, id: string): string | undefined {
  const start = html.indexOf(`<select id="${id}"`);
  if (start < 0) return undefined;
  const select = html.slice(start, html.indexOf('</select>', start));
  return select.match(/<option value="([^"]*)" selected="">/)?.[1];
}

function renderScope(state: ScopeState): string {
  return renderToStaticMarkup(createElement(AppView, {
    snapshots: twoProjectSnapshots,
    loadedScope: state.loaded,
    error: null,
    loading: false,
    scopeLoading: false,
    onChooseProject: () => {},
    onChooseRecipient: () => {},
  }));
}

test('a failed project switch keeps the loaded project on the selects and scope labels', () => {
  const requested = scopeReducer(initialScopeState('project-1'), {
    type: 'chooseProject', projectId: 'project-2',
  });
  assert.deepEqual(requested.loaded, { projectId: 'project-1', recipient: 'all' });
  assert.deepEqual(requested.request, { projectId: 'project-2', recipient: 'all' });

  const failed = scopeReducer(requested, { type: 'requestFailed' });
  assert.deepEqual(failed.loaded, { projectId: 'project-1', recipient: 'all' });
  assert.equal(failed.request, null);

  for (const state of [requested, failed]) {
    const html = renderScope(state);
    assert.equal(selectedValue(html, 'project-select'), 'project-1');
    assert.equal(selectedValue(html, 'recipient-select'), 'all');
    assert.equal(html.match(/Scoped to Artinarey/g)?.length, 3);
    assert.doesNotMatch(html, /Scoped to Beta/);
  }
});

test('a failed recipient change keeps the previously loaded recipient on the filter', () => {
  const loaded: ScopeState = {
    loaded: { projectId: 'project-1', recipient: 'dev0' },
    request: null,
  };
  const requested = scopeReducer(loaded, { type: 'chooseRecipient', recipient: 'dev1' });
  assert.deepEqual(requested.loaded, loaded.loaded);
  assert.deepEqual(requested.request, { projectId: 'project-1', recipient: 'dev1' });

  const afterFailedProject = scopeReducer(
    scopeReducer(loaded, { type: 'chooseProject', projectId: 'project-2' }),
    { type: 'chooseRecipient', recipient: 'dev1' },
  );
  assert.deepEqual(afterFailedProject.request, { projectId: 'project-1', recipient: 'dev1' });

  const failed = scopeReducer(requested, { type: 'requestFailed' });
  assert.deepEqual(failed.loaded, loaded.loaded);
  const html = renderScope(failed);
  assert.equal(selectedValue(html, 'recipient-select'), 'dev0');
  assert.equal(selectedValue(html, 'project-select'), 'project-1');
  assert.ok(html.includes('>dev1<'), 'the rejected recipient is still an option, but not selected');
});

test('successful reloads update the displayed project and recipient scope', () => {
  const projectRequested = scopeReducer(initialScopeState('project-1'), {
    type: 'chooseProject', projectId: 'project-2',
  });
  const projectLoaded = scopeReducer(projectRequested, {
    type: 'loadSucceeded', scope: { projectId: 'project-2', recipient: 'all' },
  });
  assert.deepEqual(projectLoaded.loaded, { projectId: 'project-2', recipient: 'all' });
  let html = renderScope(projectLoaded);
  assert.equal(selectedValue(html, 'project-select'), 'project-2');
  assert.equal(html.match(/Scoped to Beta/g)?.length, 3);
  assert.doesNotMatch(html, /Scoped to Artinarey/);

  const recipientRequested = scopeReducer(projectLoaded, {
    type: 'chooseRecipient', recipient: 'dev1',
  });
  const recipientLoaded = scopeReducer(recipientRequested, {
    type: 'loadSucceeded', scope: { projectId: 'project-2', recipient: 'dev1' },
  });
  html = renderScope(recipientLoaded);
  assert.equal(selectedValue(html, 'project-select'), 'project-2');
  assert.equal(selectedValue(html, 'recipient-select'), 'dev1');
});

test('createApi normalizes a rejected native error object', async () => {
  const error = { code: 'BAD_ORIGIN', message: 'Origin not allowed on /rpc' };
  const api = createApi(async () => { throw error; });

  for (const call of [
    () => api.projects(),
    () => api.personas('project-1'),
    () => api.worktrees('project-1'),
    () => api.mail({ projectId: 'project-1' }),
  ]) {
    await assert.rejects(call(), (rejected: unknown) => {
      assert.deepEqual(rejected, error);
      return true;
    });
  }
});

test('createApi normalizes a non-object rejection into a typed error', async () => {
  const api = createApi(async () => { throw 'native failure'; });
  await assert.rejects(api.projects(), (rejected: unknown) => {
    assert.deepEqual(rejected, { code: 'INTERNAL_ERROR', message: 'native failure' });
    return true;
  });
});

test('createApi handles envelope-shaped replies defensively', async () => {
  await assert.rejects(createApi(async () => ({ ok: true })).projects(), (rejected: unknown) => {
    assert.deepEqual(rejected, { code: 'BAD_RESPONSE', message: 'malformed daemon reply' });
    return true;
  });
  const error: DaemonError = { code: 'FORBIDDEN_METHOD', message: 'not callable' };
  await assert.rejects(createApi(async () => ({ error })).projects(), (rejected: unknown) => {
    assert.deepEqual(rejected, error);
    return true;
  });
});

test('createApi maps a non-object daemon reply to a typed error', async () => {
  const api = createApi(async () => null);
  await assert.rejects(api.projects(), (rejected: unknown) => {
    assert.deepEqual(rejected, { code: 'BAD_RESPONSE', message: 'malformed daemon reply' });
    return true;
  });
});

test('frontend sources pin the no-mutating-method rule', () => {
  const apiSource = readFileSync(join(here, 'api.ts'), 'utf8');
  const methods = [...apiSource.matchAll(/method:\s*'([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(methods, ['gui.mail', 'gui.personas', 'gui.projects', 'gui.worktrees']);
  assert.doesNotMatch(apiSource, /\b(send_mail|approve|token|port|fetch|localStorage|http|rpc)\b/i);

  for (const file of ['App.tsx', 'components.tsx', 'main.tsx']) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.doesNotMatch(source, /\binvoke\s*\(|\bsend_mail\b|\bapprove\b|\btoken\b/i, file);
  }
});
