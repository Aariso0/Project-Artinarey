import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('condition not met before deadline'));
      setTimeout(check, 10);
    };
    check();
  });
}

function waitForMessage(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`child did not report ${expected}`)), 3000);
    const onMessage = (message: unknown) => {
      if (message === expected) finish();
    };
    const onError = (err: Error) => finish(err);
    const finish = (err?: Error) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      if (err) reject(err);
      else resolve();
    };
    child.on('message', onMessage);
    child.on('error', onError);
  });
}

/** Two separate OS processes contend for the same stale pid file. */
test('two starter processes racing on one stale pid file elect exactly one owner', async (t) => {
  const file = lockPath();
  const guard = `${file}.guard.sqlite`;
  const markers = [0, 1].map((i) => `${file}.starter-${i}.json`);
  const children: ChildProcess[] = [];
  const guardDb = new Database(guard, { timeout: 2000 });
  t.after(() => {
    for (const child of children) child.kill();
    try { guardDb.exec('ROLLBACK'); } catch { /* already committed */ }
    try { guardDb.close(); } catch { /* already closed */ }
    for (const path of [file, guard, `${guard}-journal`, ...markers]) {
      rmSync(path, { force: true });
    }
  });

  const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.ok(deadPid, 'spawn should return a pid');
  writeFileSync(file, String(deadPid));

  // Hold the cross-process guard before either starter runs: with a real guard both
  // starters must stall at this point; without one both finish immediately.
  guardDb.exec('BEGIN IMMEDIATE');
  const starterScript = `
    import { writeFileSync } from 'node:fs';
    const { acquireLock } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, 'lock.ts')).href)});
    const [pidFile, marker] = process.argv.slice(1);
    const released = new Promise((resolve) => {
      process.on('message', (msg) => { if (msg === 'release') resolve(); });
    });
    process.send('ready');
    try {
      const lock = await acquireLock(pidFile);
      writeFileSync(marker, JSON.stringify({ acquired: true, pid: process.pid }));
      process.send('acquired');
      await released;
      lock.release();
    } catch (err) {
      writeFileSync(marker, JSON.stringify({
        acquired: false, code: err.code, message: err.message,
      }));
      process.send('failed');
    }
    process.disconnect?.();
  `;
  for (const marker of markers) {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', starterScript, file, marker,
    ], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`starter: ${chunk.toString()}`);
    });
  }
  await Promise.all(children.map((child) => waitForMessage(child, 'ready')));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(markers.map((marker) => existsSync(marker)), [false, false],
    'both starters must wait for the stale-lock guard');

  guardDb.exec('COMMIT');
  guardDb.close();
  await waitUntil(() => markers.every((marker) => existsSync(marker)));
  const outcomes = markers.map((marker) => JSON.parse(readFileSync(marker, 'utf8')) as {
    acquired: boolean; pid?: number; code?: string;
  });
  const winners = outcomes.filter((outcome) => outcome.acquired);
  assert.equal(winners.length, 1, `only one process may acquire the lock: ${JSON.stringify(outcomes)}`);
  assert.equal(outcomes.length - winners.length, 1);
  assert.ok(winners[0]?.pid, 'the winner must publish its pid');
  assert.equal(readLock(file), winners[0].pid);

  for (const [i, outcome] of outcomes.entries()) {
    if (!outcome.acquired || !children[i]?.connected) continue;
    await waitForMessage(children[i]!, 'acquired');
    children[i]!.send('release');
  }
  await Promise.all(children.map((child) => new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
  })));
});
