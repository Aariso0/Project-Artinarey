import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import Database from 'better-sqlite3';
import { ArtinareyError, withProjectLock } from '@artinarey/core';

export type InstanceLock = {
  pid: number;
  release(): void;
};

type FileId = { dev: number; ino: number };

function fileId(stats: FileId): FileId {
  return { dev: stats.dev, ino: stats.ino };
}

function statIfExists(file: string): FileId | undefined {
  try {
    return fileId(statSync(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

function sameFile(a: FileId | undefined, b: FileId | undefined): boolean {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

function removeIfSame(file: string, id: FileId | undefined): void {
  try {
    if (!sameFile(statIfExists(file), id)) return;
    unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** SQLite's BEGIN IMMEDIATE is a cross-process reserved lock; a crash releases it. */
function withStaleGuard<T>(file: string, fn: () => T): T {
  const db = new Database(`${file}.guard.sqlite`, { timeout: 2000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* the transaction already ended */ }
      throw err;
    }
  } finally {
    db.close();
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // The process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(file: string): number | undefined {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const pid = Number(content.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Wait briefly for a racing creator to publish its pid; an unreadable file still throws. */
async function publishedPid(file: string): Promise<number | undefined> {
  const deadline = Date.now() + 50;
  for (;;) {
    const pid = readLock(file);
    if (pid !== undefined || Date.now() >= deadline) return pid;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Single-instance pidfile. A dead pid's lock is replaced automatically. */
export async function acquireLock(file: string): Promise<InstanceLock> {
  return withProjectLock(file, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(file, 'wx', 0o600);
        let owned: FileId | undefined;
        let committed = false;
        try {
          const created = fileId(fstatSync(fd));
          owned = created;
          writeSync(fd, String(process.pid));
          fsyncSync(fd);
          committed = true;
          let released = false;
          return {
            pid: process.pid,
            release() {
              if (released) return;
              released = true;
              try {
                if (readLock(file) !== process.pid) return;
                removeIfSame(file, created);
              } catch {
                // best-effort release; the next starter can reclaim a stale pid
              }
            },
          };
        } finally {
          closeSync(fd);
          // A failed write/fsync must not leave an incomplete lock file behind.
          if (!committed && owned) removeIfSame(file, owned);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const seen = statIfExists(file);
        const pid = await publishedPid(file);
        if (pid === undefined) {
          if (!existsSync(file)) continue;
          throw new ArtinareyError('ALREADY_RUNNING', 'daemon lock is being created; retry');
        }
        if (isAlive(pid)) {
          throw new ArtinareyError('ALREADY_RUNNING', `daemon already running with pid ${pid}`);
        }
        // Validation and removal must be one cross-process step: without the guard a
        // second starter can validate the dead pid, then unlink the winner's new file.
        const reclaimed = withStaleGuard(file, () => {
          // Only reclaim the same file we inspected; a replacement belongs to another starter.
          if (!sameFile(seen, statIfExists(file)) || readLock(file) !== pid) return false;
          try {
            unlinkSync(file);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          }
          return true;
        });
        if (!reclaimed) continue;
      }
    }
    throw new ArtinareyError('ALREADY_RUNNING', 'could not acquire the daemon lock');
  });
}
