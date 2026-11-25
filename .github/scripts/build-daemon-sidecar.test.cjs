'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { build, prebuildName } = require('./build-daemon-sidecar.cjs');

test('prebuild name follows platform, architecture and libc', () => {
  assert.equal(prebuildName('linux', 'x64', false), 'linux-x64.node');
  assert.equal(prebuildName('linux', 'arm64', true), 'linuxmusl-arm64.node');
  assert.equal(prebuildName('darwin', 'arm64', false), 'darwin-arm64.node');
  assert.equal(prebuildName('win32', 'x64', false), 'win32-x64.node');
  assert.throws(() => prebuildName('freebsd', 'x64', false), /unsupported platform/);
});

test('sidecar bundle has a runnable node, daemon entry and loadable SQLite addon', (t) => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'artinarey-sidecar-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));

  build(out);

  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.entry, 'daemon.mjs');
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, process.arch);
  assert.equal(manifest.addon, prebuildName());

  const script = fs.readFileSync(path.join(out, manifest.entry), 'utf8');
  assert.ok(script.includes('artinarey daemon ready'));
  assert.ok(!script.includes("from './index.ts'"), 'TypeScript imports must be bundled away');

  const node = path.join(out, manifest.nodeBinary);
  assert.ok(fs.existsSync(node));
  const sqlite = path.join(out, 'node_modules', 'better-sqlite3');
  assert.ok(fs.existsSync(path.join(sqlite, 'lib', 'binding.js')));
  assert.ok(fs.existsSync(path.join(sqlite, 'prebuilds', manifest.addon)));

  const check = spawnSync(node, ['-e', [
    `const Database = require(${JSON.stringify(sqlite)});`,
    'const row = new Database(":memory:").prepare("select 1 as ok").get();',
    'if (row.ok !== 1) process.exit(1);',
  ].join('\n')], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
});
