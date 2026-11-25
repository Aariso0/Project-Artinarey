import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function configuredRepo(root: string, hooksPath: string): { repo: string; hook: string } {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['config', 'core.hooksPath', hooksPath], repo);
  const base = hooksPath.startsWith('~/') ? root : repo;
  return { repo, hook: join(base, hooksPath.replace(/^~\//, ''), 'pre-commit') };
}

test('installHooks expands ~ in core.hooksPath before checking the hook', () => {
  const root = join(tmpdir(), `artinarey-hooks-home-${newId()}`);
  const { repo, hook } = configuredRepo(root, '~/hooks');
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\nexec artinarey lease-check --staged\n', { mode: 0o755 });
  const originalHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const result = installHooks(repo, join(repo, '.git'));
    assert.equal(result.installed, false, result.note);
    assert.match(result.note, /already installed/);
    assert.match(result.note, new RegExp(join(root, 'hooks', 'pre-commit')));
  } finally {
    process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('installHooks accepts a staged lease-check with varied whitespace', () => {
  const root = join(tmpdir(), `artinarey-hooks-whitespace-${newId()}`);
  const { repo, hook } = configuredRepo(root, 'shared-hooks');
  mkdirSync(join(repo, 'shared-hooks'), { recursive: true });
  writeFileSync(hook, '#!/bin/sh\nexec   artinarey   lease-check   --staged\n', { mode: 0o755 });
  try {
    const result = installHooks(repo, join(repo, '.git'));
    assert.equal(result.installed, false, result.note);
    assert.match(result.note, /already installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installHooks reports invalid and unreadable configured hooks as not installed', () => {
  const cases = [
    {
      label: 'marker-only',
      body: '#!/bin/sh\n# artinarey lease-check — reject files outside the active lease\n',
      mode: 0o755,
      match: /restore this line: exec artinarey lease-check --staged/,
    },
    {
      label: 'bare-invocation',
      body: '#!/bin/sh\nartinarey lease-check\n',
      mode: 0o755,
      match: /restore this line: exec artinarey lease-check --staged/,
    },
    {
      label: 'non-executable',
      body: '#!/bin/sh\nexec artinarey lease-check --staged\n',
      mode: 0o644,
      match: /not executable/,
      posixOnly: true,
    },
  ];
  for (const entry of cases) {
    if (entry.posixOnly && process.platform === 'win32') continue;
    const root = join(tmpdir(), `artinarey-hooks-${entry.label}-${newId()}`);
    const { repo, hook } = configuredRepo(root, 'shared-hooks');
    mkdirSync(join(repo, 'shared-hooks'), { recursive: true });
    writeFileSync(hook, entry.body, { mode: entry.mode });
    try {
      const result = installHooks(repo, join(repo, '.git'));
      assert.equal(result.installed, false, `${entry.label}: ${result.note}`);
      assert.doesNotMatch(result.note, /already installed/);
      assert.match(result.note, entry.match);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = join(tmpdir(), `artinarey-hooks-unreadable-${newId()}`);
  const { repo, hook } = configuredRepo(root, 'shared-hooks');
  mkdirSync(hook, { recursive: true }); // readFileSync on a directory throws without relying on root permissions
  try {
    const result = installHooks(repo, join(repo, '.git'));
    assert.equal(result.installed, false);
    assert.match(result.note, /cannot read/);
    assert.match(result.note, /add this line to it: exec artinarey lease-check --staged/);
    assert.match(result.note, new RegExp(hook.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
