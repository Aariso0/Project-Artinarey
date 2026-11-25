import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoConnectOpencode } from './opencode-autoconnect.ts';

type Harness = { env: NodeJS.ProcessEnv; bundle: string; config: string; marker: string };

function harness(t: TestContext): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'artinarey-autoconnect-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const bundle = join(dir, 'bundle');
  const xdg = join(dir, 'config');
  mkdirSync(bin);
  mkdirSync(bundle);
  const fake = join(bin, 'opencode');
  writeFileSync(fake, '#!/bin/sh\n');
  chmodSync(fake, 0o755);
  writeFileSync(join(bundle, 'shim.mjs'), '');
  return {
    env: { HOME: dir, XDG_CONFIG_HOME: xdg, PATH: bin },
    bundle,
    config: join(xdg, 'opencode', 'opencode.json'),
    marker: join(xdg, 'artinarey', 'opencode-autoconnect.json'),
  };
}

test('first launch connects, later launches skip, version bump rewrites', (t) => {
  const { env, bundle, config, marker } = harness(t);

  const first = autoConnectOpencode(env, bundle, '0.1.2', '/bundled/node');
  assert.equal(first.status, 'connected');
  assert.equal(first.file, config);
  const written = JSON.parse(readFileSync(config, 'utf8')) as {
    mcp: { servers: Record<string, { command: string[] }> };
  };
  assert.deepEqual(written.mcp.servers.artinarey.command,
    ['/bundled/node', join(bundle, 'shim.mjs')]);
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).version, '0.1.2');

  assert.deepEqual(autoConnectOpencode(env, bundle, '0.1.2', '/bundled/node'), {
    status: 'skipped', reason: 'already_current', file: config,
  });

  const upgraded = autoConnectOpencode(env, bundle, '0.2.0', '/bundled/node');
  assert.equal(upgraded.status, 'connected');
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')).version, '0.2.0');
});

test('no OpenCode means no write', (t) => {
  const { env, bundle, config } = harness(t);
  env.PATH = '';
  rmSync(join(env.HOME as string, 'bin', 'opencode'));

  assert.deepEqual(autoConnectOpencode(env, bundle, '0.1.2'), {
    status: 'skipped', reason: 'opencode_absent',
  });
  assert.equal(existsSync(config), false);
});

test('missing shim and malformed config are skipped without throwing', (t) => {
  const { env, bundle, config, marker } = harness(t);
  rmSync(join(bundle, 'shim.mjs'));
  assert.deepEqual(autoConnectOpencode(env, bundle, '0.1.2'), {
    status: 'skipped', reason: 'shim_missing',
  });

  writeFileSync(join(bundle, 'shim.mjs'), '');
  mkdirSync(join(env.XDG_CONFIG_HOME as string, 'opencode'), { recursive: true });
  writeFileSync(config, '{not json');
  assert.deepEqual(autoConnectOpencode(env, bundle, '0.1.2'), {
    status: 'skipped', reason: 'invalid_config', file: config,
  });
  assert.equal(readFileSync(config, 'utf8'), '{not json');
  assert.equal(existsSync(marker), false);
});
