'use strict';

const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const defaultOut = path.join(root, 'apps', 'gui', 'src-tauri', 'resources', 'daemon');
const entry = path.join(root, 'packages', 'daemon', 'src', 'sidecar.ts');

function parseArgs(argv) {
  let out = defaultOut;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out' && argv[index + 1]) {
      out = path.resolve(root, argv[++index]);
      continue;
    }
    throw new Error(`unknown argument: ${argv[index]}`);
  }
  return out;
}

function isMusl() {
  try {
    return /\/ld-musl-[^/\s]*\.so/.test(fs.readFileSync('/proc/self/maps', 'latin1'));
  } catch {
    return false;
  }
}

function prebuildName(platform = process.platform, arch = process.arch, musl = isMusl()) {
  if (!['linux', 'darwin', 'win32'].includes(platform)) {
    throw new Error(`unsupported platform: ${platform}`);
  }
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`unsupported architecture: ${arch}`);
  }
  const family = platform === 'linux' && musl ? 'linuxmusl' : platform;
  return `${family}-${arch}.node`;
}

function findInstalledPackage(name) {
  const pnpmRoot = path.join(root, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpmRoot)) {
    for (const folder of fs.readdirSync(pnpmRoot)) {
      if (!folder.startsWith(`${name}@`)) continue;
      const candidate = path.join(pnpmRoot, folder, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
  }
  const direct = path.join(root, 'node_modules', name);
  if (fs.existsSync(path.join(direct, 'package.json'))) return direct;
  throw new Error(`${name} not found; run pnpm install first`);
}

function build(out = defaultOut) {
  if (!fs.existsSync(entry)) throw new Error(`missing sidecar entry: ${entry}`);
  const sqlite = findInstalledPackage('better-sqlite3');
  const addon = prebuildName();
  if (!fs.existsSync(path.join(sqlite, 'prebuilds', addon))) {
    throw new Error(`better-sqlite3 prebuild missing for ${addon}`);
  }

  fs.rmSync(out, { recursive: true, force: true });
  const sqliteOut = path.join(out, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(path.join(sqliteOut, 'prebuilds'), { recursive: true });

  buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: path.join(out, 'daemon.mjs'),
    external: ['better-sqlite3'],
    logLevel: 'warning',
  });

  fs.copyFileSync(path.join(sqlite, 'package.json'), path.join(sqliteOut, 'package.json'));
  fs.cpSync(path.join(sqlite, 'lib'), path.join(sqliteOut, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(sqlite, 'prebuilds', addon), path.join(sqliteOut, 'prebuilds', addon));

  const nodeBinary = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.copyFileSync(process.execPath, path.join(out, nodeBinary));
  if (process.platform !== 'win32') fs.chmodSync(path.join(out, nodeBinary), 0o755);

  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify({
    appVersion: version,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    addon,
    entry: 'daemon.mjs',
    nodeBinary,
  }, null, 2)}\n`);

  return out;
}

module.exports = { build, parseArgs, prebuildName, findInstalledPackage, defaultOut };

if (require.main === module) {
  try {
    const out = build(parseArgs(process.argv.slice(2)));
    process.stdout.write(`daemon sidecar bundled at ${out}\n`);
  } catch (error) {
    process.stderr.write(`daemon sidecar build failed: ${error.message}\n`);
    process.exit(1);
  }
}
