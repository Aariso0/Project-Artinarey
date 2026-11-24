import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPersona, createTask, newId, openRegistry, resolveXdgPaths,
  writeMarker, type Identity,
} from '@artinarey/core';
import {
  SessionSupervisor, type Notifier, type SessionAdapter, type TimerApi,
} from './sessions.ts';
import { dispatchTool, type RpcContext } from './tools.ts';

type ServeState = { pid: number; port: number; password: string; startedAt: string };

type FakeAdapter = SessionAdapter & {
  prompts: Array<{ sessionId: string; text: string }>;
  sessions: string[];
};

function fakeAdapter(): FakeAdapter {
  const prompts: Array<{ sessionId: string; text: string }> = [];
  const sessions: string[] = [];
  const state: ServeState = {
    pid: process.pid, port: 41000, password: 'pw', startedAt: 'now',
  };
  return {
    prompts,
    sessions,
    async ensureServe() { return state; },
    async createSession() {
      const id = `vendor-${sessions.length + 1}`;
      sessions.push(id);
      return id;
    },
    async sendPrompt(_state, sessionId, text) { prompts.push({ sessionId, text }); },
    async interrupt() {},
  };
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
    const base = { projectId: s.project.id, worktreeId: s.worktreeIds[1]! };
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
  } finally {
    cleanup(s);
  }
});

test('a duplicate risky call reuses the pending approval instead of spamming the user', () => {
  const s = setup();
  try {
    const base = { projectId: s.project.id, worktreeId: s.worktreeIds[1]!, command: 'git push' };
    const first = s.supervisor.evaluatePermission(base);
    const second = s.supervisor.evaluatePermission(base);
    assert.equal(first.approvalId, second.approvalId);
    assert.equal(s.notices.length, 1, 'notified once at 0 minutes');
    assert.equal(s.timers.handles.length, 2, 'scheduled the 5 and 15 minute reminders');
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
