import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as core from './index.ts';
import { listGitWorktrees, parseWorktreePorcelain } from './worktree.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('parses a normal worktree block', () => {
  const text = [
    'worktree /repos/project',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'branch refs/heads/main',
    '',
  ].join('\n');

  assert.deepEqual(parseWorktreePorcelain(text), [{
    path: '/repos/project',
    head: '0123456789abcdef0123456789abcdef01234567',
    branch: 'main',
    detached: false,
    locked: false,
    prunable: false,
    bare: false,
  }]);
});

test('parses a detached block as branchless', () => {
  const text = [
    'worktree /repos/detached',
    'HEAD abcdefabcdefabcdefabcdefabcdefabcdefab',
    'detached',
    '',
  ].join('\n');

  assert.deepEqual(parseWorktreePorcelain(text), [{
    path: '/repos/detached',
    head: 'abcdefabcdefabcdefabcdefabcdefabcdefab',
    branch: null,
    detached: true,
    locked: false,
    prunable: false,
    bare: false,
  }]);
});

test('locked and prunable reasons do not leak into the following block', () => {
  const text = [
    'worktree /repos/locked',
    'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'branch refs/heads/locked',
    'locked kept for review',
    '',
    'worktree /repos/prunable',
    'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'prunable gitdir file points to a non-existent location',
    '',
    'worktree /repos/after',
    'HEAD cccccccccccccccccccccccccccccccccccccccc',
    'branch refs/heads/after',
    '',
  ].join('\n');

  const result = parseWorktreePorcelain(text);
  assert.equal(result.length, 3);
  assert.equal(result[0]?.path, '/repos/locked');
  assert.equal(result[0]?.locked, true);
  assert.equal(result[0]?.prunable, false);
  assert.equal(result[1]?.path, '/repos/prunable');
  assert.equal(result[1]?.prunable, true);
  assert.equal(result[1]?.locked, false);
  assert.deepEqual(result[2], {
    path: '/repos/after',
    head: 'cccccccccccccccccccccccccccccccccccccccc',
    branch: 'after',
    detached: false,
    locked: false,
    prunable: false,
    bare: false,
  });
});

test('parses a bare block', () => {
  const text = [
    'worktree /repos/bare.git',
    'bare',
    '',
  ].join('\n');

  assert.deepEqual(parseWorktreePorcelain(text), [{
    path: '/repos/bare.git',
    head: '',
    branch: null,
    detached: false,
    locked: false,
    prunable: false,
    bare: true,
  }]);
});

test('empty porcelain output yields no worktrees', () => {
  assert.deepEqual(parseWorktreePorcelain(''), []);
});

test('lists this repository as a worktree', () => {
  const worktrees = listGitWorktrees(root);
  assert.ok(worktrees.length >= 1);
  assert.equal(worktrees.some((wt) => wt.path === root), true);
});

test('core index re-exports the worktree module', () => {
  assert.equal(core.parseWorktreePorcelain, parseWorktreePorcelain);
  assert.equal(core.listGitWorktrees, listGitWorktrees);
});
