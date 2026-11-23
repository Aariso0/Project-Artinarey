import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtinareyError } from '@artinarey/core';
import { acquireLock, readLock } from './lock.ts';

function lockPath(): string {
  return join(tmpdir(), `artinarey-lock-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`);
}

test('acquiring the same lock twice in one process fails with ALREADY_RUNNING', async (t) => {
  const file = lockPath();
  t.after(() => rmSync(file, { force: true }));
  const lock = await acquireLock(file);

  assert.equal(readLock(file), process.pid);
  await assert.rejects(
    () => acquireLock(file),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'ALREADY_RUNNING',
  );

  lock.release();
  assert.equal(existsSync(file), false);
});

test('a stale lockfile whose pid is dead is replaced automatically', async (t) => {
  const file = lockPath();
  t.after(() => rmSync(file, { force: true }));
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.ok(deadPid, 'spawn should return a pid');
  writeFileSync(file, String(deadPid));

  const lock = await acquireLock(file);
  assert.equal(readLock(file), process.pid);
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));

  lock.release();
});

test('an unreadable lockfile is never reclaimed', async (t) => {
  const file = lockPath();
  t.after(() => rmSync(file, { force: true, recursive: true }));
  mkdirSync(file); // reading a directory fails with EISDIR, not ENOENT
  assert.throws(() => readLock(file));
  await assert.rejects(
    () => acquireLock(file),
    (err: unknown) => err instanceof Error && (err as NodeJS.ErrnoException).code === 'EISDIR',
  );
  assert.equal(existsSync(file), true, 'the unreadable file must not be unlinked');
});

test('an empty PID file is not immediately reclaimed', async (t) => {
  const file = lockPath();
  t.after(() => rmSync(file, { force: true }));
  writeFileSync(file, '');
  await assert.rejects(
    () => acquireLock(file),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'ALREADY_RUNNING',
  );
  assert.equal(existsSync(file), true);
});

test('two concurrent starters on a stale lock leave exactly one owner', async (t) => {
  const file = lockPath();
  t.after(() => rmSync(file, { force: true }));
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.ok(deadPid, 'spawn should return a pid');
  writeFileSync(file, String(deadPid));

  const results = await Promise.allSettled([acquireLock(file), acquireLock(file)]);
  const winners = results.filter((result) => result.status === 'fulfilled');
  const losers = results.filter((result) => result.status === 'rejected');
  assert.equal(winners.length, 1, 'only one starter may own the lock');
  assert.equal(losers.length, 1);
  assert.equal(readLock(file), process.pid);
  if (winners[0]?.status === 'fulfilled') winners[0].value.release();
});
