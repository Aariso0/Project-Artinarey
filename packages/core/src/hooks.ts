import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

function gitLines(cwd: string, args: string[]): string[] {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').map((line) => line.trim()).filter(Boolean);
}

/** Files staged for commit (--staged) or changed against HEAD (default). */
export function changedFiles(cwd: string, staged: boolean): string[] {
  return staged
    ? gitLines(cwd, ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    : gitLines(cwd, ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']);
}

/** Files changed between the merge base of HEAD and `branch`, and `branch`. */
export function branchChangedFiles(cwd: string, branch: string): string[] {
  const base = gitLines(cwd, ['merge-base', 'HEAD', branch])[0];
  if (!base) return [];
  return gitLines(cwd, ['diff', '--name-only', '--diff-filter=ACMR', base, branch]);
}
