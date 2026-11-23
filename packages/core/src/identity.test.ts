import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from './ids.ts';
import { openRegistry } from './registry.ts';
import { readPersona, writePersona } from './persona-store.ts';
import { listGitWorktrees } from './worktree.ts';
import {
  claimPersona,
  createPersona,
  findMarker,
  rehomePersona,
  releasePersona,
  releaseWorktreeForce,
  resolveIdentity,
  roster,
  writeMarker,
} from './identity.ts';

function tempRoot(): string {
  const dir = join(tmpdir(), `artinarey-marker-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('writeMarker writes an ids-only marker with exact JSON shape', () => {
  const dir = tempRoot();
  writeMarker(dir, '01PROJECT', '01WORKTREE');

  assert.equal(
    readFileSync(join(dir, '.artinarey.json'), 'utf8'),
    '{"schema":1,"project_id":"01PROJECT","worktree_id":"01WORKTREE"}',
  );
});

test('findMarker walks up from a nested directory', () => {
  const root = tempRoot();
  writeMarker(root, '01PROJECT', '01WORKTREE');
  const nested = join(root, 'src', 'deep');
  mkdirSync(nested, { recursive: true });

  const found = findMarker(nested);
  assert.equal(found?.dir, root);
  assert.deepEqual(found?.marker, { schema: 1, project_id: '01PROJECT', worktree_id: '01WORKTREE' });
});

test('findMarker returns undefined when no valid marker exists', () => {
  const root = tempRoot();
  assert.equal(findMarker(root), undefined);

  writeFileSync(join(root, '.artinarey.json'), 'not json');
  assert.equal(findMarker(root), undefined);
});

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function registryProject(registry: ReturnType<typeof openRegistry>, root: string) {
  return registry.projects.create({
    name: 'Other', repoCommonDir: join(root, 'other.git'), storeDir: join(root, 'other-store'),
  });
}

function auditEvents(storeDir: string, type: string): Array<Record<string, unknown>> {
  const file = join(storeDir, 'events', 'audit.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.type === type);
}

function setup() {
  const root = tempRoot();
  const storeDir = join(root, 'store');
  mkdirSync(storeDir, { recursive: true });
  const registry = openRegistry(join(root, 'registry.sqlite'));
  const project = registry.projects.create({ name: 'T', repoCommonDir: '/r/.git', storeDir });
  const wt1 = newId();
  const wt2 = newId();
  for (const [id, path] of [[wt1, join(root, 'wt1')], [wt2, join(root, 'wt2')]] as const) {
    mkdirSync(path, { recursive: true });
    registry.worktrees.upsert({ id, projectId: project.id, path, branch: null });
    writeMarker(path, project.id, id);
  }
  return { root, storeDir, registry, project, wt1, wt2 };
}

/** Real git worktrees so lock/unlock and branch comparisons are observable. */
function gitRegistrySetup() {
  const root = tempRoot();
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'init'], repo);
  const storeDir = join(root, 'store');
  mkdirSync(storeDir, { recursive: true });
  const registry = openRegistry(join(root, 'registry.sqlite'));
  const project = registry.projects.create({
    name: 'Git', repoCommonDir: join(repo, '.git'), storeDir,
  });

  function add(name: string, parent: string = root) {
    const path = join(parent, name);
    const branch = `artinarey/${name}`;
    git(['worktree', 'add', '-q', '-b', branch, path], repo);
    const id = newId();
    registry.worktrees.upsert({ id, projectId: project.id, path, branch });
    writeMarker(path, project.id, id);
    return { id, path, branch };
  }

  return { root, repo, storeDir, registry, project, add };
}

function isLocked(repo: string, path: string): boolean {
  return listGitWorktrees(repo).find((wt) => wt.path === path)?.locked === true;
}

test('resolveIdentity maps a marked directory to its project and worktree', () => {
  const s = setup();
  const result = resolveIdentity(s.registry, join(s.root, 'wt1'));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.identity.projectId, s.project.id);
    assert.equal(result.identity.worktreeId, s.wt1);
    assert.equal(result.identity.personaId, undefined);
  }
  s.registry.close();
});

test('resolveIdentity reports NO_PROJECT and WORKTREE_UNMANAGED', () => {
  const s = setup();
  const none = resolveIdentity(s.registry, s.root);
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.code, 'NO_PROJECT');

  const bogus = join(s.root, 'bogus');
  mkdirSync(bogus);
  writeMarker(bogus, s.project.id, newId());
  const unmanaged = resolveIdentity(s.registry, bogus);
  assert.equal(unmanaged.ok, false);
  if (!unmanaged.ok) assert.equal(unmanaged.code, 'WORKTREE_UNMANAGED');
  s.registry.close();
});

test('resolveIdentity pauses when the git worktree branch changed, auditing one mismatch', () => {
  const root = tempRoot();
  const repo = join(root, 'repo');
  const worktree = join(root, 'branch-changed');
  mkdirSync(repo, { recursive: true });
  git(['init', '-q'], repo);
  git(['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com',
    'commit', '--allow-empty', '-q', '-m', 'init'], repo);
  git(['worktree', 'add', '-q', '-b', 'feature/new', worktree], repo);

  const registry = openRegistry(join(root, 'registry.sqlite'));
  try {
    const project = registry.projects.create({
      name: 'Git', repoCommonDir: join(repo, '.git'), storeDir: join(root, 'store'),
    });
    const id = newId();
    registry.worktrees.upsert({ id, projectId: project.id, path: worktree,
      branch: 'registered-branch' });
    writeMarker(worktree, project.id, id);

    const result = resolveIdentity(registry, worktree);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'WORKTREE_UNMANAGED');
      assert.match(result.message, /branch changed; confirm the move/);
      assert.match(result.message, /feature\/new/);
    }

    const events = readFileSync(join(project.storeDir, 'events', 'audit.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    const mismatches = events.filter((event) => event.type === 'worktree_unmanaged');
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0]?.git_branch, 'feature/new');
    assert.match(String(mismatches[0]?.message), /branch changed/);
  } finally {
    registry.close();
  }
});

test('roster reports every persona with state, home worktree, and last task', () => {
  const s = setup();
  const a = createPersona(s.registry, s.storeDir, s.project.id, 'dev-auth', 'Auth dev');
  const b = createPersona(s.registry, s.storeDir, s.project.id, 'senior-dev', 'Lead');
  writePersona(s.storeDir, a, {
    role: 'dev-auth', name: 'Auth dev', home_worktree_id: s.wt1,
    state: 'active', vendor: null, last_vendor_session_id: null,
  });
  writeFileSync(join(s.storeDir, 'personas', b, 'status.md'), 'Finished the auth review.');

  const entries = roster(s.registry, s.storeDir, s.project.id);
  assert.deepEqual(entries.map((e) => e.personaId), [a, b]);
  assert.equal(entries[0]?.homeWorktreeId, s.wt1);
  assert.equal(entries[0]?.state, 'active');
  assert.match(entries[1]?.lastTask ?? '', /auth review/);
  s.registry.close();
});

test('claim binds a persona, and a second persona in the same directory is DIRECTORY_BUSY', () => {
  const s = setup();
  const a = createPersona(s.registry, s.storeDir, s.project.id, 'dev-auth', 'A');
  const b = createPersona(s.registry, s.storeDir, s.project.id, 'dev-ui', 'B');
  const identity = resolveIdentity(s.registry, join(s.root, 'wt1'));
  assert.equal(identity.ok, true);
  if (!identity.ok) return;

  const first = claimPersona(s.registry, s.storeDir, identity.identity, { personaId: a });
  assert.equal(first.ok, true);
  assert.equal(readPersona(s.storeDir, a).home_worktree_id, s.wt1, 'first bind sets the home worktree');
  assert.equal(readPersona(s.storeDir, a).state, 'active');

  const second = claimPersona(s.registry, s.storeDir, identity.identity, { personaId: b });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, 'DIRECTORY_BUSY');
  s.registry.close();
});

test('a home-worktree mismatch needs confirmation or rehome; senior dev is exempt', () => {
  const s = setup();
  const dev = createPersona(s.registry, s.storeDir, s.project.id, 'dev-auth', 'Dev');
  writePersona(s.storeDir, dev, {
    role: 'dev-auth', name: 'Dev', home_worktree_id: s.wt1,
    state: 'idle', vendor: null, last_vendor_session_id: null,
  });
  const other = resolveIdentity(s.registry, join(s.root, 'wt2'));
  assert.equal(other.ok, true);
  if (!other.ok) return;

  const mismatch = claimPersona(s.registry, s.storeDir, other.identity, { personaId: dev });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, 'NEEDS_CONFIRMATION');

  const confirmed = claimPersona(s.registry, s.storeDir, other.identity, {
    personaId: dev, confirmMove: true,
  });
  assert.equal(confirmed.ok, true);
  releasePersona(s.registry, s.storeDir, dev);

  const rehomed = claimPersona(s.registry, s.storeDir, other.identity, {
    personaId: dev, rehome: true,
  });
  assert.equal(rehomed.ok, true);
  assert.equal(readPersona(s.storeDir, dev).home_worktree_id, s.wt2);

  const senior = createPersona(s.registry, s.storeDir, s.project.id, 'senior-dev', 'Lead');
  // A real home elsewhere in a free worktree: the exemption is the only reason
  // this claim can succeed.
  writePersona(s.storeDir, senior, {
    role: 'senior-dev', name: 'Lead', home_worktree_id: s.wt2,
    state: 'idle', vendor: null, last_vendor_session_id: null,
  });
  const home = resolveIdentity(s.registry, join(s.root, 'wt1'));
  assert.equal(home.ok, true);
  if (!home.ok) return;
  assert.equal(claimPersona(s.registry, s.storeDir, home.identity, { personaId: senior }).ok, true);
  assert.equal(readPersona(s.storeDir, senior).home_worktree_id, s.wt2);
  s.registry.close();
});

test('release and force release free the binding and mark the persona idle', () => {
  const s = setup();
  const a = createPersona(s.registry, s.storeDir, s.project.id, 'dev-auth', 'A');
  const identity = resolveIdentity(s.registry, join(s.root, 'wt1'));
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  assert.equal(claimPersona(s.registry, s.storeDir, identity.identity, { personaId: a }).ok, true);

  releasePersona(s.registry, s.storeDir, a);
  assert.equal(s.registry.bindings.forWorktree(s.wt1), undefined);
  assert.equal(readPersona(s.storeDir, a).state, 'idle');

  assert.equal(claimPersona(s.registry, s.storeDir, identity.identity, { personaId: a }).ok, true);
  assert.equal(releaseWorktreeForce(s.registry, s.storeDir, s.wt1), true);
  assert.equal(releaseWorktreeForce(s.registry, s.storeDir, s.wt1), false);
  assert.equal(s.registry.bindings.forWorktree(s.wt1), undefined);
  s.registry.close();
});

test('rehomePersona writes the new home worktree and one persona_rehome audit line', () => {
  const s = setup();
  const dev = createPersona(s.registry, s.storeDir, s.project.id, 'dev-auth', 'Dev');

  assert.deepEqual(rehomePersona(s.registry, s.storeDir, dev, s.wt2), { ok: true });
  assert.equal(readPersona(s.storeDir, dev).home_worktree_id, s.wt2);

  const events = auditEvents(s.storeDir, 'persona_rehome');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.persona_id, dev);
  assert.equal(events[0]?.worktree_id, s.wt2);
  assert.equal(events[0]?.previous_home_worktree_id, null);
  s.registry.close();
});

test('rehomePersona refuses cross-project and unknown ids without a successful audit', () => {
  const s = setup();
  const dev = createPersona(s.registry, s.storeDir, s.project.id, 'dev-auth', 'Dev');
  writePersona(s.storeDir, dev, {
    role: 'dev-auth', name: 'Dev', home_worktree_id: s.wt1,
    state: 'idle', vendor: null, last_vendor_session_id: null,
  });
  const otherProject = registryProject(s.registry, s.root);
  const foreignWt = newId();
  s.registry.worktrees.upsert({ id: foreignWt, projectId: otherProject.id,
    path: join(s.root, 'foreign'), branch: null });

  const cross = rehomePersona(s.registry, s.storeDir, dev, foreignWt);
  assert.equal(cross.ok, false);
  if (!cross.ok) {
    assert.equal(cross.code, 'INVALID_INPUT');
    assert.match(cross.message, /different project/i);
  }
  assert.equal(readPersona(s.storeDir, dev).home_worktree_id, s.wt1);
  assert.equal(auditEvents(s.storeDir, 'persona_rehome').length, 0);

  for (const [personaId, worktreeId, code] of [
    [newId(), s.wt2, 'NOT_FOUND'],
    [dev, newId(), 'NOT_FOUND'],
    ['', s.wt2, 'INVALID_INPUT'],
    [dev, '', 'INVALID_INPUT'],
  ] as const) {
    const result = rehomePersona(s.registry, s.storeDir, personaId, worktreeId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, code);
  }
  assert.equal(readPersona(s.storeDir, dev).home_worktree_id, s.wt1);
  assert.equal(auditEvents(s.storeDir, 'persona_rehome').length, 0);
  s.registry.close();
});

test('resolveIdentity matches a nested worktree by canonical directory, not by prefix', () => {
  const s = gitRegistrySetup();
  try {
    const nested = s.add('nested', join(s.repo, '.worktrees'));
    const mainId = newId();
    s.registry.worktrees.upsert({
      id: mainId, projectId: s.project.id, path: s.repo,
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], s.repo),
    });
    writeMarker(s.repo, s.project.id, mainId);
    // The registered branch is stale for the nested worktree only.
    s.registry.worktrees.upsert({
      id: nested.id, projectId: s.project.id, path: nested.path, branch: 'stale/nested',
    });

    const result = resolveIdentity(s.registry, nested.path);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, 'WORKTREE_UNMANAGED');
      assert.match(result.message, /feature\/nested|artinarey\/nested/);
      assert.equal(result.message.includes('stale/nested'), true);
      assert.equal(result.message.includes('registered: stale/nested'), true);
    }
    const events = auditEvents(s.storeDir, 'worktree_unmanaged');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.git_branch, nested.branch);
  } finally {
    s.registry.close();
  }
});

test('claimPersona unlocks the previous worktree after a confirmed move', () => {
  const s = gitRegistrySetup();
  try {
    const x = s.add('x');
    const y = s.add('y');
    const persona = createPersona(s.registry, s.storeDir, s.project.id, 'dev-mover', 'Mover');
    const fromIdentity = resolveIdentity(s.registry, x.path);
    const toIdentity = resolveIdentity(s.registry, y.path);
    assert.equal(fromIdentity.ok, true);
    assert.equal(toIdentity.ok, true);
    if (!fromIdentity.ok || !toIdentity.ok) return;

    assert.equal(claimPersona(s.registry, s.storeDir, fromIdentity.identity, { personaId: persona }).ok, true);
    assert.equal(isLocked(s.repo, x.path), true);

    const moved = claimPersona(s.registry, s.storeDir, toIdentity.identity, {
      personaId: persona, confirmMove: true,
    });
    assert.equal(moved.ok, true);
    assert.equal(isLocked(s.repo, x.path), false, 'old worktree is unlocked after the move');
    assert.equal(isLocked(s.repo, y.path), true);

    // A claim on the same worktree must not unlock the new lock.
    assert.equal(claimPersona(s.registry, s.storeDir, toIdentity.identity, {
      personaId: persona, confirmMove: true,
    }).ok, true);
    assert.equal(isLocked(s.repo, y.path), true);
  } finally {
    s.registry.close();
  }
});

test('release and force release unlock even when the audit append fails', () => {
  const s = gitRegistrySetup();
  try {
    const x = s.add('x');
    const y = s.add('y');
    const persona = createPersona(s.registry, s.storeDir, s.project.id, 'dev-release', 'Release');
    const other = createPersona(s.registry, s.storeDir, s.project.id, 'dev-force', 'Force');
    const xIdentity = resolveIdentity(s.registry, x.path);
    const yIdentity = resolveIdentity(s.registry, y.path);
    assert.equal(xIdentity.ok, true);
    assert.equal(yIdentity.ok, true);
    if (!xIdentity.ok || !yIdentity.ok) return;
    assert.equal(claimPersona(s.registry, s.storeDir, xIdentity.identity, { personaId: persona }).ok, true);
    assert.equal(claimPersona(s.registry, s.storeDir, yIdentity.identity, { personaId: other }).ok, true);

    // Making the audit destination a directory makes appendJournal fail.
    rmSync(join(s.storeDir, 'events', 'audit.jsonl'), { force: true });
    mkdirSync(join(s.storeDir, 'events', 'audit.jsonl'), { recursive: true });
    assert.throws(() => releasePersona(s.registry, s.storeDir, persona));
    assert.equal(s.registry.bindings.forWorktree(x.id), undefined);
    assert.equal(isLocked(s.repo, x.path), false);
    assert.equal(isLocked(s.repo, y.path), true);

    assert.throws(() => releaseWorktreeForce(s.registry, s.storeDir, y.id));
    assert.equal(s.registry.bindings.forWorktree(y.id), undefined);
    assert.equal(isLocked(s.repo, y.path), false);
  } finally {
    s.registry.close();
  }
});

test('resolveIdentity returns WORKTREE_UNMANAGED when the diagnostic audit fails', () => {
  const s = setup();
  const bogus = join(s.root, 'bogus');
  mkdirSync(bogus);
  // A known worktree at the wrong path keeps storeDir defined, so the diagnostic
  // audit is attempted in the project store.
  writeMarker(bogus, s.project.id, s.wt1);
  mkdirSync(join(s.storeDir, 'events', 'audit.jsonl'), { recursive: true });

  const result = resolveIdentity(s.registry, bogus);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'WORKTREE_UNMANAGED');
  s.registry.close();
});

test('claimPersona refuses a busy directory before creating a new persona', () => {
  const s = setup();
  const a = createPersona(s.registry, s.storeDir, s.project.id, 'dev-a', 'A');
  const identity = resolveIdentity(s.registry, join(s.root, 'wt1'));
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  assert.equal(claimPersona(s.registry, s.storeDir, identity.identity, { personaId: a }).ok, true);

  const refused = claimPersona(s.registry, s.storeDir, identity.identity, {
    newRole: 'dev-orphan', name: 'Orphan',
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, 'DIRECTORY_BUSY');
  assert.deepEqual(s.registry.personas.list(s.project.id).map((p) => p.role), ['dev-a']);

  // A persona claiming its own binding is still allowed.
  assert.equal(claimPersona(s.registry, s.storeDir, identity.identity, { personaId: a }).ok, true);
  s.registry.close();
});

test('rehomePersona clears the home mismatch that would otherwise need confirmation', () => {
  const s = setup();
  const dev = createPersona(s.registry, s.storeDir, s.project.id, 'dev-auth', 'Dev');
  writePersona(s.storeDir, dev, {
    role: 'dev-auth', name: 'Dev', home_worktree_id: s.wt1,
    state: 'idle', vendor: null, last_vendor_session_id: null,
  });
  const other = resolveIdentity(s.registry, join(s.root, 'wt2'));
  assert.equal(other.ok, true);
  if (!other.ok) return;

  const mismatch = claimPersona(s.registry, s.storeDir, other.identity, { personaId: dev });
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.equal(mismatch.code, 'NEEDS_CONFIRMATION');

  assert.deepEqual(rehomePersona(s.registry, s.storeDir, dev, s.wt2), { ok: true });
  assert.equal(claimPersona(s.registry, s.storeDir, other.identity, { personaId: dev }).ok, true);
  s.registry.close();
});
