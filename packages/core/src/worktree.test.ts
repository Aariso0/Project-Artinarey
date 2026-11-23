import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
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
    assert.equal(listGitWorktrees(repo).some((wt) => wt.path === plan.path), true);
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
    assert.equal(listGitWorktrees(repo).some((wt) => wt.path === plan.path), false);
    assert.equal(registry.worktrees.list(project.id).length, 1);
    assert.equal(existsSync(join(plan.path, '.artinarey.json')), false);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
