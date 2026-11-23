import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtinareyError } from '@artinarey/core';
import { acquireLock, readLock } from './lock.ts';

function lockPath(): string {
  return join(tmpdir(), `artinarey-lock-${Date.now()}-${Math.random().toString(16).slice(2)}.pid`);
}

test('acquiring the same lock twice in one process fails with ALREADY_RUNNING', () => {
  const file = lockPath();
  const lock = acquireLock(file);

  assert.equal(readLock(file), process.pid);
  assert.throws(
    () => acquireLock(file),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'ALREADY_RUNNING',
  );

  lock.release();
  assert.equal(existsSync(file), false);
});

test('a stale lockfile whose pid is dead is replaced automatically', () => {
  const file = lockPath();
  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.ok(deadPid, 'spawn should return a pid');
  writeFileSync(file, String(deadPid));

  const lock = acquireLock(file);
  assert.equal(readLock(file), process.pid);
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));

  lock.release();
});
