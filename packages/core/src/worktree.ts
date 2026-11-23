import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
  });
  return parseWorktreePorcelain(output);
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
