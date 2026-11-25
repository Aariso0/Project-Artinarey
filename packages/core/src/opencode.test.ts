import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectOpencodeAt, mergeOpencodeConfig, opencodeGlobalConfigPath, opencodeInstalled,
  OPENCODE_TOOLS,
} from './opencode.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'artinarey-opencode-'));
}

test('merge keeps unrelated config and replaces only Artinarey allow rules', () => {
  const merged = mergeOpencodeConfig({
    theme: 'keep-me',
    mcp: { servers: { other: { type: 'local', command: ['other'] } } },
    permissions: [
      { action: 'bash', resource: '*', effect: 'ask' },
      { action: 'artinarey_inbox', resource: 'old', effect: 'deny' },
    ],
  }, ['/node', '/shim.mjs']);

  assert.equal(merged.theme, 'keep-me');
  assert.deepEqual(merged.mcp?.servers?.other, { type: 'local', command: ['other'] });
  assert.deepEqual(merged.mcp?.servers?.artinarey, {
    type: 'local', command: ['/node', '/shim.mjs'], disabled: false,
  });
  const actions = (merged.permissions ?? []).map((rule) => rule.action);
  assert.ok(actions.includes('bash'));
  assert.equal(actions.filter((action) => action === 'artinarey_inbox').length, 1);
  const inbox = (merged.permissions ?? []).find((rule) => rule.action === 'artinarey_inbox');
  assert.equal(inbox?.effect, 'allow');
  for (const tool of OPENCODE_TOOLS) {
    assert.ok(actions.includes(`artinarey_${tool}`), `missing allow rule for ${tool}`);
  }

  const again = mergeOpencodeConfig(merged, ['/node', '/shim.mjs']);
  assert.deepEqual(again, merged, 'merge must be idempotent');
});

test('connectOpencodeAt writes an atomically replaced file', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'opencode.json');
  writeFileSync(file, '{"theme":"keep-me"}');

  connectOpencodeAt(file, ['/node', '/shim.mjs']);
  const first = JSON.parse(readFileSync(file, 'utf8')) as { theme: string };
  assert.equal(first.theme, 'keep-me');

  const before = readFileSync(file, 'utf8');
  connectOpencodeAt(file, ['/node', '/shim.mjs']);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('connectOpencodeAt preserves a restrictive config mode', (t) => {
  if (process.platform === 'win32') return; // POSIX mode bits are not authoritative on Windows
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'opencode.json');
  writeFileSync(file, '{}', { mode: 0o600 });

  connectOpencodeAt(file, ['/node', '/shim.mjs']);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('connectOpencodeAt creates a new config with owner-only mode', (t) => {
  if (process.platform === 'win32') return;
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  connectOpencodeAt(join(dir, 'opencode.json'), ['/node', '/shim.mjs']);
  assert.equal(statSync(join(dir, 'opencode.json')).mode & 0o777, 0o600);
});

test('opencodeInstalled detects a PATH binary or config dir, and nothing else', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const env = { HOME: dir, PATH: bin };

  assert.equal(opencodeInstalled(env), false);

  const fake = join(bin, 'opencode');
  writeFileSync(fake, '#!/bin/sh\n');
  chmodSync(fake, 0o755);
  assert.equal(opencodeInstalled(env), true);

  rmSync(fake);
  assert.equal(opencodeInstalled(env), false);
  const appData = join(dir, 'appdata');
  mkdirSync(join(appData, 'opencode'), { recursive: true });
  assert.equal(opencodeInstalled({ ...env, APPDATA: appData }), false,
    'OpenCode does not read a user config from APPDATA');
  rmSync(appData, { recursive: true, force: true });
  mkdirSync(join(dir, '.config', 'opencode'), { recursive: true });
  assert.equal(opencodeInstalled(env), true);
});

test('global config path ignores APPDATA and honours XDG and legacy HOME file', (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(
    opencodeGlobalConfigPath({ HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg') }),
    join(dir, 'xdg', 'opencode', 'opencode.json'),
  );
  assert.equal(
    opencodeGlobalConfigPath({ HOME: dir, XDG_CONFIG_HOME: join(dir, 'xdg'), APPDATA: join(dir, 'appdata') }),
    join(dir, 'xdg', 'opencode', 'opencode.json'),
  );
  assert.equal(
    opencodeGlobalConfigPath({ HOME: dir, APPDATA: join(dir, 'appdata') }),
    join(dir, '.config', 'opencode', 'opencode.json'),
  );

  const legacy = join(dir, '.opencode.json');
  writeFileSync(legacy, '{}');
  assert.equal(opencodeGlobalConfigPath({ HOME: dir }), legacy);
});
