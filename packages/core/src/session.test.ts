import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approvalFingerprint, appendSession, buildFirstPrompt, createApproval, endSession, fileMode,
  getAutoApprove, isProcessAlive, pendingApproval, readApprovals, readRoleCard, readServeState,
  readSessions, resolveApproval, riskyReasons, serveStateFile, setAutoApprove,
  writeServeState, type SessionSummary,
} from './session.ts';
import { newId } from './ids.ts';
import { openRegistry } from './registry.ts';

function temp(): string {
  const dir = join(tmpdir(), `artinarey-session-${newId()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('approvals are appended, resolved once, and every flip is audited', () => {
  const root = temp();
  try {
    const store = join(root, 'store');
    const first = createApproval(store, {
      id: 'a1', projectId: 'p', kind: 'spawn_cap', summary: 'cap reached',
    });
    assert.equal(first.status, 'pending');
    assert.equal(readApprovals(store).length, 1);

    const resolved = resolveApproval(store, 'a1', 'approved', 'user');
    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.resolvedBy, 'user');
    assert.equal(readApprovals(store)[0]!.status, 'approved');
    assert.throws(() => resolveApproval(store, 'a1', 'rejected', 'user'), /already approved/);
    assert.throws(() => resolveApproval(store, 'missing', 'approved', 'user'), /unknown approval/);

    const audit = readFileSync(join(store, 'events', 'audit.jsonl'), 'utf8');
    assert.match(audit, /"type":"approval_resolved"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a torn approval line is skipped, not parsed into a phantom approval', () => {
  const root = temp();
  try {
    const store = join(root, 'store');
    mkdirSync(join(store, 'events'), { recursive: true });
    writeFileSync(join(store, 'events', 'approvals.jsonl'),
      `${JSON.stringify({ id: 'a1', projectId: 'p', status: 'pending' })}\n{"id":"bro`);
    assert.equal(readApprovals(store).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approval fingerprints are canonical and fingerprint lookups ignore legacy records', () => {
  const root = temp();
  try {
    const store = join(root, 'store');
    const input = {
      projectId: 'p', worktreeId: 'wt', action: 'shell',
      resources: ['b.txt', 'a.txt', 'a.txt'], command: 'curl https://example.com',
      sessionId: 's1',
    };
    const fingerprint = approvalFingerprint(input);
    assert.equal(approvalFingerprint({ ...input, resources: ['a.txt', 'b.txt'] }), fingerprint);
    for (const changed of [
      { projectId: 'other' }, { worktreeId: 'other' }, { action: 'edit' },
      { resources: ['a.txt'] }, { command: 'wget https://example.com' }, { sessionId: 's2' },
    ]) {
      assert.notEqual(approvalFingerprint({ ...input, ...changed }), fingerprint);
    }

    createApproval(store, {
      id: 'legacy', projectId: 'p', kind: 'risky_call', worktreeId: 'wt', summary: 'old',
    });
    const match = { projectId: 'p', kind: 'risky_call' as const, worktreeId: 'wt' };
    assert.equal(pendingApproval(store, match)?.id, 'legacy');
    assert.equal(pendingApproval(store, { ...match, fingerprint }), undefined);

    const fresh = createApproval(store, {
      id: 'fresh', projectId: 'p', kind: 'risky_call', worktreeId: 'wt',
      summary: 'new', fingerprint,
    });
    assert.equal(fresh.fingerprint, fingerprint);
    assert.equal(pendingApproval(store, { ...match, fingerprint })?.id, 'fresh');
    assert.equal(pendingApproval(store, { ...match, fingerprint: 'other' }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auto-approve is off by default and is stored per worktree', () => {
  const root = temp();
  const registry = openRegistry(join(root, 'registry.sqlite'));
  try {
    assert.equal(getAutoApprove(registry, 'wt1'), false);
    setAutoApprove(registry, 'wt1', true);
    assert.equal(getAutoApprove(registry, 'wt1'), true);
    assert.equal(getAutoApprove(registry, 'wt2'), false);
    setAutoApprove(registry, 'wt1', false);
    assert.equal(getAutoApprove(registry, 'wt1'), false);
  } finally {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the serve state is a 0600 secret and survives a reread', () => {
  const root = temp();
  try {
    const file = serveStateFile(join(root, 'config'));
    assert.equal(readServeState(file), undefined);
    writeServeState(file, { pid: 42, port: 1234, password: 'secret', startedAt: 'now' });
    assert.deepEqual(readServeState(file), {
      pid: 42, port: 1234, password: 'secret', startedAt: 'now',
    });
    assert.equal(fileMode(file), 0o600);
    writeFileSync(file, '{bad');
    assert.equal(readServeState(file), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session summaries append and end without losing older runs', () => {
  const root = temp();
  try {
    const file = join(root, 'sessions.jsonl');
    const base: SessionSummary = {
      id: 's1', projectId: 'p', worktreeId: 'wt', personaId: 'persona',
      vendor: 'opencode', vendorSessionId: 'vendor-1', pid: process.pid,
      startedAt: 'now', endedAt: null, status: 'running', logFile: '/tmp/log',
    };
    appendSession(file, base);
    appendSession(file, { ...base, id: 's2', vendorSessionId: 'vendor-2' });
    endSession(file, 's1', 'failed', 'later');
    const sessions = readSessions(file);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0]!.status, 'failed');
    assert.equal(sessions[0]!.endedAt, 'later');
    assert.equal(sessions[1]!.status, 'running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('liveness accepts the current process and rejects dead or bogus pids', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(99999999), false);
});

test('risky detection names network, global git and outside paths but not local work', () => {
  const wt = join(tmpdir(), 'project', 'worktree');
  assert.deepEqual(riskyReasons('npm test', wt), []);
  assert.deepEqual(riskyReasons('python -m pytest tests/', wt), []);
  assert.match(riskyReasons('curl https://example.com', wt)[0]!, /network/);
  assert.match(riskyReasons('git config --global user.name x', wt)[0]!, /global git/);
  assert.match(riskyReasons('cat /etc/passwd', wt)[0]!, /outside worktree/);
  assert.deepEqual(riskyReasons(`cat ${join(wt, 'src', 'a.ts')}`, wt), []);
});

test('the first prompt carries the role card, handoff, task, lease and check_in rule', () => {
  const root = temp();
  try {
    mkdirSync(join(root, 'roles'), { recursive: true });
    writeFileSync(join(root, 'roles', 'developer.md'), 'You are a developer.\n');
    assert.equal(readRoleCard(join(root, 'roles'), 'developer'), 'You are a developer.');
    assert.equal(readRoleCard(join(root, 'roles'), 'missing'), '');
    const prompt = buildFirstPrompt({
      role: 'developer',
      roleCard: 'You are a developer.',
      handoff: 'Finish the tests.',
      task: { id: 'T-1', title: 'M5', scope: ['src/**', 'docs'], body: 'Build the adapter.' },
    });
    assert.match(prompt, /You are a developer\./);
    assert.match(prompt, /Finish the tests\./);
    assert.match(prompt, /Task T-1: M5/);
    assert.match(prompt, /- src\/\*\*/);
    assert.match(prompt, /[Cc]all `check_in` first/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
