import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSupervisorRequest, isSupervisorMethod } from './server.ts';
import type { RpcContext } from './tools.ts';

function context(overrides: Record<string, unknown> = {}): RpcContext {
  return { supervisor: overrides } as unknown as RpcContext;
}

test('supervisor routing recognises only its own methods', () => {
  for (const method of [
    'approvals', 'approval_status', 'approve', 'auto_approve',
    'sessions', 'stop_session', 'evaluate_permission',
  ]) {
    assert.equal(isSupervisorMethod(method), true, method);
  }
  assert.equal(isSupervisorMethod('check_in'), false);
  assert.equal(isSupervisorMethod('ping'), false);
});

test('a missing supervisor is a typed error, not an empty result', async () => {
  const response = await handleSupervisorRequest({ id: '1', method: 'approvals' }, undefined);
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'NO_PROJECT');
});

test('approvals and approval_status return approval data', async () => {
  const approval = { id: 'a1', projectId: 'p', kind: 'spawn_cap', status: 'pending' };
  const fake = {
    approvals: (projectId?: string) => projectId ? [approval] : [approval, approval],
  };
  const ctx = context(fake);
  const all = await handleSupervisorRequest({ id: '1', method: 'approvals' }, ctx);
  assert.equal(all.ok, true);
  if (all.ok) assert.equal((all.result as { approvals: unknown[] }).approvals.length, 2);

  const filtered = await handleSupervisorRequest({
    id: '2', method: 'approvals', params: { projectId: 'p' },
  }, ctx);
  assert.equal(filtered.ok, true);

  const status = await handleSupervisorRequest({
    id: '3', method: 'approval_status', params: { id: 'a1' },
  }, ctx);
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.equal((status.result as { status: string }).status, 'pending');
  }
  const missing = await handleSupervisorRequest({
    id: '4', method: 'approval_status', params: { id: 'nope' },
  }, ctx);
  assert.equal(missing.ok, true);
  if (missing.ok) assert.equal((missing.result as { status: string }).status, 'unknown');
});

test('approve passes the decision and resolved-by through to the supervisor', async () => {
  const seen: unknown[] = [];
  const ctx = context({
    approve: async (id: string, decision: string, by: string) => {
      seen.push([id, decision, by]);
      return { approval: { id, status: decision } };
    },
  });
  const response = await handleSupervisorRequest({
    id: '1', method: 'approve', params: { id: 'a1', decision: 'rejected', by: 'user' },
  }, ctx);
  assert.equal(response.ok, true);
  assert.deepEqual(seen, [['a1', 'rejected', 'user']]);
  const missingActor = await handleSupervisorRequest({
    id: '2', method: 'approve', params: { id: 'a2' },
  }, ctx);
  assert.equal(missingActor.ok, false);
  if (!missingActor.ok) assert.equal(missingActor.error.code, 'INVALID_INPUT');
  assert.equal(seen.length, 1);
});

test('auto_approve requires a worktree and a boolean', async () => {
  const toggles: unknown[] = [];
  const ctx = context({ toggle: (id: string, enabled: boolean) => toggles.push([id, enabled]) });
  const bad = await handleSupervisorRequest({
    id: '1', method: 'auto_approve', params: { worktreeId: 'wt', enabled: 'yes' },
  }, ctx);
  assert.equal(bad.ok, false);
  const good = await handleSupervisorRequest({
    id: '2', method: 'auto_approve', params: { worktreeId: 'wt', enabled: true },
  }, ctx);
  assert.equal(good.ok, true);
  assert.deepEqual(toggles, [['wt', true]]);
});

test('sessions and stop_session require ids', async () => {
  let interruptResolved = false;
  const ctx = context({
    sessions: () => [{ id: 's1', status: 'running' }],
    stopSession: async (id: string) => {
      await Promise.resolve();
      interruptResolved = true;
      return id === 's1';
    },
  });
  const missingProject = await handleSupervisorRequest({
    id: '1', method: 'sessions',
  }, ctx);
  assert.equal(missingProject.ok, false);
  const listed = await handleSupervisorRequest({
    id: '2', method: 'sessions', params: { projectId: 'p' },
  }, ctx);
  assert.equal(listed.ok, true);
  if (listed.ok) assert.equal((listed.result as { sessions: unknown[] }).sessions.length, 1);

  const missingId = await handleSupervisorRequest({
    id: '3', method: 'stop_session',
  }, ctx);
  assert.equal(missingId.ok, false);
  const stopped = await handleSupervisorRequest({
    id: '4', method: 'stop_session', params: { id: 's1' },
  }, ctx);
  assert.equal(stopped.ok, true);
  assert.equal(interruptResolved, true, 'stop_session awaits the interrupt before replying');
  if (stopped.ok) assert.equal((stopped.result as { stopped: boolean }).stopped, true);
});

test('evaluate_permission requires project, worktree and session and forwards resources', async () => {
  let forwarded: unknown;
  const ctx = context({
    evaluatePermission: (input: unknown) => {
      forwarded = input;
      return { effect: 'ask', approvalId: 'a1' };
    },
  });
  const bad = await handleSupervisorRequest({
    id: '1', method: 'evaluate_permission', params: { projectId: 'p' },
  }, ctx);
  assert.equal(bad.ok, false);
  for (const params of [
    { projectId: 'p', worktreeId: 'wt' },
    { projectId: 'p', worktreeId: 'wt', sessionId: '' },
    { projectId: 'p', worktreeId: 'wt', sessionId: 42 },
  ]) {
    const missingSession = await handleSupervisorRequest({
      id: 'bad-session', method: 'evaluate_permission', params,
    }, ctx);
    assert.equal(missingSession.ok, false);
    if (!missingSession.ok) {
      assert.equal(missingSession.error.code, 'INVALID_INPUT');
      assert.match(missingSession.error.message, /sessionId/);
    }
  }
  assert.equal(forwarded, undefined, 'a rejected request never reaches the supervisor');
  const response = await handleSupervisorRequest({
    id: '2', method: 'evaluate_permission', params: {
      projectId: 'p', worktreeId: 'wt', sessionId: 's1', action: 'shell',
      resources: ['curl https://x.test', 42], command: 'curl https://x.test',
    },
  }, ctx);
  assert.equal(response.ok, true);
  assert.deepEqual(forwarded, {
    projectId: 'p', worktreeId: 'wt', sessionId: 's1', action: 'shell',
    resources: ['curl https://x.test'], command: 'curl https://x.test',
  });
});

test('an unknown supervisor method is NOT_FOUND with a typed error', async () => {
  const response = await handleSupervisorRequest(
    { id: '1', method: 'nope' },
    context(),
  );
  assert.equal(response.ok, false);
  if (!response.ok) assert.equal(response.error.code, 'NOT_FOUND');
});
