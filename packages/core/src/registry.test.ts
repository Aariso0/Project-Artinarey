import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtinareyError } from './errors.ts';
import { isUlid, newId } from './ids.ts';
import { openRegistry } from './registry.ts';

function openTempRegistry() {
  const file = join(tmpdir(), `artinarey-registry-${newId()}.sqlite`);
  return openRegistry(file);
}

test('projects: create assigns an id, get and list round-trip', () => {
  const db = openTempRegistry();
  const a = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const b = db.projects.create({ name: 'Beta', repoCommonDir: '/r/b/.git', storeDir: '/d/b' });

  assert.equal(isUlid(a.id), true);
  assert.equal(a.schemaVersion, 1);
  assert.deepEqual(db.projects.get(a.id), a);
  assert.equal(db.projects.get('missing'), undefined);
  assert.deepEqual(db.projects.list().map((p) => p.id), [a.id, b.id]);
  db.close();
});

test('personas and worktrees: create/get/list round-trip', () => {
  const db = openTempRegistry();
  const project = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const dev = db.personas.create({ projectId: project.id, role: 'dev-auth', name: 'Auth dev', vendor: 'opencode' });
  const senior = db.personas.create({ projectId: project.id, role: 'senior-dev', name: 'Lead' });
  const wtId = newId();
  db.worktrees.upsert({ id: wtId, projectId: project.id, path: '/w/auth', branch: 'artinarey/auth' });

  assert.equal(db.personas.get(dev.id)?.name, 'Auth dev');
  assert.deepEqual(db.personas.list(project.id).map((p) => p.id), [dev.id, senior.id]);
  assert.equal(db.worktrees.list(project.id)[0]?.path, '/w/auth');
  assert.equal(db.worktrees.list(project.id)[0]?.branch, 'artinarey/auth');

  // upsert is idempotent
  db.worktrees.upsert({ id: wtId, projectId: project.id, path: '/w/auth', branch: 'artinarey/auth-v2' });
  assert.equal(db.worktrees.list(project.id).length, 1);
  assert.equal(db.worktrees.list(project.id)[0]?.branch, 'artinarey/auth-v2');
  db.close();
});

test('bindings: bind, resolve by worktree, reject conflicts, and release', () => {
  const db = openTempRegistry();
  const project = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const a = db.personas.create({ projectId: project.id, role: 'dev-auth', name: 'A' });
  const b = db.personas.create({ projectId: project.id, role: 'dev-ui', name: 'B' });
  const wt = newId();
  db.worktrees.upsert({ id: wt, projectId: project.id, path: '/w/auth', branch: null });

  assert.equal(db.bindings.forWorktree(wt), undefined);
  db.bindings.bind(a.id, wt);
  assert.equal(db.bindings.forWorktree(wt)?.id, a.id);

  assert.throws(
    () => db.bindings.bind(b.id, wt),
    (err: unknown) => err instanceof ArtinareyError && err.code === 'INVALID_INPUT',
  );

  db.bindings.release(a.id);
  assert.equal(db.bindings.forWorktree(wt), undefined);
  db.bindings.bind(b.id, wt);
  assert.equal(db.bindings.forWorktree(wt)?.id, b.id);
  db.close();
});

test('sessions and moves append and list in insertion order', () => {
  const db = openTempRegistry();
  const project = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const persona = db.personas.create({ projectId: project.id, role: 'dev-auth', name: 'A' });
  const wt = newId();
  db.worktrees.upsert({ id: wt, projectId: project.id, path: '/w/auth', branch: null });

  for (const n of [1, 2, 3]) {
    db.sessions.append({
      projectId: project.id,
      worktreeId: wt,
      personaId: persona.id,
      vendor: 'opencode',
      startedAt: `2026-11-23T10:0${n}:00Z`,
    });
  }
  db.moves.append({ projectId: project.id, fromRoot: '/d/a', toRoot: '/mnt/big/a', movedAt: '2026-11-23T11:00:00Z' });
  db.moves.append({ projectId: project.id, fromRoot: '/mnt/big/a', toRoot: '/d/a', movedAt: '2026-11-23T12:00:00Z' });

  assert.deepEqual(
    db.sessions.list(project.id).map((s) => s.startedAt),
    ['2026-11-23T10:01:00Z', '2026-11-23T10:02:00Z', '2026-11-23T10:03:00Z'],
  );
  assert.deepEqual(
    db.moves.list(project.id).map((m) => m.toRoot),
    ['/mnt/big/a', '/d/a'],
  );
  db.close();
});

test('foreign keys are enforced', () => {
  const db = openTempRegistry();
  assert.throws(
    () => db.personas.create({ projectId: 'missing', role: 'x', name: 'X' }),
    (err: unknown) => err instanceof Error,
  );
  db.close();
});

test('registry data survives close and reopen', () => {
  const file = join(tmpdir(), `artinarey-registry-${newId()}.sqlite`);
  const first = openRegistry(file);
  const project = first.projects.create({ name: 'Persistent', repoCommonDir: '/r/p/.git', storeDir: '/d/p' });
  first.close();

  const second = openRegistry(file);
  assert.equal(second.projects.get(project.id)?.name, 'Persistent');
  second.close();
});
