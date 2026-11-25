import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { newId, openRegistry } from '@artinarey/core';
import { main } from './index.ts';

function workspace(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = join(tmpdir(), `artinarey-setup-cli-${newId()}`);
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

async function run(
  argv: string[], env: NodeJS.ProcessEnv, cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const log = console.log;
  const error = console.error;
  console.log = (value: unknown) => { out += `${String(value)}\n`; };
  console.error = (value: unknown) => { err += `${String(value)}\n`; };
  try {
    return { code: await main(argv, env, cwd), out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('project open registers a repo outside the current directory', async (t) => {
  const { dir, env } = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = repository(dir, 'existing');

  const result = await run(['project', 'open', repo], env, dir);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /project existing:/);
  const registry = openRegistry(join(dir, 'config', 'artinarey', 'registry.sqlite'));
  try {
    assert.equal(registry.projects.list().length, 1);
  } finally {
    registry.close();
  }
});

test('project clone creates a new folder and registers the cloned main', async (t) => {
  const { dir, env } = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = repository(dir, 'source');
  const target = join(dir, 'fresh', 'copy');

  const result = await run(['project', 'clone', source, target], env, dir);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /project copy:/);
  const registry = openRegistry(join(dir, 'config', 'artinarey', 'registry.sqlite'));
  try {
    const projects = registry.projects.list();
    assert.equal(projects.length, 1);
    const worktrees = registry.worktrees.list(projects[0]!.id);
    assert.equal(worktrees[0]?.path, target);
  } finally {
    registry.close();
  }
});

test('project commands report usage without a path or URL', async (t) => {
  const { dir, env } = workspace();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal((await run(['project', 'open'], env, dir)).code, 2);
  assert.equal((await run(['project', 'clone', 'url'], env, dir)).code, 2);
});
