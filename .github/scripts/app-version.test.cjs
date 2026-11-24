'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { after, test } = require('node:test');

const {
  normalizeVersion,
  readAppVersion,
  readManifestVersions,
  assertVersionsAgree,
  compareVersions,
  versionTag,
} = require('./app-version.cjs');

const script = resolve(__dirname, 'app-version.cjs');
const fixture = mkdtempSync(join(tmpdir(), 'artinarey-version-'));

mkdirSync(join(fixture, 'apps/gui/src-tauri'), { recursive: true });
writeFileSync(join(fixture, 'package.json'), '{"version":"0.1.0"}');
writeFileSync(join(fixture, 'apps/gui/package.json'), '{"version":"0.1.0"}');
writeFileSync(
  join(fixture, 'apps/gui/src-tauri/Cargo.toml'),
  '[package]\nname = "artinarey"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde = "1"\nversion = "9.9.9"\n',
);

after(() => {
  rmSync(fixture, { recursive: true, force: true });
});

test('readAppVersion reads the canonical root version', () => {
  assert.equal(readAppVersion(fixture), '0.1.0');
  assert.deepEqual(readManifestVersions(fixture), {
    root: '0.1.0',
    gui: '0.1.0',
    cargo: '0.1.0',
  });
});

test('normalizeVersion rejects non-semver values', () => {
  for (const value of ['1.2', 'v1.2.3', '1.2.3-beta', ' 1.2.3 ']) {
    assert.throws(() => normalizeVersion(value), /invalid version/);
  }
  assert.equal(normalizeVersion(' 1.2.3'), '1.2.3');
});

test('assertVersionsAgree passes only when all manifests match', () => {
  assert.doesNotThrow(() => assertVersionsAgree(fixture));
  writeFileSync(join(fixture, 'apps/gui/package.json'), '{"version":"0.1.1"}');
  assert.equal(readManifestVersions(fixture).gui, '0.1.1');
  assert.throws(() => assertVersionsAgree(fixture), /version mismatch/);
  writeFileSync(join(fixture, 'apps/gui/package.json'), '{"version":"0.1.0"}');
  assert.doesNotThrow(() => assertVersionsAgree(fixture));
});

test('compareVersions orders numeric semver components', () => {
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
});

test('versionTag formats the release tag', () => {
  assert.equal(versionTag('0.1.0'), 'v0.1.0');
});

test('CLI read, tag and compare print one bare line', () => {
  const read = execFileSync(process.execPath, [script, 'read'], { cwd: fixture, encoding: 'utf8' });
  const tag = execFileSync(process.execPath, [script, 'tag'], { cwd: fixture, encoding: 'utf8' });
  assert.equal(read, '0.1.0\n');
  assert.equal(tag, 'v0.1.0\n');
  const compare = (a, b) => execFileSync(process.execPath, [script, 'compare', a, b], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.equal(compare('0.1.0', '0.2.0'), '-1\n');
  assert.equal(compare('1.0.0', '0.9.9'), '1\n');
  assert.equal(compare('0.1.0', '0.1.0'), '0\n');
});
