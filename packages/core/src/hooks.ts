import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ArtinareyError } from './errors.ts';

const HOOK_MARKER = 'artinarey lease-check';
const HOOK_LINE = `exec ${HOOK_MARKER} --staged`;
// Only a staged-file invocation counts: a bare lease-check inspects the working
// tree, not the index that the commit records. The template comment also has the marker.
const HOOK_INVOCATION = /^\s*(?:exec\s+)?artinarey\s+lease-check\s+--staged(?:\s|$)/m;
// Recognise the marker with the same whitespace-tolerant token matching so a
// valid invocation is not mistaken for an unrelated hook.
const HOOK_MARKER_TOKEN = /artinarey\s+lease-check\b/;
const PRE_COMMIT = [
  '#!/bin/sh',
  `# ${HOOK_MARKER} — reject files outside the active lease`,
  HOOK_LINE,
  '',
].join('\n');

export type HookInstall = { installed: boolean; note: string };

function gitConfig(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function isExecutable(path: string): boolean {
  // Windows hook execution is not governed by the POSIX executable bit.
  if (process.platform === 'win32') return true;
  try {
    return (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** Install the lease-check hook in the shared hooks dir without overriding an existing hooksPath. */
export function installHooks(repoDir: string, commonDir: string): HookInstall {
  const configured = gitConfig(repoDir, ['config', '--get', 'core.hooksPath']);
  if (configured !== '') {
    // Git expands ~ when --path is set; resolve() would look under repoDir/~/hooks.
    const expanded = gitConfig(repoDir, ['config', '--path', '--get', 'core.hooksPath']);
    const hookPath = resolve(repoDir, expanded || configured, 'pre-commit');
    let content: string;
    try {
      content = readFileSync(hookPath, 'utf8');
    } catch {
      return {
        installed: false,
        note: `cannot read ${hookPath}; add this line to it: ${HOOK_LINE}`,
      };
    }
    if (!HOOK_MARKER_TOKEN.test(content)) {
      return {
        installed: false,
        note: `core.hooksPath is already ${configured}; add this line to it: ${HOOK_LINE}`,
      };
    }
    if (!HOOK_INVOCATION.test(content)) {
      return {
        installed: false,
        note: `the hook at ${hookPath} only has the marker; restore this line: ${HOOK_LINE}`,
      };
    }
    if (!isExecutable(hookPath)) {
      return {
        installed: false,
        note: `the hook at ${hookPath} is not executable; make it executable with chmod +x`,
      };
    }
    return { installed: false, note: `lease-check hook already installed at ${hookPath}` };
  }

  const hooksDir = join(commonDir, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  if (existsSync(hookPath) && !HOOK_MARKER_TOKEN.test(readFileSync(hookPath, 'utf8'))) {
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

/** Paths from `--name-status -z`; R records need both paths, C records only the destination. */
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
      if (kind === 'R') paths.push(oldPath);
      paths.push(raw.slice(i, newEnd));
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
