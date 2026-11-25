import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findMarker } from './identity.ts';
import { newId } from './ids.ts';
import { cloneProjectInto, registerProjectAt } from './project-setup.ts';
import { openRegistry } from './registry.ts';

function workspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = join(tmpdir(), `artinarey-setup-${newId()}`);
  for (const sub of ['config', 'data', 'cache', 'runtime']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return {
    dir,
    env: {
      HOME: dir,
      XDG_CONFIG_HOME: join(dir, 'config'),
      XDG_DATA_HOME: join(dir, 'data'),
      XDG_CACHE_HOME: join(dir, 'cache'),
      XDG_RUNTIME_DIR: join(dir, 'runtime'),
      PATH: process.env.PATH ?? '',
    },
  };
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function repository(parent: string, name: string): string {
  const path = join(parent, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 'test@example.com');
  git(path, 'config', 'user.name', 'Test');
  writeFileSync(join(path, 'README.md'), 'hello\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-q', '-m', 'initial');
  return path;
}

test('registerProjectAt registers an existing repo and its main worktree once', (t) => {
  const { dir, env } = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = repository(dir, 'existing');

  const first = registerProjectAt(repo, env);
  const second = registerProjectAt(repo, env);
  assert.equal(first.projectId, second.projectId);
  assert.equal(first.worktreeId, second.worktreeId);
  assert.equal(first.path, repo);
  assert.ok(first.hooksNote);

  const marker = findMarker(repo);
  assert.equal(marker?.marker.project_id, first.projectId);
  const registry = openRegistry(join(dir, 'config', 'artinarey', 'registry.sqlite'));
  try {
    assert.equal(registry.projects.list().length, 1);
    const worktrees = registry.worktrees.list(first.projectId);
    assert.equal(worktrees.length, 1);
    assert.equal(worktrees[0]?.path, repo);
    assert.equal(worktrees[0]?.branch, 'main');
  } finally {
    registry.close();
  }
});

test('registerProjectAt completes when the configured hook cannot be read', (t) => {
  const { dir, env } = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = repository(dir, 'unreadable-hook');
  git(repo, 'config', 'core.hooksPath', 'shared-hooks');
  mkdirSync(join(repo, 'shared-hooks', 'pre-commit'), { recursive: true });

  const result = registerProjectAt(repo, env);
  assert.equal(result.path, repo);
  assert.match(result.hooksNote, /cannot read/);
  assert.match(result.hooksNote, /add this line to it/);
});

test('cloneProjectInto clones a URL into a new folder and registers it', async (t) => {
  const { dir, env } = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = repository(dir, 'source');
  const target = join(dir, 'new-folder', 'copy');

  const result = await cloneProjectInto(source, target, env, dir);
  assert.equal(result.path, target);
  assert.ok(existsSync(join(target, '.git')));
  assert.equal(existsSync(join(target, 'README.md')), true);
  assert.ok(findMarker(target));
  git(target, 'worktree', 'list');
});

test('cloneProjectInto refuses a non-empty target and hides URL credentials', (t) => {
  const { dir, env } = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'occupied');
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), 'mine\n');
  assert.throws(
    () => cloneProjectInto('https://example.com/repo.git', target, env, dir),
    /target folder is not empty/,
  );

  assert.throws(
    () => cloneProjectInto(
      'https://user:supersecret@127.0.0.1:1/missing.git', join(dir, 'bad'), env, dir,
    ),
    (error: Error) => {
      assert.ok(!error.message.includes('supersecret'), 'credential leaked into the error');
      return true;
    },
  );
});
