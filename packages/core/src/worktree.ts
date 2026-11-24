import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync,
  rmdirSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ArtinareyError } from './errors.ts';
import {
  assertPlainMarkerPath, auditWorktreeRemoval, MARKER_FILE, readMarker, writeMarker,
} from './identity.ts';
import { newId } from './ids.ts';
import type { Registry, Worktree } from './registry.ts';

/** Git lock reasons written by Artinarey carry this prefix; other locks are never ours. */
export const LOCK_REASON_PREFIX = 'artinarey:';

export type GitWorktree = {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  /** Git's reason text, present only for a `locked <reason>` porcelain line. */
  lockReason?: string;
  prunable: boolean;
  bare: boolean;
};

function emptyWorktree(): GitWorktree {
  return {
    path: '', head: '', branch: null,
    detached: false, locked: false, prunable: false, bare: false,
  };
}

/** Parses `git worktree list --porcelain`, newline- or NUL-delimited (-z). */
export function parseWorktreePorcelain(text: string): GitWorktree[] {
  const records = text.includes('\0') ? text.split('\0') : text.split('\n');
  const worktrees: GitWorktree[] = [];
  let current = emptyWorktree();
  let hasFields = false;
  const finish = () => {
    if (hasFields) worktrees.push(current);
    current = emptyWorktree();
    hasFields = false;
  };

  for (const line of records) {
    if (line.trim() === '') {
      finish();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    switch (key) {
      case 'worktree':
        current.path = value;
        break;
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'locked':
        current.locked = true;
        if (value !== '') current.lockReason = value;
        break;
      case 'prunable':
        current.prunable = true;
        break;
      case 'bare':
        current.bare = true;
        break;
    }
    hasFields = true;
  }
  finish();
  return worktrees;
}

export function listGitWorktrees(repoDir: string): GitWorktree[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return parseWorktreePorcelain(output);
}

export type ReconciledWorktree = {
  path: string;
  branch: string | null;
  head: string;
  state: 'managed' | 'unmanaged' | 'missing';
  worktreeId?: string;
  flag?: 'moved' | 'branch_changed';
};

/** Symlinks are resolved only for paths that exist; missing paths are normalized lexically. */
function canonicalPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

/** Git's view first, registered rows git cannot see last. */
export function reconcileWorktrees(
  registry: Registry,
  projectId: string,
  gitWorktrees: GitWorktree[],
): ReconciledWorktree[] {
  const registered: Array<{ worktree: Worktree; key: string }> =
    registry.worktrees.list(projectId).map((worktree) => ({
      worktree, key: canonicalPath(worktree.path),
    }));
  const used = new Set<string>();
  const matches = new Array<{ worktree: Worktree; key: string } | undefined>(gitWorktrees.length);

  gitWorktrees.forEach((git, i) => {
    const key = canonicalPath(git.path);
    const match = registered.find((r) => r.key === key && !used.has(r.worktree.id));
    if (match) {
      matches[i] = match;
      used.add(match.worktree.id);
    }
  });
  gitWorktrees.forEach((git, i) => {
    if (matches[i] || git.branch === null) return;
    const match = registered.find((r) => r.worktree.branch === git.branch && !used.has(r.worktree.id));
    if (match) {
      matches[i] = match;
      used.add(match.worktree.id);
    }
  });

  const rows: ReconciledWorktree[] = gitWorktrees.map((git, i) => {
    const match = matches[i];
    let flag: ReconciledWorktree['flag'];
    if (match && match.key !== canonicalPath(git.path)) flag = 'moved';
    else if (match && match.worktree.branch !== git.branch) flag = 'branch_changed';
    return {
      path: git.path,
      branch: git.branch,
      head: git.head,
      state: match ? 'managed' : 'unmanaged',
      ...(match ? { worktreeId: match.worktree.id } : {}),
      ...(flag ? { flag } : {}),
    };
  });
  for (const { worktree } of registered) {
    if (used.has(worktree.id)) continue;
    rows.push({
      path: worktree.path, branch: worktree.branch, head: '',
      state: 'missing', worktreeId: worktree.id,
    });
  }
  return rows;
}

const EXCLUDE_START = '# >>> artinarey >>>';
const EXCLUDE_END = '# <<< artinarey <<<';
const EXCLUDE_PATTERNS = ['.worktrees/', '.artinarey.json', '.env.artinarey'];

/** Root and common git dir (shared by every worktree) for a directory inside a repo. */
export function resolveRepo(cwd: string): { root: string; commonDir: string } {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  // Query from root: a relative common dir is relative to git's cwd.
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  return { root, commonDir: resolve(root, common) };
}

/** Replace the managed block in the shared exclude file, keeping all other lines. */
export function ensureExcludeBlock(commonDir: string): void {
  const file = join(commonDir, 'info', 'exclude');
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const kept: string[] = [];
  let managed = false;
  for (const line of previous.split(/\r?\n/)) {
    if (line.trim() === EXCLUDE_START) {
      managed = true;
    } else if (line.trim() === EXCLUDE_END) {
      managed = false;
    } else if (!managed) {
      kept.push(line);
    }
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();

  const lines = kept.length > 0 ? kept : [''];
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [
    ...lines,
    EXCLUDE_START,
    ...EXCLUDE_PATTERNS,
    EXCLUDE_END,
    '',
  ].join('\n'));
}

/**
 * Report whether the global excludes file covers `.worktrees/`, without touching any
 * user config. The probe runs in a throwaway repo so a local exclude block cannot
 * be mistaken for global coverage.
 */
export function globalIgnoreCoverage(repoDir: string): {
  globalFile: string | null;
  coversWorktrees: boolean;
} {
  let globalFile: string | null = null;
  try {
    const value = execFileSync('git', ['config', '--global', '--get', 'core.excludesFile'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (value !== '') globalFile = value;
  } catch {
    // core.excludesFile is unset: git itself falls back to the XDG ignore file.
    const xdg = process.env.XDG_CONFIG_HOME;
    const fallback = join(xdg && xdg !== '' ? xdg : join(homedir(), '.config'), 'git', 'ignore');
    if (existsSync(fallback)) globalFile = fallback;
  }
  if (globalFile === null) return { globalFile: null, coversWorktrees: false };

  const probe = mkdtempSync(join(tmpdir(), 'artinarey-ignore-probe-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: probe, stdio: 'ignore' });
    execFileSync('git', ['config', 'core.excludesFile', globalFile], {
      cwd: probe,
      stdio: 'ignore',
    });
    // A negated rule can still print a match: trust the exit status only.
    return {
      globalFile,
      coversWorktrees: gitSucceeds(probe, [
        'check-ignore', '--no-index', '--quiet', '.worktrees/probe',
      ]),
    };
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

export type WorktreePlan = {
  path: string;
  branch: string;
  base: string;
  portOffset: number;
  copy: string[];
  envFile: string;
};

const ENV_FILES = ['.env', '.env.local'];

/** Exit status only: git prints diagnostics to stderr for ref lookups. */
function gitSucceeds(cwd: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A base must resolve to a commit, not merely to a tree or tag object. */
function commitAt(cwd: string, ref: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function defaultBase(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** The marker is reserved: a checkout that already tracks it must be rejected up front. */
function assertMarkerUntracked(repoRoot: string, baseCommit: string | undefined): void {
  if (baseCommit && gitSucceeds(repoRoot, ['cat-file', '-e', `${baseCommit}:${MARKER_FILE}`])) {
    throw new ArtinareyError('INVALID_INPUT', `base already tracks the reserved ${MARKER_FILE}`);
  }
}

/**
 * Read-only preflight. Every rejection happens before a directory, branch, marker,
 * env file or registry row can exist.
 */
export function planWorktree(
  registry: Registry,
  projectId: string,
  repoRoot: string,
  name: string,
  base?: string,
): WorktreePlan {
  if (!name || name.includes('/')) {
    throw new ArtinareyError('INVALID_INPUT', 'name must be a single path segment');
  }
  const branch = `artinarey/${name}`;
  const path = join(repoRoot, '.worktrees', name);
  if (existsSync(path)) {
    throw new ArtinareyError('INVALID_INPUT', `target directory already exists: ${path}`);
  }
  if (gitSucceeds(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    throw new ArtinareyError('INVALID_INPUT', `branch already exists: ${branch}`);
  }
  const resolvedBase = base ?? defaultBase(repoRoot);
  const baseCommit = resolvedBase === '' ? undefined : commitAt(repoRoot, resolvedBase);
  if (!baseCommit) {
    throw new ArtinareyError('INVALID_INPUT', `base ref does not exist: ${resolvedBase}`);
  }
  assertMarkerUntracked(repoRoot, baseCommit);

  const existingCount = reconcileWorktrees(registry, projectId, listGitWorktrees(repoRoot)).length;
  return {
    path,
    branch,
    base: resolvedBase,
    portOffset: existingCount * 10,
    copy: ENV_FILES.filter((file) => existsSync(join(repoRoot, file))),
    envFile: join(path, '.env.artinarey'),
  };
}

/**
 * Best-effort cleanup: prefer git's own removal, never `--force` and never a
 * recursive delete. A dirty worktree is retained, not treated as disposable.
 */
function discardGitWorktree(repoRoot: string, path: string): boolean {
  try {
    execFileSync('git', ['worktree', 'remove', path], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' });
    } catch {
      // Nothing left to prune.
    }
    return false;
  }
}

/** Create exclusively: never follow a symlink or change an existing file's mode. */
function writeGeneratedFile(path: string, content: string | Buffer): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, typeof content === 'string' ? Buffer.from(content) : content);
  } finally {
    closeSync(fd);
  }
}

/** Reject a stale plan before mutating git metadata, the filesystem, or the registry. */
function assertPlanAvailable(registry: Registry, repoRoot: string, plan: WorktreePlan): void {
  if (existsSync(plan.path)) {
    throw new ArtinareyError('INVALID_INPUT', `target directory already exists: ${plan.path}`);
  }
  const taken = listGitWorktrees(repoRoot).some((wt) => samePath(wt.path, plan.path)) ||
    registry.projects.list().flatMap((project) => registry.worktrees.list(project.id))
      .some((row) => samePath(row.path, plan.path));
  if (taken) {
    throw new ArtinareyError('INVALID_INPUT', `worktree already registered: ${plan.path}`);
  }
}

/** Only the exact marker this invocation wrote authorizes destructive rollback. */
function ownsMarker(path: string, content: string): boolean {
  try {
    return existsSync(path) && readFileSync(path, 'utf8') === content;
  } catch {
    return false;
  }
}

/** Git registration is not ownership: a failed add may only remove an empty target. */
function rollbackFailedAdd(repoRoot: string, path: string): void {
  if (listGitWorktrees(repoRoot).some((wt) => samePath(wt.path, path))) return;
  if (existsSync(path)) {
    try {
      rmdirSync(path);
    } catch {
      // A populated target was created by someone else after preflight: leave it alone.
    }
  }
}

/** Remove only an unchanged, unused branch created by this invocation. */
function discardCreatedBranch(repoRoot: string, branch: string, baseCommit?: string): void {
  if (!baseCommit) return;
  const ref = `refs/heads/${branch}`;
  const current = commitAt(repoRoot, ref);
  if (current !== baseCommit) return;
  if (listGitWorktrees(repoRoot).some((wt) => wt.branch === branch)) return;
  try {
    execFileSync('git', ['update-ref', '-d', ref, current], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    // Best effort: a concurrent change must not turn rollback into a failure.
  }
}

/** Apply a previously planned and confirmed worktree creation. */
export function createWorktree(registry: Registry, storeDir: string, plan: WorktreePlan): Worktree {
  const project = registry.projects.list().find((p) => p.storeDir === storeDir);
  if (!project) {
    throw new ArtinareyError('NOT_FOUND', `unknown project store: ${storeDir}`);
  }
  const repoRoot = dirname(dirname(plan.path));
  assertPlanAvailable(registry, repoRoot, plan);
  const baseCommit = commitAt(repoRoot, plan.base);
  assertMarkerUntracked(repoRoot, baseCommit);
  ensureExcludeBlock(resolveRepo(repoRoot).commonDir);

  const id = newId();
  const markerPath = join(plan.path, MARKER_FILE);
  // The manifest is built from the exact bytes written, so later edits are dirt.
  const copies = plan.copy.map((file) => ({
    file, content: readFileSync(join(repoRoot, file)),
  }));
  const generatedEnv = copies.map(({ file, content }) => ({
    name: file, sha256: createHash('sha256').update(content).digest('hex'),
  }));
  const markerContent = JSON.stringify({
    schema: 1,
    project_id: project.id,
    worktree_id: id,
    ...(generatedEnv.length > 0 ? { generated_env: generatedEnv } : {}),
  });
  const branchCreated = !gitSucceeds(repoRoot, [
    'show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`,
  ]);
  try {
    execFileSync('git', ['worktree', 'add', plan.path, '-b', plan.branch, plan.base], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch (err) {
    rollbackFailedAdd(repoRoot, plan.path);
    if (branchCreated) discardCreatedBranch(repoRoot, plan.branch, baseCommit);
    throw err;
  }

  const createdFiles: string[] = [];
  let registered = false;
  try {
    // Claim ownership before any other artifact is written.
    writeGeneratedFile(markerPath, markerContent);
    createdFiles.push(markerPath);
    writeGeneratedFile(plan.envFile, `ARTINAREY_PORT_OFFSET=${plan.portOffset}\n`);
    createdFiles.push(plan.envFile);
    for (const { file, content } of copies) {
      writeGeneratedFile(join(plan.path, file), content);
      createdFiles.push(join(plan.path, file));
    }
    registry.worktrees.upsert({
      id,
      projectId: project.id,
      path: plan.path,
      branch: plan.branch,
      portOffset: plan.portOffset,
    });
    registered = true;
    const row = registry.worktrees.list(project.id).find((wt) => wt.id === id);
    if (!row) throw new ArtinareyError('NOT_FOUND', `worktree not registered: ${id}`);
    return row;
  } catch (err) {
    let removed = true;
    if (ownsMarker(markerPath, markerContent)) {
      // The marker stays: it is excluded from git status and lets the retained
      // worktree be re-adopted. Only our generated copies may be deleted.
      for (const file of createdFiles) {
        if (file !== markerPath) rmSync(file, { force: true });
      }
      removed = discardGitWorktree(repoRoot, plan.path);
    }
    if (registered) registry.worktrees.delete(id);
    if (branchCreated) discardCreatedBranch(repoRoot, plan.branch, baseCommit);
    if (!removed) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ArtinareyError('INVALID_INPUT', `${message}; retained worktree at ${plan.path}`);
    }
    throw err;
  }
}

/** Real paths, falling back to lexical ones for directories git can no longer see. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** Adopt an already-created git worktree that belongs to this project's repository. */
export function adoptWorktree(
  registry: Registry,
  storeDir: string,
  projectId: string,
  path: string,
): Worktree {
  const project = registry.projects.get(projectId);
  if (!project) throw new ArtinareyError('NOT_FOUND', `unknown project: ${projectId}`);
  const target = resolve(path);
  if (registry.worktrees.list(projectId).some((row) => samePath(row.path, target))) {
    throw new ArtinareyError('INVALID_INPUT', `worktree already registered: ${target}`);
  }
  if (!gitSucceeds(target, ['rev-parse', '--is-inside-work-tree'])) {
    throw new ArtinareyError('INVALID_INPUT', `not a git worktree: ${target}`);
  }

  let commonDir: string;
  let gitWorktree: GitWorktree | undefined;
  try {
    commonDir = resolveRepo(target).commonDir;
    gitWorktree = listGitWorktrees(target).find((row) => samePath(row.path, target));
  } catch {
    throw new ArtinareyError('INVALID_INPUT', `not a git worktree: ${target}`);
  }
  if (!samePath(commonDir, project.repoCommonDir) || !gitWorktree) {
    throw new ArtinareyError('INVALID_INPUT', `worktree belongs to another repository: ${target}`);
  }
  // Reject foreign markers before ensureExcludeBlock or any other cleanup can run.
  const markerExisted = assertPlainMarkerPath(target);

  ensureExcludeBlock(project.repoCommonDir);
  const id = newId();
  try {
    writeMarker(target, projectId, id);
    registry.worktrees.upsert({
      id, projectId, path: target, branch: gitWorktree.branch, portOffset: 0,
    });
  } catch (err) {
    if (!markerExisted) rmSync(join(target, MARKER_FILE), { force: true });
    throw err;
  }
  const row = registry.worktrees.list(projectId).find((wt) => wt.id === id);
  if (!row) throw new ArtinareyError('NOT_FOUND', `worktree not registered: ${id}`);
  return row;
}

/** Owned env files are keyed by name and the hash of the bytes Artinarey wrote. */
type OwnedEnv = Map<string, string>;

function envSha256(path: string): string | undefined {
  try {
    if (!lstatSync(path).isFile()) return undefined;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Git refuses to remove a locked or dirty worktree without --force. Check before
 * deleting anything so a refused removal leaves every file exactly where it was.
 * Only listed, unchanged env copies count as ours; everything else is dirt.
 */
function assertRemovableWorktree(path: string, owned: OwnedEnv): void {
  let locked = false;
  let status = '';
  try {
    locked = listGitWorktrees(path).some((wt) => samePath(wt.path, path) && wt.locked);
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new ArtinareyError('INVALID_INPUT', `worktree is not removable: ${path}`);
  }
  if (locked) throw new ArtinareyError('INVALID_INPUT', `worktree is locked: ${path}`);
  const dirt = status.split('\n').filter((line) => {
    if (line === '') return false;
    if (!line.startsWith('?? ')) return true;
    const name = line.slice(3);
    const expected = owned.get(name);
    return expected === undefined || envSha256(join(path, name)) !== expected;
  });
  if (dirt.length > 0) {
    throw new ArtinareyError('INVALID_INPUT',
      `worktree has uncommitted or untracked files: ${path}`);
  }
}

/** A committed removal can still be missing its audit line; callers can tell them apart. */
export type WorktreeRemovalResult = {
  removed: true;
  auditWritten: boolean;
  auditError?: string;
};

/**
 * Remove a managed worktree without ever forcing git or deleting a branch. Session
 * history goes with the worktree so the foreign-key-constrained row can be deleted.
 */
export function removeWorktree(registry: Registry, projectId: string, id: string): WorktreeRemovalResult {
  const worktree = registry.worktrees.list(projectId).find((row) => row.id === id);
  if (!worktree) throw new ArtinareyError('NOT_FOUND', `unknown worktree: ${id}`);
  if (registry.bindings.forWorktree(id)) {
    throw new ArtinareyError('INVALID_INPUT', `worktree is bound to a persona: ${id}`);
  }
  const owned: OwnedEnv = new Map();
  for (const entry of readMarker(worktree.path)?.generated_env ?? []) {
    // The marker is user-writable data, never a source of arbitrary paths.
    if (ENV_FILES.includes(entry.name)) owned.set(entry.name, entry.sha256);
  }
  assertRemovableWorktree(worktree.path, owned);

  const project = registry.projects.get(projectId);
  const sessionsRemoved = registry.sessions.list(projectId)
    .filter((session) => session.worktreeId === id).length;
  // Keep the exact bytes in case git still refuses at the last moment.
  const staged: Array<{ file: string; content: Buffer; mode: number }> = [];
  try {
    for (const [name, expected] of owned) {
      const file = join(worktree.path, name);
      // A concurrent replacement after preflight is not ours to stage or overwrite.
      if (envSha256(file) !== expected) continue;
      try {
        const mode = lstatSync(file).mode & 0o777;
        const content = readFileSync(file);
        rmSync(file, { force: true });
        staged.push({ file, content, mode });
      } catch {
        // Leave an unreadable or raced entry alone.
      }
    }
    execFileSync('git', ['worktree', 'remove', worktree.path], {
      cwd: worktree.path, stdio: 'ignore',
    });
  } catch (err) {
    for (const { file, content, mode } of staged) {
      try {
        lstatSync(file);
        continue; // any entry created after staging is foreign: never overwrite it
      } catch {
        // Missing: the staged bytes can be restored.
      }
      try {
        writeFileSync(file, content, { mode });
      } catch {
        // Best effort: preserve the original git failure.
      }
    }
    throw err;
  }
  registry.sessions.deleteForWorktree(id);
  registry.worktrees.delete(id);
  if (!project) {
    return { removed: true, auditWritten: false, auditError: 'no project store for audit' };
  }
  try {
    auditWorktreeRemoval(project.storeDir, id, sessionsRemoved);
    return { removed: true, auditWritten: true };
  } catch (err) {
    return {
      removed: true,
      auditWritten: false,
      auditError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Lock/unlock are best-effort: plain temp directories are not git worktrees. */
export function lockGitWorktree(markerDir: string, reason: string): boolean {
  try {
    execFileSync('git', ['worktree', 'lock', '--reason', `${LOCK_REASON_PREFIX}${reason}`, markerDir], {
      cwd: markerDir, stdio: 'ignore',
    });
    return true;
  } catch {
    // Git refuses to replace a lock. A repeat claim is fine only if we already own it.
    return ownedLockReason(markerDir) !== undefined;
  }
}

/** The reason of a lock Artinarey created, if this directory still holds one. */
function ownedLockReason(markerDir: string): string | undefined {
  try {
    const row = listGitWorktrees(markerDir).find((wt) => samePath(wt.path, markerDir));
    return row?.locked && row.lockReason?.startsWith(LOCK_REASON_PREFIX)
      ? row.lockReason
      : undefined;
  } catch {
    return undefined;
  }
}

export function unlockGitWorktree(markerDir: string): boolean {
  if (ownedLockReason(markerDir) === undefined) return false;
  try {
    execFileSync('git', ['worktree', 'unlock', markerDir], {
      cwd: markerDir, stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}
