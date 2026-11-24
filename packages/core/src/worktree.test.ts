import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
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

function gitSucceeds(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Fixture paths can be reached through a symlinked temp root. */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function withEnv(name: string, value: string, run: () => void): void {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/** A hook that runs inside `git worktree add` after the target directory exists. */
function installPostCheckoutHook(repo: string, body: string): void {
  const hooks = join(repo, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function commit(dir: string, message: string): void {
  git(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', message], dir);
}

function newProjectRepo(): {
  dir: string; repo: string; storeDir: string; registry: core.Registry; project: core.Project;
} {
  const dir = mkdtempSync(join(tmpdir(), 'artinarey-new-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(['init', '-q'], repo);
  commit(repo, 'init');
  const storeDir = join(dir, 'store');
  const registry = core.openRegistry(join(dir, 'registry.sqlite'));
  const project = registry.projects.create({
    name: 'New', repoCommonDir: join(repo, '.git'), storeDir,
  });
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  registry.worktrees.upsert({
    id: core.newId(), projectId: project.id, path: repo, branch, portOffset: 0,
  });
  return { dir, repo, storeDir, registry, project };
}

function expectInvalidInput(run: () => unknown, label: string): void {
  assert.throws(run, (err: unknown) => {
    assert.ok(err instanceof core.ArtinareyError, `${label}: expected ArtinareyError`);
    assert.equal(err.code, 'INVALID_INPUT');
    return true;
  }, label);
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

test('parses lock reasons so ownership can be distinguished', () => {
  const text = [
    'worktree /repos/owned',
    `HEAD ${'a'.repeat(40)}`,
    'branch refs/heads/owned',
    'locked artinarey:dev-auth',
    '',
    'worktree /repos/manual',
    `HEAD ${'b'.repeat(40)}`,
    'branch refs/heads/manual',
    'locked manual hold',
    '',
  ].join('\n');

  const result = parseWorktreePorcelain(text);
  assert.equal(result[0]?.locked, true);
  assert.equal(result[0]?.lockReason, 'artinarey:dev-auth');
  assert.equal(result[1]?.locked, true);
  assert.equal(result[1]?.lockReason, 'manual hold');
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

test('parses NUL-delimited porcelain records with newlines in paths', () => {
  const text = [
    `worktree /repo/wt\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0\0`,
    `worktree /repo/wt\nnext\0HEAD ${'b'.repeat(40)}\0detached\0\0`,
  ].join('');

  const result = parseWorktreePorcelain(text);
  assert.equal(result.length, 2);
  assert.equal(result[0]?.path, '/repo/wt');
  assert.equal(result[0]?.branch, 'main');
  assert.equal(result[1]?.path, '/repo/wt\nnext');
  assert.equal(result[1]?.branch, null);
  assert.equal(result[1]?.detached, true);
});

test('empty porcelain output yields no worktrees', () => {
  assert.deepEqual(parseWorktreePorcelain(''), []);
});

test('lists this repository as a worktree', () => {
  const worktrees = listGitWorktrees(root);
  assert.ok(worktrees.length >= 1);
  assert.equal(worktrees.some((wt) => samePath(wt.path, root)), true);
});

test('listGitWorktrees keeps a worktree path containing a newline intact', () => {
  const repo = tempRepo();
  commit(repo, 'init');
  const path = join(repo, 'wt\nline');
  try {
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature/newline', path], {
      cwd: repo, stdio: 'ignore',
    });
    const listed = listGitWorktrees(repo);
    assert.equal(listed.some((wt) => samePath(wt.path, path)), true, JSON.stringify(listed));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('globalIgnoreCoverage probes the XDG default ignore file when core.excludesFile is unset', () => {
  const repo = tempRepo();
  const xdg = mkdtempSync(join(tmpdir(), 'artinarey-xdg-'));
  try {
    const config = join(xdg, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = Tester\n');
    mkdirSync(join(xdg, 'git'), { recursive: true });
    const ignore = join(xdg, 'git', 'ignore');
    writeFileSync(ignore, '.worktrees/\n');

    withGlobalConfig(config, () => withEnv('XDG_CONFIG_HOME', xdg, () => {
      assert.deepEqual(core.globalIgnoreCoverage(repo), {
        globalFile: ignore, coversWorktrees: true,
      });
    }));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(xdg, { recursive: true, force: true });
  }
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

    withGlobalConfig(config, () => withEnv('XDG_CONFIG_HOME', global, () => {
      assert.deepEqual(core.globalIgnoreCoverage(repo), {
        globalFile: null, coversWorktrees: false,
      });
    }));

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

test('globalIgnoreCoverage uses check-ignore exit status, not verbose output', () => {
  const repo = tempRepo();
  const global = mkdtempSync(join(tmpdir(), 'artinarey-global-'));
  try {
    const ignoreFile = join(global, 'ignore');
    const config = join(global, 'gitconfig');
    writeFileSync(config, `[core]\n\texcludesfile = ${ignoreFile}\n`);
    // A negated rule prints a matching line in verbose mode but does not ignore.
    writeFileSync(ignoreFile, '.worktrees/*\n!.worktrees/probe\n');

    withGlobalConfig(config, () => {
      assert.deepEqual(core.globalIgnoreCoverage(repo), {
        globalFile: ignoreFile, coversWorktrees: false,
      });
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  }
});

test('reconcileWorktrees matches by path then branch, then reports missing and unmanaged', () => {
  const base = mkdtempSync(join(tmpdir(), 'artinarey-reconcile-'));
  const registry = core.openRegistry(join(base, 'registry.sqlite'));
  try {
    const project = registry.projects.create({
      name: 'R', repoCommonDir: join(base, '.git'), storeDir: join(base, 'store'),
    });
    const same = join(base, 'same');
    const old = join(base, 'old');
    const moved = join(base, 'new');
    const missing = join(base, 'gone');
    const other = join(base, 'other');
    for (const path of [same, old, moved, other]) mkdirSync(path);

    const sameId = core.newId();
    const movedId = core.newId();
    const missingId = core.newId();
    registry.worktrees.upsert({ id: sameId, projectId: project.id, path: same, branch: 'main' });
    registry.worktrees.upsert({ id: movedId, projectId: project.id, path: old, branch: 'feature/moved' });
    registry.worktrees.upsert({ id: missingId, projectId: project.id, path: missing,
      branch: 'feature/gone' });

    const head1 = 'a'.repeat(40);
    const head2 = 'b'.repeat(40);
    const head3 = 'c'.repeat(40);
    const gitWorktrees: core.GitWorktree[] = [
      { path: same, head: head1, branch: 'main', detached: false, locked: false,
        prunable: false, bare: false },
      { path: moved, head: head2, branch: 'feature/moved', detached: false, locked: false,
        prunable: false, bare: false },
      { path: other, head: head3, branch: 'feature/other', detached: false, locked: false,
        prunable: false, bare: false },
    ];

    const rows = core.reconcileWorktrees(registry, project.id, gitWorktrees);
    assert.deepEqual(rows.map((r) => [r.state, r.flag ?? null, r.path, r.branch, r.head,
      r.worktreeId ?? null]), [
      ['managed', null, same, 'main', head1, sameId],
      ['managed', 'moved', moved, 'feature/moved', head2, movedId],
      ['unmanaged', null, other, 'feature/other', head3, null],
      ['missing', null, missing, 'feature/gone', '', missingId],
    ]);
  } finally {
    registry.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('planWorktree rejects bad input before creating any artifact', () => {
  const { dir, repo, registry, project } = newProjectRepo();
  try {
    mkdirSync(join(repo, '.worktrees', 'taken'), { recursive: true });
    git(['branch', 'artinarey/existing'], repo);

    expectInvalidInput(() => core.planWorktree(registry, project.id, repo, 'bad/name'),
      'name containing a slash');
    expectInvalidInput(() => core.planWorktree(registry, project.id, repo, 'taken'),
      'existing target directory');
    expectInvalidInput(() => core.planWorktree(registry, project.id, repo, 'existing'),
      'existing branch');
    expectInvalidInput(() => core.planWorktree(registry, project.id, repo, 'fresh', 'no/such/base'),
      'missing base ref');
    const tree = git(['write-tree'], repo);
    expectInvalidInput(() => core.planWorktree(registry, project.id, repo, 'tree-base', tree),
      'tree object used as base');

    assert.equal(existsSync(join(repo, '.worktrees', 'fresh')), false);
    assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/fresh'], repo),
      false);
    assert.equal(registry.worktrees.list(project.id).length, 1);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planWorktree builds a plan from existing worktrees and real env files', () => {
  const { dir, repo, registry, project } = newProjectRepo();
  try {
    for (const file of ['.env', '.env.local', '.env.artinarey']) {
      writeFileSync(join(repo, file), `${file}=kept\n`);
    }
    git(['worktree', 'add', '-q', '-b', 'artinarey/extra', join(dir, 'extra')], repo);

    const plan = core.planWorktree(registry, project.id, repo, 'fresh');

    assert.equal(plan.path, join(repo, '.worktrees', 'fresh'));
    assert.equal(plan.branch, 'artinarey/fresh');
    assert.equal(plan.base, git(['rev-parse', '--abbrev-ref', 'HEAD'], repo));
    assert.equal(plan.portOffset, 20);
    assert.deepEqual(plan.copy, ['.env', '.env.local']);
    assert.equal(plan.envFile, join(plan.path, '.env.artinarey'));
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createWorktree adds the git worktree, writes marker and env, and registers a row', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    for (const file of ['.env', '.env.local']) {
      writeFileSync(join(repo, file), `${file}=copied\n`);
    }
    const plan = core.planWorktree(registry, project.id, repo, 'auth');

    const worktree = core.createWorktree(registry, storeDir, plan);

    assert.equal(worktree.projectId, project.id);
    assert.equal(worktree.path, plan.path);
    assert.equal(worktree.branch, plan.branch);
    assert.equal(worktree.portOffset, plan.portOffset);
    assert.equal(listGitWorktrees(repo).some((wt) => samePath(wt.path, plan.path)), true);
    assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`], repo),
      true);

    const marker = core.findMarker(plan.path);
    assert.equal(marker?.marker.project_id, project.id);
    assert.equal(marker?.marker.worktree_id, worktree.id);

    assert.equal(readFileSync(plan.envFile, 'utf8'), 'ARTINAREY_PORT_OFFSET=10\n');
    assert.equal(statSync(plan.envFile).mode & 0o777, 0o600);
    for (const file of plan.copy) {
      const copied = join(plan.path, file);
      assert.equal(readFileSync(copied, 'utf8'), readFileSync(join(repo, file), 'utf8'));
      assert.equal(statSync(copied).mode & 0o777, 0o600);
    }

    const row = registry.worktrees.list(project.id).find((wt) => wt.id === worktree.id);
    assert.deepEqual(row, worktree);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createWorktree rolls back a failed write without registering the worktree', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    mkdirSync(join(repo, '.env.artinarey'));
    writeFileSync(join(repo, '.env.artinarey', 'keep'), 'tracked\n');
    git(['add', '.'], repo);
    commit(repo, 'add blocker');
    const plan = core.planWorktree(registry, project.id, repo, 'blocked');

    assert.throws(() => core.createWorktree(registry, storeDir, plan));

    assert.equal(existsSync(plan.path), false);
    assert.equal(listGitWorktrees(repo).some((wt) => samePath(wt.path, plan.path)), false);
    assert.equal(registry.worktrees.list(project.id).length, 1);
    assert.equal(existsSync(join(plan.path, '.artinarey.json')), false);
    assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`], repo),
      false, 'the branch created by the failed attempt must not block a retry');

    // Retrying the same name works once the blocker is gone from git too.
    git(['rm', '-r', '-f', '.env.artinarey'], repo);
    commit(repo, 'remove blocker');
    const retry = core.planWorktree(registry, project.id, repo, 'blocked');
    assert.equal(core.createWorktree(registry, storeDir, retry).branch, plan.branch);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createWorktree rejects a pre-existing target before git runs', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    git(['branch', 'base-tmp'], repo);
    const plan = core.planWorktree(registry, project.id, repo, 'raced', 'base-tmp');
    mkdirSync(plan.path, { recursive: true });
    writeFileSync(join(plan.path, 'mine.txt'), 'user data\n');
    git(['branch', '-D', 'base-tmp'], repo);

    // The directory exists at preflight, so git add is never attempted.
    expectInvalidInput(() => core.createWorktree(registry, storeDir, plan), 'pre-existing target');

    assert.equal(readFileSync(join(plan.path, 'mine.txt'), 'utf8'), 'user data\n');
    assert.equal(existsSync(join(plan.path, '.artinarey.json')), false);
    assert.equal(registry.worktrees.list(project.id).length, 1);
    assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`], repo),
      false);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollbackFailedAdd leaves a hook-created file in the git-registered worktree', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    installPostCheckoutHook(repo, [
      'top=$(git rev-parse --show-toplevel)',
      "printf 'HOOK FILE\\n' > \"$top/hook-created.txt\"",
      'exit 1',
    ].join('\n'));
    const plan = core.planWorktree(registry, project.id, repo, 'hook-add');

    assert.throws(() => core.createWorktree(registry, storeDir, plan));

    // Git registered the worktree before the hook failed: rollback must not delete
    // content the hook created after preflight.
    assert.equal(readFileSync(join(plan.path, 'hook-created.txt'), 'utf8'), 'HOOK FILE\n');
    assert.equal(existsSync(join(plan.path, '.artinarey.json')), false);
    assert.equal(listGitWorktrees(repo).some((wt) => samePath(wt.path, plan.path)), true);
    assert.equal(registry.worktrees.list(project.id).length, 1);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale plan for the same name cannot remove another caller\'s worktree', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    // Both callers plan the same name before either one creates it.
    const firstPlan = core.planWorktree(registry, project.id, repo, 'shared');
    const secondPlan = core.planWorktree(registry, project.id, repo, 'shared');
    assert.deepEqual(secondPlan, firstPlan);

    const first = core.createWorktree(registry, storeDir, firstPlan);
    const userFile = join(firstPlan.path, 'untracked.txt');
    writeFileSync(userFile, 'user data\n');

    expectInvalidInput(() => core.createWorktree(registry, storeDir, secondPlan),
      'second caller with a stale plan');

    assert.equal(readFileSync(userFile, 'utf8'), 'user data\n');
    assert.equal(listGitWorktrees(repo).some((wt) => samePath(wt.path, firstPlan.path)), true);
    assert.equal(core.findMarker(firstPlan.path)?.marker.worktree_id, first.id);
    assert.equal(registry.worktrees.list(project.id).length, 2);
    assert.equal(gitSucceeds(
      ['show-ref', '--verify', '--quiet', `refs/heads/${first.branch}`], repo,
    ), true, 'the first caller\'s branch is left intact');
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createWorktree refuses a symlinked env destination without writing through it', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const outside = join(dir, 'outside.env');
    writeFileSync(outside, 'OUTSIDE\n');
    symlinkSync(outside, join(repo, '.env'));
    git(['add', '.env'], repo);
    commit(repo, 'add symlink');

    const plan = core.planWorktree(registry, project.id, repo, 'symlinked');
    assert.throws(() => core.createWorktree(registry, storeDir, plan));

    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE\n');
    assert.equal(existsSync(plan.path), false);
    assert.equal(registry.worktrees.list(project.id).length, 1);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createWorktree does not overwrite a pre-existing env file or its permissions', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const tracked = join(repo, '.env');
    writeFileSync(tracked, 'TRACKED\n');
    chmodSync(tracked, 0o644);
    git(['add', '.env'], repo);
    commit(repo, 'add env');

    const plan = core.planWorktree(registry, project.id, repo, 'existing-env');
    assert.throws(() => core.createWorktree(registry, storeDir, plan));

    assert.equal(readFileSync(tracked, 'utf8'), 'TRACKED\n');
    assert.equal(statSync(tracked).mode & 0o777, 0o644);
    assert.equal(existsSync(plan.path), false);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adoptWorktree registers an unmanaged git worktree with its porcelain branch and marker', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const external = join(dir, 'vendor-wt');
    git(['worktree', 'add', '-q', '-b', 'artinarey/adopted', external], repo);

    const adopted = core.adoptWorktree(registry, storeDir, project.id, external);

    assert.equal(adopted.projectId, project.id);
    assert.equal(adopted.path, external);
    assert.equal(adopted.branch, 'artinarey/adopted');
    assert.equal(adopted.portOffset, 0);
    const marker = core.findMarker(external);
    assert.equal(marker?.marker.project_id, project.id);
    assert.equal(marker?.marker.worktree_id, adopted.id);
    assert.equal(registry.worktrees.list(project.id).length, 2);

    expectInvalidInput(
      () => core.adoptWorktree(registry, storeDir, project.id, external),
      'already registered worktree',
    );
    assert.equal(registry.worktrees.list(project.id).length, 2);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adoptWorktree refuses a plain directory and a worktree of another repository', () => {
  const { dir, storeDir, registry, project } = newProjectRepo();
  try {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expectInvalidInput(
      () => core.adoptWorktree(registry, storeDir, project.id, plain),
      'plain directory',
    );

    const otherRepo = join(dir, 'other');
    mkdirSync(otherRepo);
    git(['init', '-q'], otherRepo);
    commit(otherRepo, 'init');
    const foreign = join(dir, 'foreign-wt');
    git(['worktree', 'add', '-q', '-b', 'other/branch', foreign], otherRepo);
    expectInvalidInput(
      () => core.adoptWorktree(registry, storeDir, project.id, foreign),
      'worktree of another repository',
    );
    assert.equal(registry.worktrees.list(project.id).length, 1);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree refuses a bound worktree without touching the branch or binding', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const target = join(dir, 'bound');
    git(['worktree', 'add', '-q', '-b', 'artinarey/bound', target], repo);
    const worktree = core.adoptWorktree(registry, storeDir, project.id, target);
    const persona = core.createPersona(registry, storeDir, project.id, 'dev-bound', 'Bound');
    registry.bindings.bind(persona, worktree.id);

    expectInvalidInput(
      () => core.removeWorktree(registry, project.id, worktree.id),
      'bound worktree',
    );

    assert.equal(existsSync(target), true);
    assert.equal(gitSucceeds(
      ['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/bound'], repo,
    ), true);
    assert.equal(registry.bindings.forWorktree(worktree.id)?.id, persona);
    assert.equal(registry.worktrees.list(project.id).some((row) => row.id === worktree.id), true);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree after release drops git worktree, sessions and only its registry row, keeping the branch', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const target = join(repo, '.worktrees', 'gone');
    git(['worktree', 'add', '-q', '-b', 'artinarey/gone', target], repo);
    const worktree = core.adoptWorktree(registry, storeDir, project.id, target);
    const rootId = registry.worktrees.list(project.id).find((row) => samePath(row.path, repo))?.id;
    assert.ok(rootId);

    writeFileSync(join(target, '.env.artinarey'), 'ARTINAREY_PORT_OFFSET=10\n');
    // An adopted worktree has no generated-env manifest: a handwritten .env would
    // be dirt, so this fixture deliberately stays clean.
    const persona = core.createPersona(registry, storeDir, project.id, 'dev-gone', 'Gone');
    registry.bindings.bind(persona, worktree.id);
    for (const minute of ['01', '02']) {
      registry.sessions.append({
        projectId: project.id, worktreeId: worktree.id, personaId: persona,
        vendor: 'opencode', startedAt: `2026-11-24T10:${minute}:00Z`,
      });
    }
    registry.sessions.append({
      projectId: project.id, worktreeId: rootId, personaId: persona,
      vendor: 'opencode', startedAt: '2026-11-24T11:00:00Z',
    });

    assert.equal(core.lockGitWorktree(target, 'dev-gone'), true);
    core.releasePersona(registry, storeDir, persona);
    assert.equal(listGitWorktrees(repo).find((row) => samePath(row.path, target))?.locked, false);

    core.removeWorktree(registry, project.id, worktree.id);

    assert.equal(existsSync(target), false);
    assert.equal(listGitWorktrees(repo).some((row) => samePath(row.path, target)), false);
    assert.equal(gitSucceeds(
      ['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/gone'], repo,
    ), true);
    assert.deepEqual(registry.worktrees.list(project.id).map((row) => row.id), [rootId]);
    assert.deepEqual(registry.sessions.list(project.id).map((s) => s.worktreeId), [rootId]);
    const events = readFileSync(join(storeDir, 'events', 'audit.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const removal = events.find((event) => event.type === 'worktree_removed');
    assert.equal(removal?.worktree_id, worktree.id);
    assert.equal(removal?.sessions_removed, 2);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree refuses a dirty or locked worktree without changing any of its files or state', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const target = join(repo, '.worktrees', 'dirty');
    git(['worktree', 'add', '-q', '-b', 'artinarey/dirty', target], repo);
    const worktree = core.adoptWorktree(registry, storeDir, project.id, target);
    const persona = core.createPersona(registry, storeDir, project.id, 'dev-dirty', 'Dirty');
    registry.bindings.bind(persona, worktree.id);
    core.releasePersona(registry, storeDir, persona); // reach the dirty/locked guards, not the binding guard
    writeFileSync(join(target, '.env'), 'SECRET=kept\n');
    writeFileSync(join(target, '.env.artinarey'), 'ARTINAREY_PORT_OFFSET=10\n');
    registry.sessions.append({
      projectId: project.id, worktreeId: worktree.id, personaId: persona,
      vendor: 'opencode', startedAt: '2026-11-24T12:00:00Z',
    });
    const userFile = join(target, 'untracked.txt');
    writeFileSync(userFile, 'user data\n');

    expectInvalidInput(
      () => core.removeWorktree(registry, project.id, worktree.id),
      'dirty worktree',
    );

    assert.equal(readFileSync(join(target, '.artinarey.json'), 'utf8').includes(worktree.id), true);
    assert.equal(readFileSync(join(target, '.env'), 'utf8'), 'SECRET=kept\n');
    assert.equal(readFileSync(join(target, '.env.artinarey'), 'utf8'), 'ARTINAREY_PORT_OFFSET=10\n');
    assert.equal(readFileSync(userFile, 'utf8'), 'user data\n');
    assert.equal(registry.bindings.forWorktree(worktree.id), undefined);
    assert.equal(registry.worktrees.list(project.id).some((row) => row.id === worktree.id), true);
    assert.equal(registry.sessions.list(project.id).some((s) => s.worktreeId === worktree.id), true);
    assert.equal(gitSucceeds(
      ['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/dirty'], repo,
    ), true);

    rmSync(userFile, { force: true });
    git(['worktree', 'lock', '--reason', 'manual hold', target], repo);
    expectInvalidInput(
      () => core.removeWorktree(registry, project.id, worktree.id),
      'locked worktree',
    );
    assert.equal(readFileSync(join(target, '.artinarey.json'), 'utf8').includes(worktree.id), true);
    assert.equal(readFileSync(join(target, '.env'), 'utf8'), 'SECRET=kept\n');
    assert.equal(registry.worktrees.list(project.id).some((row) => row.id === worktree.id), true);
    assert.equal(core.unlockGitWorktree(target), false, 'a manual lock is not ours to release');
    git(['worktree', 'unlock', target], repo);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lockGitWorktree and unlockGitWorktree toggle a real worktree and return false in a plain dir', () => {
  const { dir, repo, registry } = newProjectRepo();
  try {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    assert.equal(core.lockGitWorktree(plain, 'dev-plain'), false);
    assert.equal(core.unlockGitWorktree(plain), false);

    const target = join(dir, 'lockable');
    git(['worktree', 'add', '-q', '-b', 'artinarey/lockable', target], repo);
    assert.equal(core.lockGitWorktree(target, 'dev-lockable'), true);
    assert.equal(listGitWorktrees(repo).find((row) => samePath(row.path, target))?.locked, true);
    assert.equal(core.unlockGitWorktree(target), true);
    assert.equal(listGitWorktrees(repo).find((row) => samePath(row.path, target))?.locked, false);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimPersona locks the bound git worktree and force release unlocks it', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const target = join(dir, 'locked');
    git(['worktree', 'add', '-q', '-b', 'artinarey/locked', target], repo);
    const worktree = core.adoptWorktree(registry, storeDir, project.id, target);
    const identity = core.resolveIdentity(registry, target);
    assert.equal(identity.ok, true);
    if (!identity.ok) return;

    const persona = core.createPersona(registry, storeDir, project.id, 'dev-locked', 'Locked');
    const claimed = core.claimPersona(registry, storeDir, identity.identity, { personaId: persona });
    assert.equal(claimed.ok, true);
    assert.equal(listGitWorktrees(repo).find((row) => samePath(row.path, target))?.locked, true);

    assert.equal(core.releaseWorktreeForce(registry, storeDir, worktree.id), true);
    assert.equal(listGitWorktrees(repo).find((row) => samePath(row.path, target))?.locked, false);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createWorktree rollback preserves hook-created files and the marker in a dirty worktree', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    writeFileSync(join(repo, '.env'), 'SECRET=copied\n');
    installPostCheckoutHook(repo, [
      'top=$(git rev-parse --show-toplevel)',
      "printf 'HOOK FILE\\n' > \"$top/user.txt\"",
      "printf 'HOOK ENV\\n' > \"$top/.env\"",
      'exit 0',
    ].join('\n'));
    const plan = core.planWorktree(registry, project.id, repo, 'dirty-rollback');

    assert.throws(() => core.createWorktree(registry, storeDir, plan), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as { code?: string }).code, 'INVALID_INPUT');
      assert.match(err.message, /retained worktree at/);
      assert.ok(err.message.includes(plan.path), 'error names the retained path');
      return true;
    });

    assert.equal(readFileSync(join(plan.path, 'user.txt'), 'utf8'), 'HOOK FILE\n');
    const marker = core.findMarker(plan.path);
    assert.ok(marker, 'the marker stays so the worktree can be re-adopted');
    assert.equal(marker?.marker.project_id, project.id);
    assert.equal(registry.worktrees.list(project.id).length, 1);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planWorktree and createWorktree reject a base that tracks the reserved marker', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    writeFileSync(join(repo, '.artinarey.json'), '{"schema":1}\n');
    git(['add', '.artinarey.json'], repo);
    commit(repo, 'track marker');

    expectInvalidInput(
      () => core.planWorktree(registry, project.id, repo, 'tracked-marker'),
      'tracked marker in plan',
    );

    const plan: core.WorktreePlan = {
      path: join(repo, '.worktrees', 'tracked-marker'),
      branch: 'artinarey/tracked-marker',
      base: 'HEAD',
      portOffset: 0,
      copy: [],
      envFile: join(repo, '.worktrees', 'tracked-marker', '.env.artinarey'),
    };
    expectInvalidInput(() => core.createWorktree(registry, storeDir, plan), 'tracked marker at add');

    assert.equal(existsSync(plan.path), false);
    assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', `refs/heads/${plan.branch}`], repo),
      false);
    assert.equal(registry.worktrees.list(project.id).length, 1);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree never treats a manifest path outside the env filenames as owned', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const target = join(repo, '.worktrees', 'manifest-path');
    git(['worktree', 'add', '-q', '-b', 'artinarey/manifest-path', target], repo);
    const worktree = core.adoptWorktree(registry, storeDir, project.id, target);
    const outside = join(repo, 'outside.env');
    writeFileSync(outside, 'OUTSIDE\n');
    const markerPath = join(target, '.artinarey.json');
    const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
    marker.generated_env = [{
      name: '../../outside.env',
      sha256: createHash('sha256').update('OUTSIDE\n').digest('hex'),
    }];
    writeFileSync(markerPath, JSON.stringify(marker));

    core.removeWorktree(registry, project.id, worktree.id);

    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE\n');
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree preserves a handwritten env file and refuses removal', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const target = join(repo, '.worktrees', 'handwritten');
    git(['worktree', 'add', '-q', '-b', 'artinarey/handwritten', target], repo);
    const worktree = core.adoptWorktree(registry, storeDir, project.id, target);
    const handwritten = join(target, '.env.local');
    writeFileSync(handwritten, 'MINE=kept\n');

    expectInvalidInput(
      () => core.removeWorktree(registry, project.id, worktree.id),
      'unlisted handwritten env',
    );

    assert.equal(readFileSync(handwritten, 'utf8'), 'MINE=kept\n');
    assert.equal(existsSync(target), true);
    assert.equal(listGitWorktrees(repo).some((row) => samePath(row.path, target)), true);
    assert.equal(registry.worktrees.list(project.id).some((row) => row.id === worktree.id), true);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree deletes only generated env copies listed in the marker manifest', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    writeFileSync(join(repo, '.env'), 'GENERATED=1\n');
    const plan = core.planWorktree(registry, project.id, repo, 'generated');
    const worktree = core.createWorktree(registry, storeDir, plan);
    const marker = JSON.parse(readFileSync(join(plan.path, '.artinarey.json'), 'utf8')) as {
      generated_env?: Array<{ name: string; sha256: string }>;
    };
    assert.deepEqual(marker.generated_env, [{
      name: '.env',
      sha256: createHash('sha256').update('GENERATED=1\n').digest('hex'),
    }]);

    core.removeWorktree(registry, project.id, worktree.id);

    assert.equal(existsSync(plan.path), false);
    assert.equal(registry.worktrees.list(project.id).some((row) => row.id === worktree.id), false);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree preserves an edited generated env copy and refuses removal', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    writeFileSync(join(repo, '.env'), 'GENERATED=1\n');
    const plan = core.planWorktree(registry, project.id, repo, 'edited');
    const worktree = core.createWorktree(registry, storeDir, plan);
    const generated = join(plan.path, '.env');
    writeFileSync(generated, 'EDITED=1\n');

    expectInvalidInput(
      () => core.removeWorktree(registry, project.id, worktree.id),
      'edited generated env',
    );

    assert.equal(readFileSync(generated, 'utf8'), 'EDITED=1\n');
    assert.equal(existsSync(plan.path), true);
    assert.equal(listGitWorktrees(repo).some((row) => samePath(row.path, plan.path)), true);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree refuses a symlinked generated env entry before staging', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    writeFileSync(join(repo, '.env'), 'GENERATED=1\n');
    const plan = core.planWorktree(registry, project.id, repo, 'env-symlink');
    const worktree = core.createWorktree(registry, storeDir, plan);
    const outside = join(dir, 'outside.env');
    writeFileSync(outside, 'OUTSIDE\n');
    const env = join(plan.path, '.env');
    rmSync(env);
    symlinkSync(outside, env);

    expectInvalidInput(
      () => core.removeWorktree(registry, project.id, worktree.id),
      'symlinked generated env',
    );

    assert.equal(lstatSync(env).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE\n');
    assert.equal(existsSync(plan.path), true);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree preserves an env entry replaced after staging when git refuses removal', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    writeFileSync(join(repo, '.env'), 'GENERATED=1\n');
    const plan = core.planWorktree(registry, project.id, repo, 'late-symlink');
    const worktree = core.createWorktree(registry, storeDir, plan);
    const outside = join(dir, 'outside.env');
    writeFileSync(outside, 'OUTSIDE\n');
    const env = join(plan.path, '.env');

    // Git sees new dirt only after preflight, so worktree removal fails at the last
    // moment while the env entry is now a symlink created by another process.
    const list = registry.sessions.list.bind(registry.sessions);
    let intruded = false;
    registry.sessions.list = ((...args: Parameters<typeof list>) => {
      if (!intruded) {
        intruded = true;
        writeFileSync(join(plan.path, 'intruder.txt'), 'late dirt\n');
        rmSync(env);
        symlinkSync(outside, env);
      }
      return list(...args);
    }) as typeof list;

    assert.throws(() => core.removeWorktree(registry, project.id, worktree.id));

    assert.equal(lstatSync(env).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE\n');
    assert.equal(registry.worktrees.list(project.id).some((row) => row.id === worktree.id), true);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removeWorktree reports committed removal even when the audit append fails', () => {
  const { dir, repo, storeDir, registry, project } = newProjectRepo();
  try {
    const target = join(repo, '.worktrees', 'audit-failed');
    git(['worktree', 'add', '-q', '-b', 'artinarey/audit-failed', target], repo);
    const worktree = core.adoptWorktree(registry, storeDir, project.id, target);
    const persona = core.createPersona(registry, storeDir, project.id, 'dev-audit', 'Audit');
    registry.sessions.append({
      projectId: project.id, worktreeId: worktree.id, personaId: persona,
      vendor: 'opencode', startedAt: '2026-11-24T13:00:00Z',
    });
    const auditFile = join(storeDir, 'events', 'audit.jsonl');
    rmSync(auditFile, { force: true });
    mkdirSync(auditFile, { recursive: true });

    const result = core.removeWorktree(registry, project.id, worktree.id);

    assert.equal(result.removed, true);
    assert.equal(result.auditWritten, false);
    assert.match(result.auditError ?? '', /audit/);
    assert.equal(existsSync(target), false);
    assert.equal(registry.worktrees.list(project.id).some((row) => row.id === worktree.id), false);
    assert.equal(registry.sessions.list(project.id).some((s) => s.worktreeId === worktree.id), false);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
