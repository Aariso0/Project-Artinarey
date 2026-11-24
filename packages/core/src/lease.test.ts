import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { newId } from './ids.ts';
import {
  activeTasks, assertScopeAvailable, claimShared, createTask, normalizePath,
  readTasks, releaseShared, scopeOverlap, sharedFilesInScope, sharedOwners,
  uncoveredFiles, updateTask, type Task,
} from './lease.ts';

function tempStore(): string {
  const dir = join(tmpdir(), `artinarey-lease-${newId()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function task(store: string, id: string, scope: string[]): Task {
  return createTask(store, {
    id, projectId: 'p', title: id, scope, assignee: 'a', status: 'in_progress',
    worktreeId: null, branch: null, createdAt: new Date().toISOString(),
  });
}

test('normalizePath is repo-relative and deterministic', () => {
  assert.equal(normalizePath('./src//foo/'), 'src/foo');
  assert.equal(normalizePath('src\\foo'), 'src/foo');
  assert.equal(normalizePath('src/./a.ts'), 'src/a.ts');
  assert.equal(normalizePath('./src/././a.ts'), 'src/a.ts');
  assert.equal(normalizePath('.//src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath('.'), '.');
  for (const bad of ['/abs', '../up', 'src/../x', 'src/./../x', 'C:\\x']) {
    assert.throws(() => normalizePath(bad), (e: unknown) =>
      e instanceof ArtinareyError && e.code === 'INVALID_INPUT');
  }
});

test('overlap: identical paths and directory prefixes', () => {
  assert.equal(scopeOverlap(['src/a.ts'], ['src/a.ts']).overlap, true);
  assert.equal(scopeOverlap(['src'], ['src/a.ts']).overlap, true);
  assert.equal(scopeOverlap(['src/a.ts'], ['src']).overlap, true);
  assert.equal(scopeOverlap(['src/a.ts'], ['src/b.ts']).overlap, false);
});

test('overlap: plain globs are resolved, not guessed', () => {
  assert.equal(scopeOverlap(['src/*.ts'], ['src/a.ts']).overlap, true);
  assert.equal(scopeOverlap(['src/*.ts'], ['src/a.md']).overlap, false);
  assert.equal(scopeOverlap(['src/a*.ts'], ['src/b.ts']).overlap, false);
});

test('overlap: two wildcards are conservative unless disjointness is proven', () => {
  assert.equal(scopeOverlap(['src/a*.ts'], ['src/ab*.ts']).overlap, true);
  assert.equal(scopeOverlap(['src/*.ts'], ['src/*.md']).overlap, true);
  assert.equal(scopeOverlap(['src/a*.ts'], ['src/b*.ts']).overlap, false);
  assert.equal(scopeOverlap(['src/foo/*.ts'], ['docs/bar/*.ts']).overlap, false);
});

test('overlap: undecidable globs count as overlap', () => {
  for (const pattern of ['+(foo)', '{a,b}', '!foo', 'src/[ab].ts', 'foo(bar).ts']) {
    assert.equal(scopeOverlap([pattern], ['src/a.ts']).overlap, true, pattern);
  }
  assert.equal(scopeOverlap(['.'], ['src/a.ts']).overlap, true);
});

test('overlap: a leading wildcard cannot be proven disjoint', () => {
  assert.equal(scopeOverlap(['*.ts'], ['README.md']).overlap, true);
});

test('overlap: hot shared files may not be in two leases', () => {
  assert.equal(scopeOverlap(['package.json'], ['src/a.ts']).overlap, true);
  assert.equal(scopeOverlap(['.github/workflows'], ['src/a.ts']).overlap, true);
  assert.equal(scopeOverlap(['src/a.ts'], ['src/b.ts']).overlap, false);
});

test('task journal replays creates and updates', () => {
  const store = tempStore();
  task(store, 'T-1', ['src/a.ts']);
  task(store, 'T-2', ['src/b.ts']);
  updateTask(store, 'T-2', { status: 'done' });
  assert.deepEqual(readTasks(store).map((t) => t.id).sort(), ['T-1', 'T-2']);
  assert.deepEqual(activeTasks(store).map((t) => t.id), ['T-1']);
  assert.deepEqual(readTasks(store).find((t) => t.id === 'T-2')?.status, 'done');
});

test('updateTask applies worktreeId without dropping other fields', () => {
  const store = tempStore();
  const created = task(store, 'T-1', ['src/a.ts']);
  updateTask(store, 'T-1', { status: 'blocked', worktreeId: 'W-1', note: 'moved' });
  const updated = readTasks(store).find((t) => t.id === 'T-1');
  assert.equal(updated?.worktreeId, 'W-1');
  assert.equal(updated?.status, 'blocked');
  assert.deepEqual(updated?.scope, ['src/a.ts']);
  assert.equal(updated?.title, created.title);
  assert.equal(updated?.assignee, created.assignee);
  assert.equal(updated?.branch, created.branch);

  updateTask(store, 'T-1', { worktreeId: null });
  const cleared = readTasks(store).find((t) => t.id === 'T-1');
  assert.equal(cleared?.worktreeId, null);
  assert.equal(cleared?.status, 'blocked');
});

test('assertScopeAvailable rejects a colliding lease', () => {
  const store = tempStore();
  task(store, 'T-1', ['src/a.ts']);
  assert.doesNotThrow(() => assertScopeAvailable(store, ['src/b.ts']));
  assert.throws(() => assertScopeAvailable(store, ['src']), (e: unknown) =>
    e instanceof ArtinareyError && e.code === 'LEASE_OVERLAP');
  assert.doesNotThrow(() => assertScopeAvailable(store, ['src/a.ts'], 'T-1'));
});

test('shared files are serialised with release', () => {
  const store = tempStore();
  assert.deepEqual(sharedFilesInScope(['package.json', 'src/a.ts']), ['package.json']);
  assert.deepEqual(claimShared(store, 'T-1', ['package.json']), ['package.json']);
  assert.equal(sharedOwners(store).get('package.json'), 'T-1');
  assert.throws(() => assertScopeAvailable(store, ['package.json']), (e: unknown) =>
    e instanceof ArtinareyError && e.code === 'LEASE_OVERLAP');
  releaseShared(store, 'T-1');
  assert.equal(sharedOwners(store).has('package.json'), false);
  assert.doesNotThrow(() => assertScopeAvailable(store, ['package.json']));
});

test('uncoveredFiles flags edits outside every lease', () => {
  const store = tempStore();
  const tasks = [task(store, 'T-1', ['src/*.ts'])];
  assert.deepEqual(uncoveredFiles(tasks, ['src/a.ts', 'docs/x.md']), ['docs/x.md']);
});

test('uncoveredFiles covers literal directory scopes and wildcards', () => {
  const store = tempStore();
  const tasks = [task(store, 'T-1', ['src/*.ts']), task(store, 'T-2', ['docs'])];
  assert.deepEqual(
    uncoveredFiles(tasks, ['src/a.ts', 'docs/x.md', 'docs/deep/y.md', 'other/z.ts', 'srcx/w.ts']),
    ['other/z.ts', 'srcx/w.ts'],
  );
});
