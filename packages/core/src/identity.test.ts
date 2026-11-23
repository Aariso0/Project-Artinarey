import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from './ids.ts';
import { openRegistry } from './registry.ts';
import { readPersona, writePersona } from './persona-store.ts';
import {
  claimPersona,
  createPersona,
  findMarker,
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
  const home = resolveIdentity(s.registry, join(s.root, 'wt1'));
  assert.equal(home.ok, true);
  if (!home.ok) return;
  assert.equal(claimPersona(s.registry, s.storeDir, home.identity, { personaId: senior }).ok, true);
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
