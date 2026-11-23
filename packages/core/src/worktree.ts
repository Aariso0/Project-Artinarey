import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { writeMarker } from './identity.ts';
import { newId } from './ids.ts';
import type { Registry, Worktree } from './registry.ts';

export type GitWorktree = {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  bare: boolean;
};

/** Parses the block-oriented output of `git worktree list --porcelain`. */
export function parseWorktreePorcelain(text: string): GitWorktree[] {
  return text
    .split(/\n\s*\n/)
    .filter((block) => block.trim() !== '')
    .map((block) => {
      const worktree: GitWorktree = {
        path: '',
        head: '',
        branch: null,
        detached: false,
        locked: false,
        prunable: false,
        bare: false,
      };

      for (const line of block.split('\n')) {
        const space = line.indexOf(' ');
        const key = space === -1 ? line : line.slice(0, space);
        const value = space === -1 ? '' : line.slice(space + 1);
        switch (key) {
          case 'worktree':
            worktree.path = value;
            break;
          case 'HEAD':
            worktree.head = value;
            break;
          case 'branch':
            worktree.branch = value.replace(/^refs\/heads\//, '');
            break;
          case 'detached':
            worktree.detached = true;
            break;
          case 'locked':
            worktree.locked = true;
            break;
          case 'prunable':
            worktree.prunable = true;
            break;
          case 'bare':
            worktree.bare = true;
            break;
        }
      }
      return worktree;
    });
}

export function listGitWorktrees(repoDir: string): GitWorktree[] {
  const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
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
    return { globalFile: null, coversWorktrees: false };
  }
  if (globalFile === null) return { globalFile: null, coversWorktrees: false };

  const probe = mkdtempSync(join(tmpdir(), 'artinarey-ignore-probe-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: probe, stdio: 'ignore' });
    execFileSync('git', ['config', 'core.excludesFile', globalFile], {
      cwd: probe,
      stdio: 'ignore',
    });
    try {
      const match = execFileSync(
        'git', ['check-ignore', '--no-index', '-v', '.worktrees/probe'],
        { cwd: probe, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return { globalFile, coversWorktrees: match.trim() !== '' };
    } catch {
      return { globalFile, coversWorktrees: false };
    }
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
  if (resolvedBase === '' ||
      !gitSucceeds(repoRoot, ['rev-parse', '--verify', resolvedBase])) {
    throw new ArtinareyError('INVALID_INPUT', `base ref does not exist: ${resolvedBase}`);
  }

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

/** Best-effort cleanup: prefer git's own removal, never `--force`. */
function discardGitWorktree(repoRoot: string, path: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', path], { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' });
    } catch {
      // Nothing left to prune.
    }
    if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  }
}

/** Apply a previously planned and confirmed worktree creation. */
export function createWorktree(registry: Registry, storeDir: string, plan: WorktreePlan): Worktree {
  const project = registry.projects.list().find((p) => p.storeDir === storeDir);
  if (!project) {
    throw new ArtinareyError('NOT_FOUND', `unknown project store: ${storeDir}`);
  }
  const repoRoot = dirname(dirname(plan.path));
  ensureExcludeBlock(resolveRepo(repoRoot).commonDir);

  const id = newId();
  try {
    execFileSync('git', ['worktree', 'add', plan.path, '-b', plan.branch, plan.base], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
  } catch (err) {
    discardGitWorktree(repoRoot, plan.path);
    throw err;
  }

  const createdFiles: string[] = [];
  let registered = false;
  try {
    const marker = join(plan.path, '.artinarey.json');
    writeMarker(plan.path, project.id, id);
    createdFiles.push(marker);
    writeFileSync(plan.envFile, `ARTINAREY_PORT_OFFSET=${plan.portOffset}\n`, { mode: 0o600 });
    createdFiles.push(plan.envFile);
    for (const file of plan.copy) {
      const target = join(plan.path, file);
      writeFileSync(target, readFileSync(join(repoRoot, file)), { mode: 0o600 });
      createdFiles.push(target);
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
    for (const file of createdFiles) rmSync(file, { recursive: true, force: true });
    discardGitWorktree(repoRoot, plan.path);
    if (registered) registry.worktrees.delete(id);
    throw err;
  }
}
