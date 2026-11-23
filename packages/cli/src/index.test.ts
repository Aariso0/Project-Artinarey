import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, openRegistry, sendMail } from '@artinarey/core';
import { main } from './index.ts';

function capture(write: (s: string) => void) {
  const original = console.log;
  console.log = write;
  return () => { console.log = original; };
}

test('artinarey reindex builds a cache index from the registered store', async () => {
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

  const registryFile = join(configDir, 'artinarey', 'registry.sqlite');
  const registry = openRegistry(registryFile);
  const project = registry.projects.create({
    name: 'Cli Test',
    repoCommonDir: '/r/cli/.git',
    storeDir: join(dataRoot, 'artinarey', 'store'),
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
  assert.equal(typeof readFileSync(join(cacheRoot, 'artinarey', project.id, 'index.sqlite')).length, 'number');
});

test('artinarey reindex reports unknown projects without throwing', async () => {
  const root = join(tmpdir(), `artinarey-cli-${newId()}`);
  for (const dir of ['config', 'data', 'cache', 'runtime']) mkdirSync(join(root, dir), { recursive: true });
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    PATH: process.env.PATH ?? '',
  };

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
