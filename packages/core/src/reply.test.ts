import test from 'node:test';
import assert from 'node:assert/strict';
import { fail, ok } from './reply.ts';

test('ok ends with unread and a single next action', () => {
  const reply = ok('You are dev-auth in worktree wt1.', 3, 'inbox');
  assert.equal(reply.isError, false);
  assert.match(reply.text, /You are dev-auth/);
  assert.ok(reply.text.endsWith('unread: 3\nnext: inbox'), reply.text);
});

test('DIRECTORY_BUSY says stop and tells the agent to name the next action', () => {
  const reply = fail('DIRECTORY_BUSY', 'another persona is bound here');
  assert.equal(reply.isError, true);
  assert.match(reply.text, /DIRECTORY_BUSY/);
  assert.match(reply.text, /[Ss]top/);
  assert.match(reply.text, /\nnext: /);
});

test('NEEDS_CONFIRMATION tells the agent to ask the user and repeat with confirm_move', () => {
  const reply = fail('NEEDS_CONFIRMATION', 'home worktree mismatch');
  assert.match(reply.text, /ask the user/i);
  assert.match(reply.text, /confirm_move=true/);
  assert.equal(reply.isError, true);
});

test('PROJECT_PAUSED carries retry_after', () => {
  const reply = fail('PROJECT_PAUSED', 'a move is in progress', '2026-11-23T18:00:00Z');
  assert.match(reply.text, /retry_after: 2026-11-23T18:00:00Z/);
  assert.match(reply.text, /do not retry/i);
});

test('every §18 error code has a distinct instruction', () => {
  const codes = [
    'NO_PROJECT', 'WORKTREE_UNMANAGED', 'DIRECTORY_BUSY', 'NEEDS_CONFIRMATION',
    'FORBIDDEN_ROLE', 'LEASE_OVERLAP', 'CAP_REACHED', 'PROJECT_PAUSED',
    'STORE_OFFLINE', 'MAIL_REJECTED', 'NOT_FOUND',
  ] as const;
  const instructions = codes.map((code) => {
    const reply = fail(code, 'example');
    assert.ok(reply.text.endsWith(`next: ${reply.text.split('\nnext: ')[1]}`));
    return reply.text.split('\n')[1];
  });
  assert.equal(new Set(instructions).size, codes.length);
});
