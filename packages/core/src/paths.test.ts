import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStore, resolveXdgPaths } from './paths.ts';

const fullEnv = {
  HOME: '/tmp/home',
  XDG_CONFIG_HOME: '/tmp/cfg',
  XDG_DATA_HOME: '/tmp/data',
  XDG_RUNTIME_DIR: '/tmp/run',
  XDG_CACHE_HOME: '/tmp/cache',
  PATH: '/usr/bin',
};

test('resolveXdgPaths honours explicit XDG overrides', () => {
  const p = resolveXdgPaths(fullEnv);

  assert.equal(p.configDir, '/tmp/cfg/artinarey');
  assert.equal(p.registryFile, '/tmp/cfg/artinarey/registry.sqlite');
  assert.equal(p.tokenFile, '/tmp/cfg/artinarey/token');
  assert.equal(p.socketPath, '/tmp/run/artinarey/daemon.sock');
  assert.equal(p.dataRoot, '/tmp/data/artinarey');
  assert.equal(p.cacheRoot, '/tmp/cache/artinarey');
});

test('resolveXdgPaths falls back to HOME-based XDG defaults', () => {
  const p = resolveXdgPaths({ HOME: '/tmp/home', PATH: '/usr/bin' });

  assert.equal(p.configDir, '/tmp/home/.config/artinarey');
  assert.equal(p.dataRoot, '/tmp/home/.local/share/artinarey');
  assert.equal(p.cacheRoot, '/tmp/home/.cache/artinarey');
  assert.match(p.socketPath, /artinarey\/daemon\.sock$/);
});

test('projectStore places a project directly under the data root', () => {
  assert.equal(projectStore('/tmp/data/artinarey', '01JD'), '/tmp/data/artinarey/01JD');
});
