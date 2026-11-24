import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

export type RecoveryReport = {
  removedTemps: string[];
  trimmedLines: number;
};

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

type WriteFn = (fd: number, buffer: Buffer, offset: number, length: number) => number;

/** writeSync may commit fewer bytes than requested; loop until the buffer is gone. */
export function writeAllSync(
  fd: number,
  content: string | Buffer,
  write: WriteFn = writeSync,
): void {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  let offset = 0;
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset);
    if (!Number.isInteger(written) || written <= 0) throw new Error('write made no progress');
    offset += written;
  }
}

/** Temp in the same directory → fsync → chmod → rename → fsync directory. */
export function atomicWrite(path: string, content: string, mode = 0o644): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.tmp-${randomUUID()}`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeAllSync(fd, Buffer.from(content, 'utf8'));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, mode);
    renameSync(tmp, path);
    fsyncDir(dir);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // the temp may already be gone
    }
    throw err;
  }
}

/** Append one newline-terminated JSON line with fsync. */
export function appendJournal(path: string, event: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a+');
  try {
    const size = fstatSync(fd).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) {
        const content = readFileSync(path, 'utf8');
        const newline = content.lastIndexOf('\n');
        ftruncateSync(fd, newline + 1);
      }
    }
    writeAllSync(fd, `${JSON.stringify(event)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

type FileEntry = { path: string; name: string; isFile: boolean };

function walk(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) {
      out.push(...walk(path));
    } else {
      out.push({ path, name: name.name, isFile: name.isFile() });
    }
  }
  return out;
}

/** Startup sweep: remove stray temp files and discard a torn last journal line. */
export function recoverProject(storeDir: string): RecoveryReport {
  const removedTemps: string[] = [];
  let trimmedLines = 0;

  for (const entry of walk(storeDir)) {
    if (!entry.isFile) continue;

    if (entry.name.includes('.tmp-')) {
      unlinkSync(entry.path);
      removedTemps.push(relative(storeDir, entry.path).split(sep).join('/'));
      continue;
    }
    if (!entry.name.endsWith('.jsonl')) continue;

    const content = readFileSync(entry.path, 'utf8');
    if (content.length === 0 || content.endsWith('\n')) continue;

    const lastNewline = content.lastIndexOf('\n');
    const kept = lastNewline === -1 ? '' : content.slice(0, lastNewline + 1);
    const mode = statSync(entry.path).mode & 0o777;
    atomicWrite(entry.path, kept, mode);
    trimmedLines++;
  }

  return { removedTemps, trimmedLines };
}

// One writer per store directory: serialises all mutations inside this process.
const projectLocks = new Map<string, Promise<unknown>>();

export async function withProjectLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = projectLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  projectLocks.set(key, current);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (projectLocks.get(key) === current) projectLocks.delete(key);
  }
}
