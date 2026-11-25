import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTask, installHooks, newId, openRegistry, writeMarker,
} from '@artinarey/core';
import { main } from './index.ts';

type Captured = { code: number; out: string; err: string };

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commitFile(repo: string, path: string, body: string, message: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  git(['add', path], repo);
  git(['-c', 'user.name=Tester', '-c', 'user.email=t@example.com',
    'commit', '-q', '-m', message], repo);
}

function setup(): {
  env: NodeJS.ProcessEnv; repo: string; storeDir: string; worktreeId: string; branch: string;
} {
  const root = join(tmpdir(), `artinarey-lease-cli-${newId()}`);
  const configDir = join(root, 'config');
  const dataRoot = join(root, 'data');
  const runtimeDir = join(root, 'runtime');
  for (const dir of [configDir, dataRoot, runtimeDir]) mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: root,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataRoot,
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: runtimeDir,
    PATH: process.env.PATH ?? '',
  };

  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main'], repo);
  commitFile(repo, 'README.md', 'init\n', 'init');
  git(['checkout', '-q', '-b', 'feature'], repo);
  commitFile(repo, 'src/in.ts', 'export const x = 1;\n', 'covered edit');
  commitFile(repo, 'docs/out.md', 'outside\n', 'bypass edit');

  const storeDir = join(root, 'store');
  mkdirSync(storeDir, { recursive: true });
  const registryFile = join(configDir, 'artinarey', 'registry.sqlite');
  const registry = openRegistry(registryFile);
  const project = registry.projects.create({
    name: 'Lease', repoCommonDir: join(repo, '.git'), storeDir,
  });
  const worktreeId = newId();
  registry.worktrees.upsert({ id: worktreeId, projectId: project.id, path: repo, branch: 'feature' });
  registry.close();
  writeMarker(repo, project.id, worktreeId);
  createTask(storeDir, {
    id: 'T-1', projectId: project.id, title: 'covered', scope: ['src/**'],
    assignee: 'dev', status: 'in_progress', worktreeId, branch: 'feature',
    createdAt: new Date().toISOString(),
  });
  return { env, repo, storeDir, worktreeId, branch: 'feature' };
}

async function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Captured> {
  const originalLog = console.log;
  const originalError = console.error;
  let out = '';
  let err = '';
  console.log = (s: unknown) => { out += `${String(s)}\n`; };
  console.error = (s: unknown) => { err += `${String(s)}\n`; };
  try {
    const code = await main(args, env, cwd);
    return { code, out, err };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('verify catches a --no-verify commit that edited outside the lease', async () => {
  const { env, repo } = setup();
  git(['checkout', '-q', 'main'], repo);
  const result = await run(['verify', 'feature'], env, repo);
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /docs\/out\.md/);
  assert.doesNotMatch(result.err, /src\/in\.ts/);
});

test('lease-check --staged rejects a staged file outside the lease', async () => {
  const { env, repo } = setup();
  git(['checkout', '-q', 'main'], repo);
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'staged.md'), 'outside\n');
  git(['add', 'docs/staged.md'], repo);
  const result = await run(['lease-check', '--staged'], env, repo);
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /docs\/staged\.md/);
});

test('lease-check passes when every staged file is inside the lease', async () => {
  const { env, repo } = setup();
  git(['checkout', '-q', 'main'], repo);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'ok.ts'), 'export {};\n');
  git(['add', 'src/ok.ts'], repo);
  const result = await run(['lease-check', '--staged'], env, repo);
  assert.equal(result.code, 0, result.err);
});

test('installHooks writes the shared pre-commit hook and never overrides hooksPath', () => {
  const root = join(tmpdir(), `artinarey-hooks-${newId()}`);
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  const common = join(repo, '.git');

  const installed = installHooks(repo, common);
  assert.equal(installed.installed, true, installed.note);
  const hook = readFileSync(join(common, 'hooks', 'pre-commit'), 'utf8');
  assert.match(hook, /lease-check --staged/);
  assert.equal(git(['config', '--get', 'core.hooksPath'], repo).trim(), join(common, 'hooks'));

  const second = installHooks(repo, common);
  assert.equal(second.installed, false);
  assert.match(second.note, /already installed/);
  assert.doesNotMatch(second.note, /add this line/);
});
