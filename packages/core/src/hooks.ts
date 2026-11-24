import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ArtinareyError } from './errors.ts';

const HOOK_MARKER = 'artinarey lease-check';
const PRE_COMMIT = [
  '#!/bin/sh',
  `# ${HOOK_MARKER} — reject files outside the active lease`,
  'exec artinarey lease-check --staged',
  '',
].join('\n');

export type HookInstall = { installed: boolean; note: string };

/** Install the lease-check hook in the shared hooks dir without overriding an existing hooksPath. */
export function installHooks(repoDir: string, commonDir: string): HookInstall {
  let configured = '';
  try {
    configured = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // core.hooksPath is unset; git uses .git/hooks, which is per-worktree.
  }
  if (configured !== '') {
    return {
      installed: false,
      note: `core.hooksPath is already ${configured}; add this line to it: ${HOOK_MARKER}`,
    };
  }

  const hooksDir = join(commonDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  if (existsSync(hookPath) && !readFileSync(hookPath, 'utf8').includes(HOOK_MARKER)) {
    return {
      installed: false,
      note: `an unrelated pre-commit hook exists at ${hookPath}; add: ${HOOK_MARKER}`,
    };
  }
  writeFileSync(hookPath, PRE_COMMIT, { mode: 0o755 });
  execFileSync('git', ['config', 'core.hooksPath', hooksDir], { cwd: repoDir });
  return { installed: true, note: `pre-commit installed at ${hookPath}` };
}

function gitRaw(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function gitLines(cwd: string, args: string[]): string[] {
  return gitRaw(cwd, args).split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Paths from `--name-status -z`; R/C records carry the old path before the new one. */
function gitPaths(cwd: string, args: string[]): string[] {
  const raw = gitRaw(cwd, args);
  const paths: string[] = [];
  for (let i = 0; i < raw.length;) {
    const statusEnd = raw.indexOf('\0', i);
    if (statusEnd === -1) break;
    const kind = raw[i];
    i = statusEnd + 1;
    const firstEnd = raw.indexOf('\0', i);
    if (firstEnd === -1) break;
    if (kind === 'R' || kind === 'C') {
      const oldPath = raw.slice(i, firstEnd);
      i = firstEnd + 1;
      const newEnd = raw.indexOf('\0', i);
      if (newEnd === -1) break;
      paths.push(oldPath, raw.slice(i, newEnd));
      i = newEnd + 1;
    } else {
      paths.push(raw.slice(i, firstEnd));
      i = firstEnd + 1;
    }
  }
  return paths;
}

const DIFF_ARGS = ['--name-status', '-z', '-C', '--find-copies-harder',
  '--diff-filter=ACMRTD'];

/** Files staged for commit (--staged) or changed against HEAD (default). */
export function changedFiles(cwd: string, staged: boolean): string[] {
  return staged
    ? gitPaths(cwd, ['diff', '--cached', ...DIFF_ARGS])
    : gitPaths(cwd, ['diff', ...DIFF_ARGS, 'HEAD']);
}

/** Files changed between the merge base of HEAD and `branch`, and `branch`. */
export function branchChangedFiles(cwd: string, branch: string): string[] {
  const target = branch.replace(/^refs\/heads\//, '');
  let checkedOut = '';
  try {
    checkedOut = gitRaw(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']).trim();
  } catch {
    // Detached HEAD: no branch is checked out.
  }
  if (target === 'HEAD' || (checkedOut !== '' && checkedOut === target)) {
    throw new ArtinareyError('INVALID_INPUT',
      `verify needs a distinct merge target; ${branch} is checked out`);
  }
  const base = gitLines(cwd, ['merge-base', 'HEAD', branch])[0];
  if (!base) return [];
  return gitPaths(cwd, ['diff', ...DIFF_ARGS, base, branch]);
}
