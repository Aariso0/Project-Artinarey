import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPersona, createTask, newId, openRegistry, readPersona, readTasks, resolveXdgPaths,
  writeMarker, type Identity,
} from '@artinarey/core';
import {
  SessionSupervisor, spawnNotifier, type Notifier, type SessionAdapter, type TimerApi,
} from './sessions.ts';
import { dispatchTool, type RpcContext } from './tools.ts';

type ServeState = { pid: number; port: number; password: string; startedAt: string };

type FakeAdapter = SessionAdapter & {
  prompts: Array<{ sessionId: string; text: string }>;
  sessions: string[];
  interrupted: string[];
  failPrompt: boolean;
  failInterrupt: boolean;
};

function fakeAdapter(): FakeAdapter {
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const sessions: string[] = [];
  const interrupted: string[] = [];
  const state: ServeState = {
    pid: process.pid, port: 41000, password: 'pw', startedAt: 'now',
  };
  const fake: FakeAdapter = {
    prompts,
    sessions,
    interrupted,
    failPrompt: false,
    failInterrupt: false,
    async ensureServe() { return state; },
    async createSession() {
      const id = `vendor-${sessions.length + 1}`;
      sessions.push(id);
      return id;
    },
    async sendPrompt(_state, sessionId, text) {
      if (fake.failPrompt) throw new Error('prompt rejected');
      prompts.push({ sessionId, text });
    },
    async interrupt() {},
    async interruptSession(sessionId) {
      if (fake.failInterrupt) throw new Error('interrupt failed');
      interrupted.push(sessionId);
    },
  };
  return fake;
}

/** Hold launches at the first await so synchronous reservations are observable. */
function gateServe(adapter: FakeAdapter): () => void {
  let release!: () => void;
  const pending = new Promise<ServeState>((resolve) => {
    release = () => resolve({ pid: process.pid, port: 41000, password: 'pw', startedAt: 'now' });
  });
  adapter.ensureServe = async () => pending;
  return release;
}

/** Hold launches after the registry row is appended but before the vendor is ready. */
function gateCreateSession(adapter: FakeAdapter): () => void {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  adapter.createSession = async () => {
    await pending;
    const id = `vendor-${adapter.sessions.length + 1}`;
    adapter.sessions.push(id);
    return id;
  };
  return release;
}

/** Hold launches at sendPrompt so stopSession can settle the persisted row. */
function gatePrompt(adapter: FakeAdapter): () => void {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  adapter.sendPrompt = async () => { await pending; };
  return release;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20 && !condition(); attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), 'condition was not met');
}

function fakeTimers(): TimerApi & { handles: unknown[]; cleared: unknown[] } {
  const handles: unknown[] = [];
  const cleared: unknown[] = [];
  return {
    handles,
    cleared,
    set(callback, ms) {
      void ms;
      const handle = { callback };
      handles.push(handle);
      return handle;
    },
    clear(handle) { cleared.push(handle); },
  };
}

function setup(worktreeCount = 5) {
  const root = join(tmpdir(), `artinarey-sessions-${newId()}`);
  for (const dir of ['config', 'data', 'cache', 'runtime', 'roles']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const paths = resolveXdgPaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  });
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Sessions', repoCommonDir: '/r/.git', storeDir: join(paths.dataRoot, 'store'),
  });
  mkdirSync(project.storeDir, { recursive: true });

  const worktreeIds: string[] = [];
  const pathsByIndex: string[] = [];
  for (let i = 0; i < worktreeCount; i++) {
    const path = join(root, `wt${i}`);
    mkdirSync(path, { recursive: true });
    const id = newId();
    registry.worktrees.upsert({ id, projectId: project.id, path, branch: null });
    writeMarker(path, project.id, id);
    worktreeIds.push(id);
    pathsByIndex.push(path);
  }

  const senior = createPersona(registry, project.storeDir, project.id, 'senior-dev', 'Lead');
  const devs: string[] = [];
  for (let i = 0; i < worktreeCount - 1; i++) {
    devs.push(createPersona(registry, project.storeDir, project.id, `dev${i}`, `Dev ${i}`));
  }
  for (let i = 0; i < worktreeCount - 1; i++) {
    createTask(project.storeDir, {
      id: `T-${i}`, projectId: project.id, title: `Task ${i}`, scope: ['src/**'],
      assignee: `dev${i}`, status: 'in_progress', worktreeId: worktreeIds[i + 1]!,
      branch: null, createdAt: new Date().toISOString(),
    });
  }
  writeFileSync(join(root, 'roles', 'dev0.md'), 'You are Dev 0.\n');

  const caller: Identity = {
    projectId: project.id,
    worktreeId: worktreeIds[0]!,
    markerDir: pathsByIndex[0]!,
    storeDir: project.storeDir,
    personaId: senior,
    role: 'senior-dev',
  };

  const notices: string[] = [];
  const notifier: Notifier = (message) => { notices.push(message); };
  const adapter = fakeAdapter();
  const timers = fakeTimers();
  const supervisor = new SessionSupervisor({
    registry, paths, adapter, rolesDir: join(root, 'roles'),
    notifier, timers, spawnCap: 3,
  });
  return {
    root, paths, registry, project, worktreeIds, devs, caller, notices, adapter, timers,
    supervisor,
  };
}

function cleanup(s: ReturnType<typeof setup>): void {
  s.registry.close();
  rmSync(s.root, { recursive: true, force: true });
}

test('a senior dev spawns a developer in a worktree with the full first prompt', async () => {
  const s = setup();
  try {
    const result = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.session.status, 'running');
    assert.equal(result.session.personaId, s.devs[0]);
    assert.equal(result.session.worktreeId, s.worktreeIds[1]);
    assert.equal(result.vendorSessionId, 'vendor-1');
    assert.equal(s.registry.sessions.list(s.project.id).length, 1);
    assert.equal(s.registry.bindings.forWorktree(s.worktreeIds[1]!)?.id, s.devs[0]);
    assert.equal(s.registry.personas.get(s.devs[0]!)?.lastVendorSessionId, 'vendor-1');
    assert.equal(readTasks(s.project.storeDir).find((t) => t.id === 'T-0')?.worktreeId,
      s.worktreeIds[1], 'the resolved worktree is persisted on the task');

    const prompt = s.adapter.prompts[0]!.text;
    assert.match(prompt, /You are Dev 0\./);
    assert.match(prompt, /Task T-0: Task 0/);
    assert.match(prompt, /- src\/\*\*/);
    assert.match(prompt, /[Cc]all `check_in` first/);
    assert.equal(s.supervisor.liveCount(s.project.id), 1);
  } finally {
    cleanup(s);
  }
});

test('tool 12 request_session reaches the supervisor through the caller identity', async () => {
  const s = setup();
  try {
    s.registry.bindings.bind(s.caller.personaId!, s.caller.worktreeId);
    const ctx = {
      registry: s.registry, paths: s.paths, identity: s.caller, supervisor: s.supervisor,
    } as unknown as RpcContext;
    const response = await dispatchTool({
      id: '1', method: 'request_session',
      params: { persona_id: s.devs[0]!, task_id: 'T-0' },
    }, ctx);
    assert.equal(response.ok, true, JSON.stringify(response));
    if (response.ok) {
      assert.match((response.result as { text: string }).text, /Started dev0/);
    }
    assert.equal(s.adapter.sessions.length, 1);
  } finally {
    cleanup(s);
  }
});

test('the cap holds at three: the fourth spawn needs user approval and then resumes', async () => {
  const s = setup(5);
  try {
    for (let i = 0; i < 3; i++) {
      const spawned = await s.supervisor.requestSession(s.caller, {
        persona_id: s.devs[i]!, task_id: `T-${i}`,
      });
      assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.message);
    }
    assert.equal(s.supervisor.liveCount(s.project.id), 3);

    const blocked = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[3]!, task_id: 'T-3',
    });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.code, 'CAP_REACHED');
    assert.match(blocked.message, /token consumption/);
    assert.ok(blocked.approvalId);
    assert.equal(s.adapter.sessions.length, 3);
    assert.equal(s.notices.length, 1);
    assert.match(s.notices[0]!, /artinarey approve/);

    const approved = await s.supervisor.approve(blocked.approvalId!, 'approved');
    assert.equal(approved.approval.status, 'approved');
    assert.equal(approved.spawn?.ok, true);
    assert.equal(s.supervisor.liveCount(s.project.id), 4);
    assert.equal(s.adapter.sessions.length, 4);
    assert.equal(s.timers.cleared.length, 2, 'approving cancels the 5 and 15 minute reminders');
  } finally {
    cleanup(s);
  }
});

test('rejecting an over-cap spawn leaves the cap intact', async () => {
  const s = setup(5);
  try {
    for (let i = 0; i < 3; i++) {
      await s.supervisor.requestSession(s.caller, { persona_id: s.devs[i]!, task_id: `T-${i}` });
    }
    const blocked = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[3]!, task_id: 'T-3',
    });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    const rejected = await s.supervisor.approve(blocked.approvalId!, 'rejected');
    assert.equal(rejected.approval.status, 'rejected');
    assert.equal(rejected.spawn, undefined);
    assert.equal(s.supervisor.liveCount(s.project.id), 3);
    assert.equal(s.adapter.sessions.length, 3);
  } finally {
    cleanup(s);
  }
});

test('only the senior dev may spawn', async () => {
  const s = setup();
  try {
    const developer: Identity = { ...s.caller, personaId: s.devs[0]!, role: 'dev0' };
    const result = await s.supervisor.requestSession(developer, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, 'FORBIDDEN_ROLE');
    assert.equal(s.adapter.sessions.length, 0);
  } finally {
    cleanup(s);
  }
});

test('spawning into a worktree with an active persona needs user approval', async () => {
  const s = setup(5);
  try {
    const first = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(first.ok, true);
    // A fresh request for dev1 into wt1 occupies dev0's directory.
    const blocked = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[1]!, task_id: 'T-0', worktree_id: s.worktreeIds[1],
    });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.code, 'NEEDS_CONFIRMATION');
    assert.ok(blocked.approvalId);
    const resolved = await s.supervisor.approve(blocked.approvalId!, 'rejected');
    assert.equal(resolved.approval.status, 'rejected');
    assert.equal(resolved.spawn, undefined);
  } finally {
    cleanup(s);
  }
});

test('risky calls ask, auto-approve covers only worktree-confined calls, and out-of-worktree always asks', () => {
  const s = setup();
  try {
    const base = { projectId: s.project.id, worktreeId: s.worktreeIds[1]!, sessionId: 's1' };
    const network = s.supervisor.evaluatePermission({ ...base, command: 'curl https://example.com' });
    assert.equal(network.effect, 'ask');
    assert.ok(network.approvalId);

    const local = s.supervisor.evaluatePermission({ ...base, command: 'pnpm test' });
    assert.equal(local.effect, 'allow');

    s.supervisor.toggle(s.worktreeIds[1]!, true);
    assert.equal(s.supervisor.isAutoApprove(s.worktreeIds[1]!), true);
    assert.equal(s.supervisor.evaluatePermission({ ...base, command: 'curl https://x.test' }).effect, 'allow');
    const outside = s.supervisor.evaluatePermission({
      ...base, resources: ['/etc/passwd'],
    });
    assert.equal(outside.effect, 'ask');
    const wtPath = s.registry.worktrees.list(s.project.id)
      .find((wt) => wt.id === base.worktreeId)!.path;
    assert.equal(s.supervisor.evaluatePermission({
      ...base, resources: [`${wtPath}/../secret`],
    }).effect, 'ask', 'absolute traversal is normalized before containment');
    assert.equal(s.supervisor.evaluatePermission({
      ...base, resources: ['../secret'],
    }).effect, 'ask', 'relative traversal is normalized before containment');
    assert.equal(s.supervisor.evaluatePermission({
      ...base, command: `cat ${wtPath}/../secret`,
    }).effect, 'ask', 'command-token escapes are not auto-approved');
  } finally {
    cleanup(s);
  }
});

test('a duplicate risky call reuses the pending approval instead of spamming the user', () => {
  const s = setup();
  try {
    const base = { projectId: s.project.id, worktreeId: s.worktreeIds[1]!,
      sessionId: 's1', command: 'git push' };
    const first = s.supervisor.evaluatePermission(base);
    const second = s.supervisor.evaluatePermission(base);
    assert.equal(first.approvalId, second.approvalId);
    assert.equal(s.notices.length, 1, 'notified once at 0 minutes');
    assert.equal(s.timers.handles.length, 2, 'scheduled the 5 and 15 minute reminders');
  } finally {
    cleanup(s);
  }
});

test('a different risky call in one worktree gets its own approval and operator summary', () => {
  const s = setup();
  try {
    const base = {
      projectId: s.project.id, worktreeId: s.worktreeIds[1]!, sessionId: 's1',
      action: 'shell', resources: ['src/a.ts'], command: 'curl https://example.com',
    };
    const first = s.supervisor.evaluatePermission(base);
    const duplicate = s.supervisor.evaluatePermission({
      ...base, resources: ['src/a.ts', 'src/a.ts'],
    });
    assert.equal(duplicate.approvalId, first.approvalId, 'resource order and duplicates do not matter');

    const variants = [
      { ...base, action: 'external_directory' },
      { ...base, resources: ['src/b.ts'] },
      { ...base, command: 'wget https://example.com' },
      { ...base, sessionId: 's2' },
    ];
    const distinct = variants.map((input) => s.supervisor.evaluatePermission(input));
    for (const decision of distinct) {
      assert.equal(decision.effect, 'ask');
      assert.ok(decision.approvalId);
    }
    assert.equal(new Set([first, ...distinct].map((d) => d.approvalId)).size, 5);

    const approvals = s.supervisor.approvals(s.project.id)
      .filter((a) => a.kind === 'risky_call');
    assert.equal(approvals.length, 5);
    assert.equal(new Set(approvals.map((a) => a.summary)).size, 5);
    for (const approval of approvals) {
      assert.equal(approval.status, 'pending');
      assert.ok(approval.fingerprint);
      for (const detail of ['sessionId=', 'action=', 'resources=', 'command=']) {
        assert.ok(approval.summary.includes(detail), approval.summary);
      }
    }
    assert.deepEqual(approvals[0]!.payload, {
      action: 'shell', resources: ['src/a.ts'],
      command: 'curl https://example.com', sessionId: 's1',
    });
    assert.match(approvals[3]!.summary, /command=wget https:\/\/example\.com/);
    assert.match(approvals[4]!.summary, /sessionId=s2/);
    assert.equal(s.notices.length, 5, 'each distinct reviewed action notifies the operator once');
  } finally {
    cleanup(s);
  }
});

test('adoption fails dead sessions once and keeps live ones running', () => {
  const s = setup();
  try {
    const file = join(s.paths.cacheRoot, s.project.id, 'sessions.jsonl');
    mkdirSync(join(s.paths.cacheRoot, s.project.id), { recursive: true });
    const liveId = newId();
    const deadId = newId();
    writeFileSync(file, [
      JSON.stringify({
        id: liveId, projectId: s.project.id, worktreeId: s.worktreeIds[1],
        personaId: s.devs[0], vendor: 'opencode', vendorSessionId: 'v-live',
        pid: process.pid, startedAt: 'now', endedAt: null, status: 'running', logFile: '/tmp/live',
      }),
      JSON.stringify({
        id: deadId, projectId: s.project.id, worktreeId: s.worktreeIds[2],
        personaId: s.devs[1], vendor: 'opencode', vendorSessionId: 'v-dead',
        pid: 99999999, startedAt: 'now', endedAt: null, status: 'running', logFile: '/tmp/dead',
      }),
    ].join('\n') + '\n');
    s.supervisor.adopt();
    const sessions = s.supervisor.sessions(s.project.id);
    assert.equal(sessions.find((x) => x.id === liveId)?.status, 'running');
    assert.equal(sessions.find((x) => x.id === deadId)?.status, 'failed');
    assert.ok(sessions.find((x) => x.id === deadId)?.endedAt);
  } finally {
    cleanup(s);
  }
});

test('an explicit worktree cannot leave the task lease; an unbound task may choose one', async () => {
  const s = setup(5);
  try {
    const away = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0', worktree_id: s.worktreeIds[2],
    });
    assert.equal(away.ok, false);
    if (!away.ok) assert.equal(away.code, 'INVALID_INPUT');
    assert.equal(s.adapter.sessions.length, 0);

    createTask(s.project.storeDir, {
      id: 'T-free', projectId: s.project.id, title: 'Unbound', scope: ['free/**'],
      assignee: 'dev0', status: 'in_progress', worktreeId: null, branch: null,
      createdAt: new Date().toISOString(),
    });
    const chosen = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-free', worktree_id: s.worktreeIds[0],
    });
    assert.equal(chosen.ok, true, chosen.ok ? '' : chosen.message);
    assert.equal(readTasks(s.project.storeDir).find((t) => t.id === 'T-free')?.worktreeId,
      s.worktreeIds[0]);
  } finally {
    cleanup(s);
  }
});

test('the default notifier installs an async error listener before unref', () => {
  const child = spawnNotifier('test');
  assert.equal(child.listenerCount('error'), 1);
  assert.doesNotThrow(() => child.emit('error', new Error('missing notify-send')));
});

test('a claim that throws while auditing rolls back binding and persona state', async () => {
  const s = setup();
  try {
    const auditFile = join(s.project.storeDir, 'events', 'audit.jsonl');
    rmSync(auditFile, { force: true });
    mkdirSync(auditFile, { recursive: true });
    const before = readPersona(s.project.storeDir, s.devs[0]!);
    const result = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(result.ok, false);
    assert.equal(s.registry.bindings.forWorktree(s.worktreeIds[1]!)?.id, undefined);
    assert.deepEqual(readPersona(s.project.storeDir, s.devs[0]!), before);
    assert.equal(s.supervisor.liveCount(s.project.id), 0);
  } finally {
    cleanup(s);
  }
});

test('a launch failure restores a pre-existing binding and releases the reservation', async () => {
  const s = setup(5);
  try {
    s.registry.bindings.bind(s.devs[0]!, s.worktreeIds[2]!);
    const before = readPersona(s.project.storeDir, s.devs[0]!);
    s.adapter.ensureServe = async () => { throw new Error('serve down'); };
    const failed = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(failed.ok, false);
    assert.equal(s.registry.bindings.forWorktree(s.worktreeIds[1]!)?.id, undefined);
    assert.equal(s.registry.bindings.forWorktree(s.worktreeIds[2]!)?.id, s.devs[0]);
    assert.deepEqual(readPersona(s.project.storeDir, s.devs[0]!), before);
    assert.equal(s.supervisor.liveCount(s.project.id), 0);

    s.adapter.ensureServe = async () => ({
      pid: process.pid, port: 41000, password: 'pw', startedAt: 'now',
    });
    const retried = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(retried.ok, true, retried.ok ? '' : retried.message);
  } finally {
    cleanup(s);
  }
});

test('concurrent requests count persona and cap reservations before the first await', async () => {
  const s = setup(5);
  try {
    const release = gateServe(s.adapter);
    const first = s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    const duplicate = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.code, 'DIRECTORY_BUSY');
    release();
    assert.equal((await first).ok, true);

    const s2 = setup(5);
    try {
      const release2 = gateServe(s2.adapter);
      const launches = [0, 1, 2].map((i) => s2.supervisor.requestSession(s2.caller, {
        persona_id: s2.devs[i]!, task_id: `T-${i}`,
      }));
      const blocked = await s2.supervisor.requestSession(s2.caller, {
        persona_id: s2.devs[3]!, task_id: 'T-3',
      });
      assert.equal(blocked.ok, false);
      if (!blocked.ok) assert.equal(blocked.code, 'CAP_REACHED');
      release2();
      for (const launch of launches) assert.equal((await launch).ok, true);
    } finally {
      cleanup(s2);
    }
  } finally {
    cleanup(s);
  }
});

test('concurrent launches are counted once after their registry rows exist', async () => {
  const s = setup(5);
  try {
    const release = gateCreateSession(s.adapter);
    const launches = [0, 1].map((i) => s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[i]!, task_id: `T-${i}`,
    }));
    await waitFor(() => s.registry.sessions.list(s.project.id).length === 2);
    assert.equal(s.supervisor.liveCount(s.project.id), 2, 'each launch counts once');

    const third = s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[2]!, task_id: 'T-2',
    });
    release();
    const thirdResult = await third;
    assert.equal(thirdResult.ok, true, thirdResult.ok ? '' : thirdResult.message);
    for (const launch of launches) assert.equal((await launch).ok, true);
    assert.equal(s.supervisor.liveCount(s.project.id), 3);
  } finally {
    cleanup(s);
  }
});

test('an approved cap spawn reserves capacity before its first await', async () => {
  const s = setup(6);
  try {
    for (let i = 0; i < 3; i++) {
      const spawned = await s.supervisor.requestSession(s.caller, {
        persona_id: s.devs[i]!, task_id: `T-${i}`,
      });
      assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.message);
    }
    const blocked = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[3]!, task_id: 'T-3',
    });
    assert.equal(blocked.ok, false);
    if (blocked.ok) return;
    assert.equal(blocked.code, 'CAP_REACHED');

    const release = gateServe(s.adapter);
    const approved = s.supervisor.approve(blocked.approvalId!, 'approved');
    const extra = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[4]!, task_id: 'T-4',
    });
    assert.equal(extra.ok, false);
    if (!extra.ok) assert.equal(extra.code, 'CAP_REACHED');
    release();
    const result = await approved;
    assert.equal(result.spawn?.ok, true);
    assert.equal(s.supervisor.liveCount(s.project.id), 4);
  } finally {
    cleanup(s);
  }
});

test('a sendPrompt rejection interrupts the vendor session and ends both records failed', async () => {
  const s = setup();
  try {
    s.adapter.failPrompt = true;
    const result = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(result.ok, false);
    assert.deepEqual(s.adapter.interrupted, ['vendor-1']);
    const registrySession = s.registry.sessions.list(s.project.id)[0]!;
    assert.ok(registrySession.endedAt);
    assert.equal(s.supervisor.sessions(s.project.id)[0]?.status, 'failed');
    assert.equal(s.supervisor.liveCount(s.project.id), 0);
    assert.equal(s.registry.bindings.forWorktree(s.worktreeIds[1]!)?.id, undefined);
  } finally {
    cleanup(s);
  }
});

test('an unconfirmed vendor cleanup keeps the session visible and its persona held', async () => {
  const s = setup();
  try {
    s.adapter.failPrompt = true;
    s.adapter.failInterrupt = true;
    const result = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(result.ok, false);
    const registrySession = s.registry.sessions.list(s.project.id)[0]!;
    assert.equal(registrySession.endedAt, null);
    const running = s.supervisor.sessions(s.project.id);
    assert.equal(running[0]?.status, 'running');
    assert.equal(s.supervisor.liveCount(s.project.id), 1, 'the registry row alone counts the launch');

    s.adapter.failInterrupt = false;
    assert.equal(await s.supervisor.stopSession(running[0]!.id), true);
    assert.equal(s.supervisor.sessions(s.project.id)[0]?.status, 'stopped');
    assert.equal(s.supervisor.liveCount(s.project.id), 0);
  } finally {
    cleanup(s);
  }
});

test('stopSession never reports success when the vendor interrupt fails', async () => {
  const s = setup();
  try {
    const spawned = await s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    assert.equal(spawned.ok, true);
    if (!spawned.ok) return;
    s.adapter.failInterrupt = true;
    assert.equal(await s.supervisor.stopSession(spawned.session.id), false);
    assert.equal(s.supervisor.sessions(s.project.id)[0]?.status, 'running');
    s.adapter.failInterrupt = false;
    assert.equal(await s.supervisor.stopSession(spawned.session.id), true);
    assert.equal(s.supervisor.sessions(s.project.id)[0]?.status, 'stopped');
  } finally {
    cleanup(s);
  }
});

test('a stop during sendPrompt does not bind the vendor or report a running spawn', async () => {
  const s = setup();
  try {
    const release = gatePrompt(s.adapter);
    const launch = s.supervisor.requestSession(s.caller, {
      persona_id: s.devs[0]!, task_id: 'T-0',
    });
    await waitFor(() => s.registry.sessions.list(s.project.id).length === 1);
    const id = s.registry.sessions.list(s.project.id)[0]!.id;
    assert.equal(await s.supervisor.stopSession(id), true);
    release();

    const result = await launch;
    assert.equal(result.ok, true, result.ok ? '' : result.message);
    if (!result.ok) return;
    assert.equal(result.session.id, id);
    assert.equal(result.session.status, 'stopped');
    assert.equal(s.registry.personas.get(s.devs[0]!)?.lastVendorSessionId, null);
    assert.equal(s.supervisor.liveCount(s.project.id), 0);
  } finally {
    cleanup(s);
  }
});

test('reading summaries reconciles rows whose registry session has already ended', () => {
  const s = setup();
  try {
    const file = join(s.paths.cacheRoot, s.project.id, 'sessions.jsonl');
    mkdirSync(join(s.paths.cacheRoot, s.project.id), { recursive: true });
    const staleId = s.registry.sessions.append({
      projectId: s.project.id, worktreeId: s.worktreeIds[1]!, personaId: s.devs[0]!,
      vendor: 'opencode', startedAt: 'now', createdBinding: false,
    });
    const liveId = s.registry.sessions.append({
      projectId: s.project.id, worktreeId: s.worktreeIds[2]!, personaId: s.devs[1]!,
      vendor: 'opencode', startedAt: 'now', createdBinding: false,
    });
    s.registry.sessions.end(staleId, new Date().toISOString());
    writeFileSync(file, [staleId, liveId].map((id) => JSON.stringify({
      id, projectId: s.project.id, worktreeId: s.worktreeIds[1], personaId: s.devs[0],
      vendor: 'opencode', vendorSessionId: `v-${id}`, pid: process.pid,
      startedAt: 'now', endedAt: null, status: 'running', logFile: '/tmp/log',
    })).join('\n') + '\n');
    const sessions = s.supervisor.sessions(s.project.id);
    assert.equal(sessions.find((x) => x.id === staleId)?.status, 'failed');
    assert.ok(sessions.find((x) => x.id === staleId)?.endedAt);
    assert.equal(sessions.find((x) => x.id === liveId)?.status, 'running');
  } finally {
    cleanup(s);
  }
});
