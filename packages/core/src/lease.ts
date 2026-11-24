import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { ArtinareyError } from './errors.ts';
import { appendJournal } from './store.ts';

export type TaskStatus = 'in_progress' | 'blocked' | 'ready_for_review' | 'done';

export type Task = {
  id: string;
  projectId: string;
  title: string;
  scope: string[];
  assignee: string;
  status: TaskStatus;
  worktreeId: string | null;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
};

type TaskChange = { status?: TaskStatus; scope?: string[]; note?: string; worktreeId?: string | null };

type TaskEvent =
  | { type: 'task_created'; task: Task }
  | ({ type: 'task_updated'; taskId: string; at: string } & TaskChange)
  | { type: 'shared_claim'; taskId: string; files: string[]; at: string }
  | { type: 'shared_release'; taskId: string; at: string };

/** Files that cannot appear in two leases at once (plan.md §8 hot shared files). */
export const DEFAULT_SHARED_FILES = [
  'package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock',
  'go.mod', 'go.sum', 'Cargo.lock', 'requirements.txt', 'pyproject.toml',
  '.github', 'migrations', 'prisma/migrations',
];

function taskFile(storeDir: string): string {
  return join(storeDir, 'events', 'tasks.jsonl');
}

function leaseFile(storeDir: string): string {
  return join(storeDir, 'events', 'leases.jsonl');
}

function readEvents(file: string): TaskEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as TaskEvent];
    } catch {
      // A torn last line is discarded; appendJournal repairs it on the next write.
      return [];
    }
  });
}

export function readTasks(storeDir: string): Task[] {
  const tasks = new Map<string, Task>();
  for (const event of readEvents(taskFile(storeDir))) {
    if (event.type === 'task_created') {
      tasks.set(event.task.id, { ...event.task, scope: [...event.task.scope] });
      continue;
    }
    if (event.type !== 'task_updated') continue;
    const task = tasks.get(event.taskId);
    if (!task) continue;
    tasks.set(event.taskId, {
      ...task,
      status: event.status ?? task.status,
      scope: event.scope ? [...event.scope] : task.scope,
      worktreeId: event.worktreeId !== undefined ? event.worktreeId : task.worktreeId,
      updatedAt: event.at,
    });
  }
  return [...tasks.values()];
}

export function activeTasks(storeDir: string): Task[] {
  return readTasks(storeDir).filter((task) => task.status !== 'done');
}

export function sharedOwners(storeDir: string): Map<string, string> {
  const owners = new Map<string, string>();
  for (const event of readEvents(leaseFile(storeDir))) {
    if (event.type === 'shared_claim') {
      for (const file of event.files) owners.set(file, event.taskId);
    } else if (event.type === 'shared_release') {
      for (const [file, taskId] of owners) {
        if (taskId === event.taskId) owners.delete(file);
      }
    }
  }
  return owners;
}

/** Scopes are repo-relative. Absolute paths, traversal and drive letters are refused. */
export function normalizePath(input: string): string {
  const value = input.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!value || value.startsWith('/') || value.includes(':')) {
    throw new ArtinareyError('INVALID_INPUT', `scope must be a repo-relative path: ${input}`);
  }
  const parts = value.split('/').filter((part) => part !== '.' && part !== '');
  if (parts.includes('..')) {
    throw new ArtinareyError('INVALID_INPUT', `scope must be a repo-relative path: ${input}`);
  }
  return parts.length > 0 ? parts.join('/') : '.';
}

/** Glob syntax we cannot decide cheaply is treated as overlap, never as a free pass. */
function undecidable(pattern: string): boolean {
  return pattern === '.' || pattern.startsWith('!') || /[{}()\[\]]/.test(pattern);
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** True when every segment of `a` is the start of `b` (a is b or an ancestor dir). */
function isPrefix(a: string, b: string): boolean {
  const left = segments(a);
  const right = segments(b);
  return left.length > 0 && left.length <= right.length
    && left.every((part, index) => right[index] === part);
}

/** Literal text before the first wildcard; empty when the pattern leads with one. */
function literalPrefix(pattern: string): string {
  const cut = pattern.search(/[*?]/);
  return cut === -1 ? pattern : pattern.slice(0, cut).replace(/\/$/, '');
}

function hasWildcard(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

/** Literal text before the first wildcard, including a trailing separator. */
function leadingLiteral(pattern: string): string {
  const cut = pattern.search(/[*?]/);
  return cut === -1 ? pattern : pattern.slice(0, cut);
}

/** Divergent literal prefixes prove two wildcard scopes cannot match the same path. */
function disjointLiterals(a: string, b: string): boolean {
  const left = leadingLiteral(a);
  const right = leadingLiteral(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    if (left[i] !== right[i]) return true;
  }
  return false;
}

function makeRe(pattern: string): RegExp | null {
  try {
    return picomatch.makeRe(pattern, { dot: true }) as RegExp | false || null;
  } catch {
    return null;
  }
}

export type Overlap = { overlap: boolean; reason?: string; path?: string };
const FREE: Overlap = { overlap: false };

function oneOverlap(a: string, b: string): Overlap {
  if (undecidable(a) || undecidable(b)) {
    const path = undecidable(a) ? a : b;
    return { overlap: true, reason: 'undecidable glob', path };
  }
  const aLit = literalPrefix(a);
  const bLit = literalPrefix(b);
  // A leading wildcard matches the whole tree; we do not try to prove it disjoint.
  if (!aLit || !bLit) {
    return { overlap: true, reason: 'undecidable glob', path: aLit ? b : a };
  }
  if (a === b) return { overlap: true, reason: 'same path', path: a };
  if (isPrefix(a, b)) return { overlap: true, reason: 'path prefix', path: b };
  if (isPrefix(b, a)) return { overlap: true, reason: 'path prefix', path: a };
  if (hasWildcard(a) && hasWildcard(b) && !disjointLiterals(a, b)) {
    return { overlap: true, reason: 'undecidable glob', path: a };
  }

  const aRe = makeRe(a);
  const bRe = makeRe(b);
  if (!aRe || !bRe) return { overlap: true, reason: 'unsupported glob', path: a };
  if (aRe.test(bLit) || bRe.test(aLit)) {
    return { overlap: true, reason: 'glob match', path: b };
  }
  return FREE;
}

/** Compare two scopes. Any pair we cannot prove disjoint is reported as overlap. */
export function scopeOverlap(
  a: string[], b: string[], sharedFiles: string[] = DEFAULT_SHARED_FILES,
): Overlap {
  const left = a.map(normalizePath);
  const right = b.map(normalizePath);
  for (const one of left) {
    for (const two of right) {
      const result = oneOverlap(one, two);
      if (result.overlap) return result;
    }
  }
  // Hot shared files may not be claimed by two tasks, directly or via a parent dir.
  const shared = sharedFiles.map(normalizePath);
  for (const path of [...left, ...right]) {
    for (const file of shared) {
      const result = oneOverlap(path, file);
      if (result.overlap) return { ...result, reason: 'shared file', path };
    }
  }
  return FREE;
}

export function createTask(storeDir: string, input: Omit<Task, 'updatedAt'>): Task {
  const task: Task = { ...input, scope: [...input.scope], updatedAt: input.createdAt };
  appendJournal(taskFile(storeDir), { type: 'task_created', task });
  return task;
}

export function updateTask(storeDir: string, taskId: string, change: TaskChange): void {
  appendJournal(taskFile(storeDir), {
    type: 'task_updated', taskId, ...change, at: new Date().toISOString(),
  });
}

/** Return the shared files this scope claims (exact matches only). */
export function sharedFilesInScope(scope: string[]): string[] {
  const shared = new Set(DEFAULT_SHARED_FILES.map(normalizePath));
  return scope.map(normalizePath).filter((path) => shared.has(path));
}

export function claimShared(storeDir: string, taskId: string, scope: string[]): string[] {
  const files = sharedFilesInScope(scope);
  if (files.length === 0) return [];
  appendJournal(leaseFile(storeDir), {
    type: 'shared_claim', taskId, files, at: new Date().toISOString(),
  });
  return files;
}

export function releaseShared(storeDir: string, taskId: string): void {
  appendJournal(leaseFile(storeDir), {
    type: 'shared_release', taskId, at: new Date().toISOString(),
  });
}

/** Refuse a scope that collides with another active lease or a held shared file. */
export function assertScopeAvailable(storeDir: string, scope: string[], excludeTaskId?: string): void {
  for (const other of activeTasks(storeDir)) {
    if (other.id === excludeTaskId) continue;
    const result = scopeOverlap(scope, other.scope);
    if (result.overlap) {
      throw new ArtinareyError('LEASE_OVERLAP',
        `scope overlaps task ${other.id} (${result.reason}: ${result.path ?? ''})`);
    }
  }
  for (const [path, owner] of sharedOwners(storeDir)) {
    if (owner === excludeTaskId) continue;
    for (const candidate of scope.map(normalizePath)) {
      if (oneOverlap(candidate, path).overlap) {
        throw new ArtinareyError('LEASE_OVERLAP', `${path} is serialised by task ${owner}`);
      }
    }
  }
}

/** A literal scope covers its descendants; wildcards must match by regex. */
function scopeCovers(pattern: string, file: string): boolean {
  const scope = normalizePath(pattern);
  const path = normalizePath(file);
  if (scope === '.') return true;
  if (undecidable(scope)) return false;
  if (!hasWildcard(scope)) return isPrefix(scope, path);
  const re = makeRe(scope);
  return re ? re.test(path) : false;
}

/** Changed files (repo-relative) that no lease for that branch covers. */
export function uncoveredFiles(tasks: Task[], files: string[]): string[] {
  return files.filter((file) => !tasks.some((task) =>
    task.scope.some((pattern) => scopeCovers(pattern, file))));
}
