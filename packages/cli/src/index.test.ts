import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, openRegistry, sendMail, type XdgPaths } from '@artinarey/core';
import { main } from './index.ts';

function capture(write: (s: string) => void) {
  const original = console.log;
  console.log = write;
  return () => { console.log = original; };
}

function tempEnv(): { env: NodeJS.ProcessEnv; paths: XdgPaths } {
  const root = join(tmpdir(), `artinarey-cli-${newId()}`);
  const configDir = join(root, 'config');
  const dataRoot = join(root, 'data');
  const cacheRoot = join(root, 'cache');
  const runtimeDir = join(root, 'runtime');
  for (const dir of [configDir, dataRoot, cacheRoot, runtimeDir]) mkdirSync(dir, { recursive: true });
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataRoot,
    XDG_CACHE_HOME: cacheRoot,
    XDG_RUNTIME_DIR: runtimeDir,
    PATH: process.env.PATH ?? '',
  };
  return { env, paths: {
    configDir: join(configDir, 'artinarey'),
    registryFile: join(configDir, 'artinarey', 'registry.sqlite'),
    tokenFile: join(configDir, 'artinarey', 'token'),
    socketPath: join(runtimeDir, 'artinarey', 'daemon.sock'),
    dataRoot: join(dataRoot, 'artinarey'),
    cacheRoot: join(cacheRoot, 'artinarey'),
  } };
}

test('the artinarey bin runs the CLI directly', () => {
  const { env } = tempEnv();
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    bin: { artinarey: string };
  };
  assert.equal(manifest.bin.artinarey, 'bin/artinarey');
  const result = spawnSync(join(packageDir, manifest.bin.artinarey), ['daemon', 'status'], {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.error?.message ?? ''}${result.stderr}`);
  assert.match(result.stdout, /daemon not running/);
});

test('artinarey storage show and set validate the data root', async () => {
  const { env, paths } = tempEnv();
  let output = '';
  const restore = capture((s) => { output += `${s}\n`; });
  let code: number;
  try {
    code = await main(['storage', 'show'], env);
  } finally {
    restore();
  }
  assert.equal(code, 0);
  assert.equal(output.trim(), paths.dataRoot);

  output = '';
  const restoreSet = capture((s) => { output += `${s}\n`; });
  try {
    code = await main(['storage', 'set', join(paths.dataRoot, 'elsewhere')], env);
  } finally {
    restoreSet();
  }
  assert.equal(code, 0);
  assert.match(output.trim(), /elsewhere$/);

  const originalError = console.error;
  let error = '';
  console.error = (s: unknown) => { error += `${String(s)}\n`; };
  try {
    code = await main(['storage', 'set', 'relative/root'], env);
  } finally {
    console.error = originalError;
  }
  assert.equal(code, 1);
  assert.match(error, /must be an absolute path/);
});

test('init places new projects under the saved storage root', async () => {
  const { env, paths } = tempEnv();
  const customRoot = join(env.HOME!, 'large-volume');
  mkdirSync(customRoot, { recursive: true });
  const restore = capture(() => {});
  try {
    assert.equal(await main(['storage', 'set', customRoot], env), 0);
    const repo = join(env.HOME!, 'repo');
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    assert.equal(await main(['init'], env, repo), 0);
  } finally {
    restore();
  }

  const registry = openRegistry(paths.registryFile);
  try {
    const project = registry.projects.list()[0];
    assert.ok(project, 'init must register a project');
    assert.equal(dirname(project.storeDir), customRoot);
    assert.notEqual(dirname(project.storeDir), paths.dataRoot);
  } finally {
    registry.close();
  }
});

test('artinarey reindex builds a cache index from the registered store', async () => {
  const { env, paths } = tempEnv();
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Cli Test',
    repoCommonDir: '/r/cli/.git',
    storeDir: join(paths.dataRoot, 'store'),
  });
  registry.close();

  mkdirSync(project.storeDir, { recursive: true });
  await sendMail(project.storeDir, {
    from: 'dev-a', to: ['senior-dev'], subject: 'cli', kind: 'note', action: 'none', body: 'body',
  }, { knownPersonas: ['dev-a', 'senior-dev'], role: 'dev-a' });

  let output = '';
  const restore = capture((s) => { output += `${s}\n`; });
  let code: number;
  try {
    code = await main(['reindex', project.id], env);
  } finally {
    restore();
  }

  assert.equal(code, 0);
  assert.match(output, /indexed 1 mail/);
  assert.equal(typeof readFileSync(join(paths.cacheRoot, project.id, 'index.sqlite')).length, 'number');
});

test('artinarey reindex reports unknown projects without throwing', async () => {
  const { env } = tempEnv();
  const original = console.error;
  let error = '';
  console.error = (s: unknown) => { error += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['reindex', 'missing'], env);
  } finally {
    console.error = original;
  }
  assert.equal(code, 1);
  assert.match(error, /unknown project/);
});

test('daemon start, status, and stop work through the CLI', async () => {
  const { env } = tempEnv();
  let output = '';
  const restore = capture((s) => { output += `${s}\n`; });
  try {
    assert.equal(await main(['daemon', 'status'], env), 0);
    assert.match(output, /daemon not running/);

    output = '';
    assert.equal(await main(['daemon', 'start'], env), 0);
    assert.match(output, /daemon started/);

    output = '';
    assert.equal(await main(['daemon', 'status'], env), 0);
    assert.match(output, /running/);

    output = '';
    assert.equal(await main(['daemon', 'stop'], env), 0);
    assert.match(output, /daemon stopped/);

    output = '';
    assert.equal(await main(['daemon', 'status'], env), 0);
    assert.match(output, /daemon not running/);
  } finally {
    restore();
    const originalError = console.error;
    console.error = () => {};
    await main(['daemon', 'stop'], env).catch(() => 0);
    console.error = originalError;
  }
});

test('a second daemon start is rejected with ALREADY_RUNNING', async () => {
  const { env } = tempEnv();
  const restore = capture(() => {});
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await main(['daemon', 'start'], env), 0);
    assert.equal(await main(['daemon', 'start'], env), 1);
  } finally {
    await main(['daemon', 'stop'], env).catch(() => 0);
    restore();
    console.error = originalError;
  }
});
