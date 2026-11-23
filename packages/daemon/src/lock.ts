import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { ArtinareyError } from '@artinarey/core';

export type InstanceLock = {
  pid: number;
  release(): void;
};

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
  if (!existsSync(file)) return undefined;
  try {
    const pid = Number(readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Single-instance pidfile. A dead pid's lock is replaced automatically. */
export function acquireLock(file: string): InstanceLock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, String(process.pid));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      let released = false;
      return {
        pid: process.pid,
        release() {
          if (released) return;
          released = true;
          if (readLock(file) === process.pid) {
            try {
              unlinkSync(file);
            } catch {
              // already gone
            }
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = readLock(file);
      if (pid !== undefined && isAlive(pid)) {
        throw new ArtinareyError('ALREADY_RUNNING', `daemon already running with pid ${pid}`);
      }
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    }
  }
  throw new ArtinareyError('ALREADY_RUNNING', 'could not acquire the daemon lock');
}
