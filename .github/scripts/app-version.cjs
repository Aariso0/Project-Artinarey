'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function normalizeVersion(value) {
  if (typeof value !== 'string') {
    throw new Error(`invalid version: ${value}`);
  }
  const version = value.replace(/^\s+/, '');
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`invalid version: ${value}`);
  }
  return version;
}

function readJson(root, relativePath) {
  return JSON.parse(readFileSync(join(root, relativePath), 'utf8'));
}

function readAppVersion(root = process.cwd()) {
  return normalizeVersion(readJson(root, 'package.json').version);
}

function readCargoVersion(root) {
  const manifest = readFileSync(join(root, 'apps/gui/src-tauri/Cargo.toml'), 'utf8');
  let inPackage = false;
  for (const line of manifest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inPackage = trimmed === '[package]';
      continue;
    }
    if (!inPackage) continue;
    const match = /^version\s*=\s*"([^"]*)"/.exec(trimmed);
    if (match) return normalizeVersion(match[1]);
  }
  throw new Error('invalid version: no version under [package] in Cargo.toml');
}

function readManifestVersions(root = process.cwd()) {
  return {
    root: readAppVersion(root),
    gui: normalizeVersion(readJson(root, 'apps/gui/package.json').version),
    cargo: readCargoVersion(root),
  };
}

function assertVersionsAgree(root = process.cwd()) {
  const versions = readManifestVersions(root);
  for (const [manifest, version] of [
    ['apps/gui/package.json', versions.gui],
    ['apps/gui/src-tauri/Cargo.toml', versions.cargo],
  ]) {
    if (version !== versions.root) {
      throw new Error(
        `version mismatch: ${manifest} has ${version}, expected ${versions.root}`,
      );
    }
  }
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split('.').map(Number);
  const right = normalizeVersion(b).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function versionTag(version) {
  return `v${normalizeVersion(version)}`;
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case 'read':
      process.stdout.write(`${readAppVersion()}\n`);
      break;
    case 'agree':
      assertVersionsAgree();
      break;
    case 'tag':
      process.stdout.write(`${versionTag(readAppVersion())}\n`);
      break;
    case 'compare':
      process.stdout.write(`${compareVersions(args[0], args[1])}\n`);
      break;
    default:
      throw new Error('usage: app-version.cjs <read|agree|tag|compare A B>');
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  normalizeVersion,
  readAppVersion,
  readManifestVersions,
  assertVersionsAgree,
  compareVersions,
  versionTag,
};
