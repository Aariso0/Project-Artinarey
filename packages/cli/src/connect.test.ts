import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  claimPersona, createPersona, findMarker, isUlid, newId, openRegistry, readPersona,
  releasePersona, resolveIdentity, resolveXdgPaths, writeMarker, writePersona,
} from '@artinarey/core';
import { createRpcServer } from '@artinarey/daemon';
import { main } from './index.ts';

function root(): string {
  const dir = join(tmpdir(), `artinarey-connect-${newId()}`);
  for (const sub of ['config', 'data', 'cache', 'runtime', 'worktree']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  return dir;
}

function envFor(dir: string): NodeJS.ProcessEnv {
  return {
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    XDG_RUNTIME_DIR: join(dir, 'runtime'),
    PATH: process.env.PATH ?? '',
  };
}

async function captureMain(
  argv: string[], env: NodeJS.ProcessEnv, cwd: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (s: unknown) => { out += `${String(s)}\n`; };
  console.error = (s: unknown) => { err += `${String(s)}\n`; };
  try {
    return { code: await main(argv, env, cwd), out, err };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function rehomeEvents(storeDir: string): Array<Record<string, unknown>> {
  const file = join(storeDir, 'events', 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.type === 'persona_rehome');
}

function gitSucceeds(args: string[], cwd: string): boolean {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function seededRepo(dir: string): {
  repo: string; env: NodeJS.ProcessEnv; registry: ReturnType<typeof openRegistry>;
  project: { id: string; storeDir: string };
} {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'init',
  ], { cwd: repo });
  const env = envFor(dir);
  const registry = openRegistry(resolveXdgPaths(env).registryFile);
  const project = registry.projects.create({
    name: 'Seed', repoCommonDir: join(repo, '.git'), storeDir: join(dir, 'data', 'store'),
  });
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: repo, encoding: 'utf8' }).trim();
  const rootId = newId();
  registry.worktrees.upsert({
    id: rootId, projectId: project.id, path: repo, branch, portOffset: 0,
  });
  writeMarker(repo, project.id, rootId);
  for (const file of ['.env', '.env.local']) {
    writeFileSync(join(repo, file), `${file}=root\n`);
  }
  return { repo, env, registry, project };
}

test('connect opencode writes an MCP entry and allow rules without clobbering config', async () => {
  const dir = root();
  const cwd = join(dir, 'worktree');
  writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({
    theme: 'keep-me',
    mcp: { servers: { other: { type: 'local', command: ['other'] } } },
    permissions: [{ action: 'bash', resource: '*', effect: 'ask' }],
  }));

  let error = '';
  const original = console.error;
  console.error = (s: unknown) => { error += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['connect', 'opencode'], envFor(dir), cwd);
  } finally {
    console.error = original;
  }
  assert.equal(code, 0, error);
  assert.equal(existsSync(join(cwd, 'opencode.json')), true);

  const config = JSON.parse(readFileSync(join(cwd, 'opencode.json'), 'utf8')) as {
    theme: string;
    mcp: { servers: Record<string, { type: string; command: string[] }> };
    permissions: Array<{ action: string; resource: string; effect: string }>;
  };
  assert.equal(config.theme, 'keep-me');
  assert.ok(config.mcp.servers.other);
  const server = config.mcp.servers.artinarey;
  assert.equal(server.type, 'local');
  assert.ok(server.command.some((part) => part.includes('packages/shim/src/index.ts')));

  const allowed = config.permissions.map((rule) => rule.action);
  for (const tool of [
    'check_in', 'claim_persona', 'inbox', 'read_mail',
    'send_mail', 'mark_done', 'report', 'worktrees',
  ]) {
    assert.ok(allowed.includes(`artinarey_${tool}`), `missing allow rule for ${tool}`);
  }
  assert.ok(allowed.includes('bash'), 'existing rules must survive');
});

test('artinarey init registers a project, writes the marker, and is idempotent', async () => {
  const dir = root();
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const globalConfig = join(dir, 'global-gitconfig');
  writeFileSync(globalConfig, '[user]\n\tname = Tester\n');
  const env = { ...envFor(dir), GIT_CONFIG_GLOBAL: globalConfig };
  const registry = openRegistry(resolveXdgPaths(env).registryFile);

  let output = '';
  const original = console.log;
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['init'], env, repo);
  } finally {
    console.log = original;
  }
  assert.equal(code, 0, output);
  assert.match(output, /global ignore/);

  const commonDir = resolve(repo, execFileSync(
    'git', ['rev-parse', '--git-common-dir'], { cwd: repo, encoding: 'utf8' },
  ).trim());
  const project = registry.projects.list().find((p) => p.repoCommonDir === commonDir);
  assert.ok(project, 'project with repoCommonDir not registered');
  const marker = findMarker(repo);
  assert.ok(marker, 'marker not written');
  assert.equal(marker.dir, repo);
  assert.equal(marker.marker.project_id, project.id);
  assert.ok(isUlid(marker.marker.project_id));
  assert.ok(isUlid(marker.marker.worktree_id));

  const worktrees = registry.worktrees.list(project.id);
  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0]?.id, marker.marker.worktree_id);
  assert.equal(worktrees[0]?.path, repo);

  const exclusion = readFileSync(join(commonDir, 'info', 'exclude'), 'utf8');
  for (const pattern of ['.worktrees/', '.artinarey.json', '.env.artinarey']) {
    assert.ok(exclusion.includes(pattern), `missing exclude pattern: ${pattern}`);
  }

  output = '';
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  let secondCode: number;
  try {
    secondCode = await main(['init'], env, repo);
  } finally {
    console.log = original;
  }
  assert.equal(secondCode, 0, output);
  assert.match(output, /global ignore/);
  assert.equal(registry.projects.list().length, 1);
  assert.equal(registry.worktrees.list(project.id).length, 1);
  assert.deepEqual(findMarker(repo)?.marker, marker.marker);
  registry.close();
});

test('worktree list prints each state and no registry id for unmanaged rows', async () => {
  const dir = root();
  const repo = join(dir, 'repo');
  const moved = join(dir, 'moved');
  const other = join(dir, 'other');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'init',
  ], { cwd: repo });
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'],
    { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'artinarey/moved', moved], { cwd: repo });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'artinarey/other', other], { cwd: repo });

  const env = envFor(dir);
  const registry = openRegistry(resolveXdgPaths(env).registryFile);
  const project = registry.projects.create({
    name: 'List', repoCommonDir: join(repo, '.git'), storeDir: join(dir, 'data', 'store'),
  });
  const rootId = newId();
  const movedId = newId();
  const missingId = newId();
  registry.worktrees.upsert({ id: rootId, projectId: project.id, path: repo, branch });
  registry.worktrees.upsert({ id: movedId, projectId: project.id, path: join(dir, 'old'),
    branch: 'artinarey/moved' });
  registry.worktrees.upsert({ id: missingId, projectId: project.id, path: join(dir, 'gone'),
    branch: 'artinarey/gone' });
  writeMarker(repo, project.id, rootId);

  let output = '';
  let errors = '';
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  console.error = (s: unknown) => { errors += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['worktree', 'list'], env, repo);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(code, 0, errors);

  const lineFor = (path: string): string => {
    const line = output.split('\n').find((l) => l.includes(path));
    assert.ok(line, `no output line for ${path}: ${output}`);
    return line;
  };
  assert.match(lineFor(repo), /^managed /);
  assert.ok(lineFor(repo).includes(rootId));
  assert.match(lineFor(moved), /^managed .* moved\b/);
  assert.ok(lineFor(moved).includes(movedId));
  assert.match(lineFor(join(dir, 'gone')), /^missing /);
  assert.ok(lineFor(join(dir, 'gone')).includes(missingId));
  const unmanaged = lineFor(other);
  assert.match(unmanaged, /^unmanaged /);
  assert.equal(unmanaged.split(/\s+/).some(isUlid), false,
    `unmanaged row must not print a registry id: ${unmanaged}`);
  registry.close();
});

test('release <worktree> --force frees a binding through the daemon', async () => {
  const dir = root();
  const env = envFor(dir);
  const paths = resolveXdgPaths(env);
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Release', repoCommonDir: '/r/.git', storeDir: join(dir, 'data', 'store'),
  });
  const worktreeId = newId();
  const cwd = join(dir, 'worktree');
  registry.worktrees.upsert({ id: worktreeId, projectId: project.id, path: cwd, branch: null });
  writeMarker(cwd, project.id, worktreeId);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-a', 'Dev A');
  registry.bindings.bind(persona, worktreeId);

  const server = createRpcServer(paths.socketPath, undefined, { registry, paths });
  await server.start();

  const original = console.log;
  let output = '';
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  try {
    assert.equal(await main(['release', worktreeId, '--force'], env, cwd), 0);
    assert.match(output, /released/);
    assert.equal(registry.bindings.forWorktree(worktreeId), undefined);
  } finally {
    console.log = original;
    await server.close();
    registry.close();
  }
});

test('worktree new prints the C4 warning and changes nothing without --yes', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const target = join(repo, '.worktrees', 'preview');

  let output = '';
  let errors = '';
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  console.error = (s: unknown) => { errors += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['worktree', 'new', 'preview'], env, repo);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(code, 2, errors);
  assert.match(output, /C4/);
  assert.match(output, /ARTINAREY_PORT_OFFSET=10/);
  assert.match(output, /\.env/);
  assert.match(output, /\.env\.local/);
  assert.match(output, /--yes/);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(target, '.artinarey.json')), false);
  assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/preview'], repo),
    false);
  assert.equal(registry.worktrees.list(project.id).length, 1);
  registry.close();
});

test('worktree new refuses a nested repo whose git root is not the project repo', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const nested = join(repo, 'nested');
  mkdirSync(nested);
  execFileSync('git', ['init', '-q'], { cwd: nested });
  execFileSync('git', [
    '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'nested',
  ], { cwd: nested });

  const result = await captureMain(['worktree', 'new', 'preview', '--yes'], env, nested);
  assert.equal(result.code, 1, `${result.err}${result.out}`);
  assert.match(result.err, /repo|project/i);
  assert.equal(existsSync(join(nested, '.worktrees', 'preview')), false);
  assert.equal(registry.worktrees.list(project.id).length, 1);
  registry.close();
});

test('worktree new still works from a linked worktree of the same project', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const linked = join(dir, 'linked');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'artinarey/linked', linked], { cwd: repo });
  assert.equal(await main(['worktree', 'adopt', linked], env, repo), 0);

  const result = await captureMain(['worktree', 'new', 'from-linked', '--yes'], env, linked);
  assert.equal(result.code, 0, `${result.err}${result.out}`);
  const target = join(linked, '.worktrees', 'from-linked');
  const row = registry.worktrees.list(project.id).find((wt) => wt.path === target);
  assert.ok(row, 'new worktree not registered under the project');
  assert.equal(findMarker(target)?.marker.worktree_id, row.id);
  registry.close();
});

test('worktree new --yes creates the worktree with marker, env files and offset', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const target = join(repo, '.worktrees', 'auth');

  let output = '';
  let errors = '';
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  console.error = (s: unknown) => { errors += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['worktree', 'new', 'auth', '--yes'], env, repo);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(code, 0, `${errors}${output}`);
  assert.ok(existsSync(target));
  assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/auth'], repo),
    true);
  assert.match(output, /created/);

  const marker = findMarker(target);
  assert.equal(marker?.marker.project_id, project.id);
  const row = registry.worktrees.list(project.id).find((wt) => wt.path === target);
  assert.ok(row, 'new worktree not registered');
  assert.equal(row.branch, 'artinarey/auth');
  assert.equal(row.portOffset, 10);
  assert.equal(marker?.marker.worktree_id, row.id);

  const envFile = join(target, '.env.artinarey');
  assert.equal(readFileSync(envFile, 'utf8'), 'ARTINAREY_PORT_OFFSET=10\n');
  assert.equal(statSync(envFile).mode & 0o777, 0o600);
  for (const file of ['.env', '.env.local']) {
    const copied = join(target, file);
    assert.equal(readFileSync(copied, 'utf8'), `${file}=root\n`);
    assert.equal(statSync(copied).mode & 0o777, 0o600);
  }
  registry.close();
});

test('worktree adopt <path> registers the git worktree and writes its marker', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const external = join(dir, 'vendor-wt');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'artinarey/vendor', external], { cwd: repo });

  let output = '';
  let errors = '';
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  console.error = (s: unknown) => { errors += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['worktree', 'adopt', external], env, repo);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(code, 0, errors);
  assert.match(output, /adopted/);
  const row = registry.worktrees.list(project.id).find((wt) => wt.path === external);
  assert.ok(row, 'adopted worktree not registered');
  assert.equal(row.branch, 'artinarey/vendor');
  assert.equal(row.portOffset, 0);
  assert.equal(findMarker(external)?.marker.project_id, project.id);
  assert.equal(findMarker(external)?.marker.worktree_id, row.id);
  registry.close();
});

test('worktree remove <name> refuses a bound worktree, then removes it after release', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const target = join(repo, '.worktrees', 'gone');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'artinarey/gone', target], { cwd: repo });
  assert.equal(await main(['worktree', 'adopt', target], env, repo), 0);
  const row = registry.worktrees.list(project.id).find((wt) => wt.path === target);
  assert.ok(row, 'adopted worktree not registered');
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-gone', 'Gone');
  registry.bindings.bind(persona, row.id);

  let output = '';
  let errors = '';
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  console.error = (s: unknown) => { errors += `${String(s)}\n`; };
  let refused: number;
  try {
    refused = await main(['worktree', 'remove', 'gone'], env, repo);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(refused, 1);
  assert.match(errors, /bound/);
  assert.equal(existsSync(target), true);
  assert.equal(registry.worktrees.list(project.id).some((wt) => wt.id === row.id), true);
  assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/gone'], repo), true);

  releasePersona(registry, project.storeDir, persona);
  output = '';
  errors = '';
  console.log = (s: unknown) => { output += `${String(s)}\n`; };
  console.error = (s: unknown) => { errors += `${String(s)}\n`; };
  let removed: number;
  try {
    removed = await main(['worktree', 'remove', 'gone'], env, repo);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(removed, 0, `${errors}${output}`);
  assert.match(output, /removed/);
  assert.equal(existsSync(target), false);
  assert.equal(registry.worktrees.list(project.id).some((wt) => wt.id === row.id), false);
  assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/gone'], repo), true);
  registry.close();
});

test('persona list prints role, name, home and state for the current project only', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const dev = createPersona(registry, project.storeDir, project.id, 'dev-auth', 'Auth dev');
  writePersona(project.storeDir, dev, {
    role: 'dev-auth', name: 'Auth dev', home_worktree_id: rootRow.id,
    state: 'active', vendor: null, last_vendor_session_id: null,
  });
  const otherProject = registry.projects.create({
    name: 'Other', repoCommonDir: join(dir, 'other.git'),
    storeDir: join(dir, 'data', 'other-store'),
  });
  createPersona(registry, otherProject.storeDir, otherProject.id, 'foreign', 'Foreign dev');

  const result = await captureMain(['persona', 'list'], env, repo);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /dev-auth/);
  assert.match(result.out, /Auth dev/);
  assert.match(result.out, new RegExp(rootRow.id));
  assert.match(result.out, /active/);
  assert.doesNotMatch(result.out, /foreign|Foreign dev/);
  registry.close();
});

test('persona rehome resolves role and path, then clears the confirmation requirement', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const target = join(dir, 'wt2');
  mkdirSync(target, { recursive: true });
  const targetId = newId();
  registry.worktrees.upsert({ id: targetId, projectId: project.id, path: target,
    branch: 'artinarey/wt2' });
  writeMarker(target, project.id, targetId);
  const dev = createPersona(registry, project.storeDir, project.id, 'dev-auth', 'Auth dev');
  writePersona(project.storeDir, dev, {
    role: 'dev-auth', name: 'Auth dev', home_worktree_id: rootRow.id,
    state: 'idle', vendor: null, last_vendor_session_id: null,
  });

  const identity = resolveIdentity(registry, target);
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  const blocked = claimPersona(registry, project.storeDir, identity.identity, { personaId: dev });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.code, 'NEEDS_CONFIRMATION');

  const result = await captureMain(['persona', 'rehome', 'dev-auth', 'wt2'], env, repo);
  assert.equal(result.code, 0, `${result.err}${result.out}`);
  assert.match(result.out, /rehomed/);
  assert.equal(readPersona(project.storeDir, dev).home_worktree_id, targetId);
  const events = rehomeEvents(project.storeDir);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.persona_id, dev);
  assert.equal(events[0]?.worktree_id, targetId);

  assert.equal(claimPersona(registry, project.storeDir, identity.identity, { personaId: dev }).ok, true);
  registry.close();
});

test('persona rehome refuses another project, unknown ids and missing arguments', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const dev = createPersona(registry, project.storeDir, project.id, 'dev-auth', 'Auth dev');
  writePersona(project.storeDir, dev, {
    role: 'dev-auth', name: 'Auth dev', home_worktree_id: rootRow.id,
    state: 'idle', vendor: null, last_vendor_session_id: null,
  });
  const otherProject = registry.projects.create({
    name: 'Other', repoCommonDir: join(dir, 'other.git'),
    storeDir: join(dir, 'data', 'other-store'),
  });
  const foreignWt = newId();
  registry.worktrees.upsert({ id: foreignWt, projectId: otherProject.id,
    path: join(dir, 'foreign-wt'), branch: 'artinarey/foreign' });

  const cross = await captureMain(['persona', 'rehome', dev, foreignWt], env, repo);
  assert.equal(cross.code, 1, cross.out);
  assert.match(cross.err, /different project/i);
  assert.equal(readPersona(project.storeDir, dev).home_worktree_id, rootRow.id);
  assert.equal(rehomeEvents(project.storeDir).length, 0);

  const foreign = createPersona(registry, otherProject.storeDir, otherProject.id, 'foreign', 'Foreign');
  const foreignPersona = await captureMain(['persona', 'rehome', foreign, rootRow.id], env, repo);
  assert.equal(foreignPersona.code, 1, foreignPersona.out);
  assert.match(foreignPersona.err, /unknown persona/);

  const unknown = await captureMain(['persona', 'rehome', 'nobody', 'wt2'], env, repo);
  assert.equal(unknown.code, 1, unknown.out);
  assert.match(unknown.err, /unknown persona/);
  assert.equal(rehomeEvents(project.storeDir).length, 0);
  assert.equal(rehomeEvents(otherProject.storeDir).length, 0);

  const usage = await captureMain(['persona', 'rehome', 'dev-auth'], env, repo);
  assert.equal(usage.code, 2, usage.out);
  assert.match(usage.err, /usage: artinarey persona list \| rehome <persona> <worktree>/);
  registry.close();
});

test('worktree remove <name> leaves a dirty worktree and all of its state untouched', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const target = join(repo, '.worktrees', 'dirty');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'artinarey/dirty', target], { cwd: repo });
  assert.equal(await main(['worktree', 'adopt', target], env, repo), 0);
  const row = registry.worktrees.list(project.id).find((wt) => wt.path === target);
  assert.ok(row, 'adopted worktree not registered');
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-dirty', 'Dirty');
  registry.bindings.bind(persona, row.id);
  releasePersona(registry, project.storeDir, persona); // reach the dirty guard, not the binding guard
  writeFileSync(join(target, '.env'), 'SECRET=kept\n');
  writeFileSync(join(target, 'untracked.txt'), 'user data\n');

  let errors = '';
  const originalError = console.error;
  console.error = (s: unknown) => { errors += `${String(s)}\n`; };
  let code: number;
  try {
    code = await main(['worktree', 'remove', 'dirty'], env, repo);
  } finally {
    console.error = originalError;
  }

  assert.equal(code, 1);
  assert.match(errors, /uncommitted or untracked/);
  assert.equal(existsSync(join(target, '.artinarey.json')), true);
  assert.equal(readFileSync(join(target, '.env'), 'utf8'), 'SECRET=kept\n');
  assert.equal(readFileSync(join(target, 'untracked.txt'), 'utf8'), 'user data\n');
  assert.equal(registry.bindings.forWorktree(row.id), undefined);
  assert.equal(registry.worktrees.list(project.id).some((wt) => wt.id === row.id), true);
  assert.equal(gitSucceeds(['show-ref', '--verify', '--quiet', 'refs/heads/artinarey/dirty'], repo), true);
  registry.close();
});

function stubVendor(dir: string, exitCode = 0): { command: string; out: string } {
  const command = join(dir, `stub-vendor-${exitCode}`);
  const out = join(dir, `stub-vendor-${exitCode}.out`);
  writeFileSync(command, [
    '#!/bin/sh',
    `pwd -P > '${out}'`,
    "printf 'VENDOR_MARKER\\n'",
    `exit ${exitCode}`,
  ].join('\n'), { mode: 0o755 });
  return { command, out };
}

/** A vendor that opens the same isolated registry and moves the binding mid-run. */
function stubRebindVendor(
  dir: string, personaId: string, worktreeId: string, worktreePath: string,
): string {
  const require = createRequire(import.meta.url);
  const coreUrl = pathToFileURL(require.resolve('@artinarey/core')).href;
  const script = join(dir, 'rebind-vendor.mjs');
  writeFileSync(script, [
    `const core = await import(${JSON.stringify(coreUrl)});`,
    'const registry = core.openRegistry(core.resolveXdgPaths(process.env).registryFile);',
    'try {',
    `  registry.bindings.bind(${JSON.stringify(personaId)}, ${JSON.stringify(worktreeId)});`,
    `  core.lockGitWorktree(${JSON.stringify(worktreePath)}, 'mid-run rebind');`,
    '} finally {',
    '  registry.close();',
    '}',
  ].join('\n'));
  const command = join(dir, 'rebind-vendor.sh');
  writeFileSync(command, [
    '#!/bin/sh',
    `exec '${process.execPath}' --import '${require.resolve('tsx/esm')}' '${script}'`,
  ].join('\n'), { mode: 0o755 });
  return command;
}

function worktreeLocked(cwd: string): boolean {
  const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd, encoding: 'utf8',
  });
  const block = porcelain.split('\n\n')
    .find((part) => part.startsWith(`worktree ${realpathSync(cwd)}\n`));
  return /^locked /m.test(block ?? '');
}

/** A vendor that records a newer active session, as a later overlapping claim would. */
function stubLaterSessionVendor(
  dir: string, projectId: string, worktreeId: string, personaId: string,
): string {
  const require = createRequire(import.meta.url);
  const coreUrl = pathToFileURL(require.resolve('@artinarey/core')).href;
  const script = join(dir, 'later-session.mjs');
  writeFileSync(script, [
    `const core = await import(${JSON.stringify(coreUrl)});`,
    'const registry = core.openRegistry(core.resolveXdgPaths(process.env).registryFile);',
    'try {',
    `  registry.sessions.append({ projectId: ${JSON.stringify(projectId)},`,
    `    worktreeId: ${JSON.stringify(worktreeId)}, personaId: ${JSON.stringify(personaId)},`,
    `    vendor: 'opencode', startedAt: new Date(Date.now() + 60000).toISOString() });`,
    '} finally {',
    '  registry.close();',
    '}',
  ].join('\n'));
  const command = join(dir, 'later-session.sh');
  writeFileSync(command, [
    '#!/bin/sh',
    `exec '${process.execPath}' --import '${require.resolve('tsx/esm')}' '${script}'`,
  ].join('\n'), { mode: 0o755 });
  return command;
}

test('run rolls back binding, lock and persona state when the claim audit fails', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-failed', 'Failed');
  const beforeState = readPersona(project.storeDir, persona);
  const vendor = stubVendor(dir);
  const auditFile = join(project.storeDir, 'events', 'audit.jsonl');
  rmSync(auditFile, { force: true });
  mkdirSync(auditFile);

  const result = await captureMain(
    ['run', 'opencode', '--persona', persona],
    { ...env, ARTINAREY_TEST_VENDOR: vendor.command }, repo,
  );
  assert.equal(result.code, 1, `${result.err}${result.out}`);
  assert.equal(existsSync(vendor.out), false);
  assert.equal(registry.bindings.forWorktree(rootRow.id), undefined);
  assert.deepEqual(readPersona(project.storeDir, persona), beforeState);
  assert.equal(worktreeLocked(repo), false);
  registry.close();
});

test('run preserves a pre-existing binding when the claim audit fails', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-existing', 'Existing');
  registry.bindings.bind(persona, rootRow.id);
  const vendor = stubVendor(dir);
  const auditFile = join(project.storeDir, 'events', 'audit.jsonl');
  rmSync(auditFile, { force: true });
  mkdirSync(auditFile);

  const result = await captureMain(
    ['run', 'opencode', '--persona', persona],
    { ...env, ARTINAREY_TEST_VENDOR: vendor.command }, repo,
  );
  assert.equal(result.code, 1, `${result.err}${result.out}`);
  assert.equal(registry.bindings.forWorktree(rootRow.id)?.id, persona);
  registry.close();
});

test('run leaves a newer overlapping claim bound when its own session ends', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-overlap', 'Overlap');
  const vendor = stubLaterSessionVendor(dir, project.id, rootRow.id, persona);

  const result = await captureMain(
    ['run', 'opencode', '--persona', persona],
    { ...env, ARTINAREY_TEST_VENDOR: vendor }, repo,
  );
  assert.equal(result.code, 0, `${result.err}${result.out}`);
  assert.equal(registry.bindings.forWorktree(rootRow.id)?.id, persona);
  assert.equal(readPersona(project.storeDir, persona).state, 'active');
  assert.equal(registry.sessions.list(project.id).length, 2);
  registry.close();
});

test('run opencode binds a persona, records a complete session and releases on exit', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-run', 'Dev Run');
  const vendor = stubVendor(dir);

  const result = await captureMain(
    ['run', 'opencode', '--persona', persona],
    { ...env, ARTINAREY_TEST_VENDOR: vendor.command }, repo,
  );
  assert.equal(result.code, 0, `${result.err}${result.out}`);
  assert.equal(readFileSync(vendor.out, 'utf8').trim(), realpathSync(repo));
  assert.equal(registry.bindings.forWorktree(rootRow.id), undefined);
  assert.equal(readPersona(project.storeDir, persona).state, 'idle');

  const sessions = registry.sessions.list(project.id);
  assert.equal(sessions.length, 1);
  const session = sessions[0];
  assert.equal(session?.vendor, 'opencode');
  assert.equal(session?.personaId, persona);
  assert.equal(session?.worktreeId, rootRow.id);
  assert.ok(session?.startedAt);
  assert.ok(session?.endedAt);
  assert.ok(session!.endedAt! >= session!.startedAt);
  registry.close();
});

test('run returns the vendor exit code and still releases and closes the session', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-fail', 'Dev Fail');
  const vendor = stubVendor(dir, 7);

  const result = await captureMain(
    ['run', 'opencode', '--persona', persona],
    { ...env, ARTINAREY_TEST_VENDOR: vendor.command }, repo,
  );
  assert.equal(result.code, 7, `${result.err}${result.out}`);
  assert.equal(readFileSync(vendor.out, 'utf8').trim(), realpathSync(repo));
  assert.equal(registry.bindings.forWorktree(rootRow.id), undefined);
  const sessions = registry.sessions.list(project.id);
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0]?.endedAt);
  registry.close();
});

test('run leaves a binding moved to another worktree mid-run intact', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const secondPath = join(repo, '.worktrees', 'rebound');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'artinarey/rebound', secondPath],
    { cwd: repo });
  const adopted = await captureMain(['worktree', 'adopt', secondPath], env, repo);
  assert.equal(adopted.code, 0, adopted.err);
  const secondRow = registry.worktrees.list(project.id).find((wt) => wt.path === secondPath);
  assert.ok(secondRow);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-rebind', 'Dev Rebind');
  const vendor = stubRebindVendor(dir, persona, secondRow.id, secondPath);

  const result = await captureMain(
    ['run', 'opencode', '--persona', persona],
    { ...env, ARTINAREY_TEST_VENDOR: vendor }, repo,
  );
  assert.equal(result.code, 0, `${result.err}${result.out}`);
  assert.equal(registry.bindings.forWorktree(rootRow.id), undefined);
  assert.equal(registry.bindings.forWorktree(secondRow.id)?.id, persona);
  assert.equal(readPersona(project.storeDir, persona).state, 'active');

  const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'],
    { cwd: repo, encoding: 'utf8' });
  const secondBlock = porcelain.split('\n\n')
    .find((block) => block.startsWith(`worktree ${realpathSync(secondPath)}\n`));
  assert.match(secondBlock ?? '', /^locked /m);

  const sessions = registry.sessions.list(project.id);
  assert.equal(sessions.length, 1);
  assert.ok(sessions[0]?.endedAt);
  registry.close();
});

test('run warns on a home mismatch without flags and honours --confirm-move and --rehome', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const rootRow = registry.worktrees.list(project.id)[0];
  assert.ok(rootRow);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-home', 'Dev Home');
  const otherHome = newId();
  writePersona(project.storeDir, persona, {
    role: 'dev-home', name: 'Dev Home', home_worktree_id: otherHome,
    state: 'idle', vendor: null, last_vendor_session_id: null,
  });
  const vendor = stubVendor(dir);
  const runEnv = { ...env, ARTINAREY_TEST_VENDOR: vendor.command };

  const refused = await captureMain(['run', 'opencode', '--persona', persona], runEnv, repo);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /another worktree|confirm_move|confirm-move/i);
  assert.equal(existsSync(vendor.out), false);
  assert.equal(registry.bindings.forWorktree(rootRow.id), undefined);
  assert.equal(registry.sessions.list(project.id).length, 0);

  const confirmed = await captureMain(
    ['run', 'opencode', '--persona', persona, '--confirm-move'], runEnv, repo,
  );
  assert.equal(confirmed.code, 0, `${confirmed.err}${confirmed.out}`);
  assert.equal(readFileSync(vendor.out, 'utf8').trim(), realpathSync(repo));
  assert.equal(readPersona(project.storeDir, persona).home_worktree_id, otherHome);
  assert.equal(registry.bindings.forWorktree(rootRow.id), undefined);
  assert.equal(registry.sessions.list(project.id).length, 1);

  const rehomed = await captureMain(
    ['run', 'opencode', '--persona', persona, '--rehome'], runEnv, repo,
  );
  assert.equal(rehomed.code, 0, `${rehomed.err}${rehomed.out}`);
  assert.equal(readPersona(project.storeDir, persona).home_worktree_id, rootRow.id);
  assert.equal(registry.bindings.forWorktree(rootRow.id), undefined);
  assert.equal(registry.sessions.list(project.id).length, 2);
  registry.close();
});

test('run rejects unknown vendors, a missing --persona and unmanaged worktrees', async () => {
  const dir = root();
  const { repo, env, registry, project } = seededRepo(dir);
  const vendor = stubVendor(dir);

  const unknown = await captureMain(['run', 'mystery', '--persona', 'anyone'], env, repo);
  assert.equal(unknown.code, 2, unknown.out);
  assert.match(unknown.err, /unknown vendor/);
  assert.equal(existsSync(vendor.out), false);

  const missing = await captureMain(
    ['run', 'opencode'], { ...env, ARTINAREY_TEST_VENDOR: vendor.command }, repo,
  );
  assert.equal(missing.code, 2, missing.out);
  assert.match(missing.err, /--persona/);
  assert.equal(existsSync(vendor.out), false);

  const loose = join(dir, 'loose-wt');
  mkdirSync(loose, { recursive: true });
  const looseId = newId();
  registry.worktrees.upsert({ id: looseId, projectId: project.id, path: loose, branch: null });
  writeMarker(loose, project.id, looseId);
  const persona = createPersona(registry, project.storeDir, project.id, 'dev-loose', 'Loose');
  const unmanaged = await captureMain(
    ['run', 'opencode', '--persona', persona],
    { ...env, ARTINAREY_TEST_VENDOR: vendor.command }, loose,
  );
  assert.equal(unmanaged.code, 1, unmanaged.out);
  assert.match(unmanaged.err, /WORKTREE_UNMANAGED/);
  assert.equal(existsSync(vendor.out), false);
  assert.equal(registry.bindings.forWorktree(looseId), undefined);
  assert.equal(registry.sessions.list(project.id).length, 0);
  registry.close();
});
