import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from './index.ts';
import { listGitWorktrees, parseWorktreePorcelain } from './worktree.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'artinarey-repo-'));
  git(['init', '-q'], dir);
  return dir;
}

function withGlobalConfig(file: string, run: () => void): void {
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = file;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test('parses a normal worktree block', () => {
  const text = [
    'worktree /repos/project',
    'HEAD 0123456789abcdef0123456789abcdef01234567',
    'branch refs/heads/main',
    '',
  ].join('\n');

  assert.deepEqual(parseWorktreePorcelain(text), [{
    path: '/repos/project',
    head: '0123456789abcdef0123456789abcdef01234567',
    branch: 'main',
    detached: false,
    locked: false,
    prunable: false,
    bare: false,
  }]);
});

test('parses a detached block as branchless', () => {
  const text = [
    'worktree /repos/detached',
    'HEAD abcdefabcdefabcdefabcdefabcdefabcdefab',
    'detached',
    '',
  ].join('\n');

  assert.deepEqual(parseWorktreePorcelain(text), [{
    path: '/repos/detached',
    head: 'abcdefabcdefabcdefabcdefabcdefabcdefab',
    branch: null,
    detached: true,
    locked: false,
    prunable: false,
    bare: false,
  }]);
});

test('locked and prunable reasons do not leak into the following block', () => {
  const text = [
    'worktree /repos/locked',
    'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'branch refs/heads/locked',
    'locked kept for review',
    '',
    'worktree /repos/prunable',
    'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'prunable gitdir file points to a non-existent location',
    '',
    'worktree /repos/after',
    'HEAD cccccccccccccccccccccccccccccccccccccccc',
    'branch refs/heads/after',
    '',
  ].join('\n');

  const result = parseWorktreePorcelain(text);
  assert.equal(result.length, 3);
  assert.equal(result[0]?.path, '/repos/locked');
  assert.equal(result[0]?.locked, true);
  assert.equal(result[0]?.prunable, false);
  assert.equal(result[1]?.path, '/repos/prunable');
  assert.equal(result[1]?.prunable, true);
  assert.equal(result[1]?.locked, false);
  assert.deepEqual(result[2], {
    path: '/repos/after',
    head: 'cccccccccccccccccccccccccccccccccccccccc',
    branch: 'after',
    detached: false,
    locked: false,
    prunable: false,
    bare: false,
  });
});

test('parses a bare block', () => {
  const text = [
    'worktree /repos/bare.git',
    'bare',
    '',
  ].join('\n');

  assert.deepEqual(parseWorktreePorcelain(text), [{
    path: '/repos/bare.git',
    head: '',
    branch: null,
    detached: false,
    locked: false,
    prunable: false,
    bare: true,
  }]);
});

test('empty porcelain output yields no worktrees', () => {
  assert.deepEqual(parseWorktreePorcelain(''), []);
});

test('lists this repository as a worktree', () => {
  const worktrees = listGitWorktrees(root);
  assert.ok(worktrees.length >= 1);
  assert.equal(worktrees.some((wt) => wt.path === root), true);
});

test('core index re-exports the worktree module', () => {
  assert.equal(core.parseWorktreePorcelain, parseWorktreePorcelain);
  assert.equal(core.listGitWorktrees, listGitWorktrees);
  assert.equal(typeof core.resolveRepo, 'function');
  assert.equal(typeof core.ensureExcludeBlock, 'function');
  assert.equal(typeof core.globalIgnoreCoverage, 'function');
});

test('resolveRepo finds the root and an existing common dir from a subdirectory', () => {
  const repo = tempRepo();
  try {
    const nested = join(repo, 'nested', 'deep');
    mkdirSync(nested, { recursive: true });
    core.writeMarker(repo, 'project-1', 'worktree-1');

    const resolved = core.resolveRepo(nested);
    assert.equal(resolved.root, realpathSync(repo));
    assert.ok(existsSync(resolved.commonDir), `missing common dir: ${resolved.commonDir}`);
    assert.equal(core.findMarker(resolved.root)?.marker.project_id, 'project-1');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('ensureExcludeBlock leaves one managed block and preserves unrelated lines', () => {
  const repo = tempRepo();
  try {
    const { commonDir } = core.resolveRepo(repo);
    const file = join(commonDir, 'info', 'exclude');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '# keep me\n\n*.log\n');

    core.ensureExcludeBlock(commonDir);
    const first = readFileSync(file, 'utf8');
    core.ensureExcludeBlock(commonDir);
    const second = readFileSync(file, 'utf8');

    assert.equal(second, first, 'a second call must not change the file');
    assert.equal(count(second, '# >>> artinarey >>>'), 1);
    assert.equal(count(second, '# <<< artinarey <<<'), 1);
    for (const pattern of ['.worktrees/', '.artinarey.json', '.env.artinarey']) {
      assert.ok(second.includes(pattern), `missing pattern: ${pattern}`);
    }
    assert.ok(second.includes('# keep me'));
    assert.ok(second.includes('*.log'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('globalIgnoreCoverage reports no global excludes without writing files', () => {
  const repo = tempRepo();
  const global = mkdtempSync(join(tmpdir(), 'artinarey-global-'));
  try {
    const gitignore = join(repo, '.gitignore');
    writeFileSync(gitignore, '# local ignore\nnode_modules/\n');
    const config = join(global, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = Tester\n');
    const beforeConfig = readFileSync(config, 'utf8');

    withGlobalConfig(config, () => {
      assert.deepEqual(core.globalIgnoreCoverage(repo), {
        globalFile: null, coversWorktrees: false,
      });
    });

    assert.equal(readFileSync(gitignore, 'utf8'), '# local ignore\nnode_modules/\n');
    assert.equal(readFileSync(config, 'utf8'), beforeConfig);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  }
});

test('globalIgnoreCoverage checks the global file only, not the local exclude block', () => {
  const repo = tempRepo();
  const global = mkdtempSync(join(tmpdir(), 'artinarey-global-'));
  try {
    core.ensureExcludeBlock(core.resolveRepo(repo).commonDir);
    const ignoreFile = join(global, 'ignore');
    const config = join(global, 'gitconfig');
    writeFileSync(config, `[core]\n\texcludesfile = ${ignoreFile}\n`);

    writeFileSync(ignoreFile, '# global\n*.tmp\n');
    withGlobalConfig(config, () => {
      assert.deepEqual(core.globalIgnoreCoverage(repo), {
        globalFile: ignoreFile, coversWorktrees: false,
      });
    });

    writeFileSync(ignoreFile, '# global\n.worktrees/\n');
    withGlobalConfig(config, () => {
      assert.deepEqual(core.globalIgnoreCoverage(repo), {
        globalFile: ignoreFile, coversWorktrees: true,
      });
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  }
});
