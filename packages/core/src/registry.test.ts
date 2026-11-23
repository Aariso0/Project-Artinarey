import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ArtinareyError } from './errors.ts';
import { isUlid, newId } from './ids.ts';
import { openRegistry } from './registry.ts';

function openTempRegistry() {
  const file = join(tmpdir(), `artinarey-registry-${newId()}.sqlite`);
  return openRegistry(file);
}

/** Writes a database with the worktrees schema as it was before port offsets. */
function createLegacyRegistry(file: string) {
  const projectId = newId();
  const worktreeId = newId();
  const db = new Database(file);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_common_dir TEXT NOT NULL,
      store_dir TEXT NOT NULL, created_at TEXT NOT NULL, schema_version INTEGER NOT NULL
    );
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      path TEXT NOT NULL,
      branch TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, path)
    );
  `);
  db.prepare(`INSERT INTO projects (id, name, repo_common_dir, store_dir, created_at, schema_version)
              VALUES (?, ?, ?, ?, ?, 1)`)
    .run(projectId, 'Legacy', '/legacy/.git', '/legacy/store', '2026-11-01T00:00:00Z');
  db.prepare(`INSERT INTO worktrees (id, project_id, path, branch, created_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(worktreeId, projectId, '/legacy/wt', 'main', '2026-11-01T00:00:00Z');
  db.close();
  return { projectId, worktreeId };
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

test('worktrees: legacy databases gain port_offset and existing rows read 0', () => {
  const file = join(tmpdir(), `artinarey-registry-${newId()}.sqlite`);
  const { projectId, worktreeId } = createLegacyRegistry(file);

  const db = openRegistry(file);
  assert.deepEqual(db.worktrees.list(projectId), [{
    id: worktreeId, projectId, path: '/legacy/wt', branch: 'main',
    createdAt: '2026-11-01T00:00:00Z', portOffset: 0,
  }]);
  db.close();

  // Reopening a migrated database is a no-op.
  const reopened = openRegistry(file);
  assert.equal(reopened.worktrees.list(projectId)[0]?.portOffset, 0);
  reopened.close();

  const raw = new Database(file, { readonly: true });
  const columns = raw.pragma('table_info(worktrees)') as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null;
  }>;
  const column = columns.find((c) => c.name === 'port_offset');
  assert.ok(column, 'port_offset column exists');
  assert.equal(column.type, 'INTEGER');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, '0');
  raw.close();
});

test('worktrees: portOffset defaults to 0 and round-trips through upsert', () => {
  const db = openTempRegistry();
  const project = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const id = newId();
  db.worktrees.upsert({ id, projectId: project.id, path: '/w/a', branch: 'main' });
  assert.equal(db.worktrees.list(project.id)[0]?.portOffset, 0);

  db.worktrees.upsert({ id, projectId: project.id, path: '/w/a', branch: 'main', portOffset: 30 });
  assert.equal(db.worktrees.list(project.id)[0]?.portOffset, 30);
  db.close();
});

test('worktrees: delete removes only the requested row', () => {
  const db = openTempRegistry();
  const project = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const a = newId();
  const b = newId();
  db.worktrees.upsert({ id: a, projectId: project.id, path: '/w/a', branch: 'a' });
  db.worktrees.upsert({ id: b, projectId: project.id, path: '/w/b', branch: 'b' });

  db.worktrees.delete(a);
  assert.deepEqual(db.worktrees.list(project.id).map((wt) => wt.id), [b]);
  db.close();
});
