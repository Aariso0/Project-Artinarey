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

/** Writes a database whose sessions table predates the created_binding column. */
function createLegacySessionsRegistry(file: string) {
  const projectId = newId();
  const personaId = newId();
  const worktreeId = newId();
  const db = new Database(file);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_common_dir TEXT NOT NULL,
      store_dir TEXT NOT NULL, created_at TEXT NOT NULL, schema_version INTEGER NOT NULL
    );
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      path TEXT NOT NULL, branch TEXT, created_at TEXT NOT NULL,
      port_offset INTEGER NOT NULL DEFAULT 0, UNIQUE(project_id, path)
    );
    CREATE TABLE personas (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      role TEXT NOT NULL, name TEXT NOT NULL, vendor TEXT, last_vendor_session_id TEXT,
      UNIQUE(project_id, role)
    );
    CREATE TABLE bindings (
      persona_id TEXT PRIMARY KEY REFERENCES personas(id),
      worktree_id TEXT NOT NULL UNIQUE REFERENCES worktrees(id), bound_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      worktree_id TEXT NOT NULL REFERENCES worktrees(id),
      persona_id TEXT NOT NULL REFERENCES personas(id),
      vendor TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE TABLE moves (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
      from_root TEXT NOT NULL, to_root TEXT NOT NULL, moved_at TEXT NOT NULL
    );
  `);
  const now = '2026-11-24T10:00:00Z';
  db.prepare(`INSERT INTO projects (id, name, repo_common_dir, store_dir, created_at, schema_version)
              VALUES (?, ?, ?, ?, ?, 1)`)
    .run(projectId, 'Legacy sessions', '/legacy/.git', '/legacy/store', now);
  db.prepare(`INSERT INTO worktrees (id, project_id, path, branch, created_at, port_offset)
              VALUES (?, ?, ?, ?, ?, 0)`)
    .run(worktreeId, projectId, '/legacy/wt', 'main', now);
  db.prepare(`INSERT INTO personas (id, project_id, role, name, vendor, last_vendor_session_id)
              VALUES (?, ?, ?, ?, NULL, NULL)`)
    .run(personaId, projectId, 'dev-legacy', 'Legacy');
  db.prepare(`INSERT INTO sessions (id, project_id, worktree_id, persona_id, vendor, started_at, ended_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(newId(), projectId, worktreeId, personaId, 'opencode', now, now);
  db.close();
  return { projectId, personaId, worktreeId };
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

test('sessions: append returns its id and end stamps only that session', () => {
  const db = openTempRegistry();
  const project = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const persona = db.personas.create({ projectId: project.id, role: 'dev-a', name: 'A' });
  const wt = newId();
  db.worktrees.upsert({ id: wt, projectId: project.id, path: '/w/a', branch: null });

  const first = db.sessions.append({
    projectId: project.id, worktreeId: wt, personaId: persona.id,
    vendor: 'opencode', startedAt: '2026-11-24T10:00:00Z',
  });
  const second = db.sessions.append({
    projectId: project.id, worktreeId: wt, personaId: persona.id,
    vendor: 'opencode', startedAt: '2026-11-24T11:00:00Z',
  });
  assert.equal(isUlid(first), true);
  assert.equal(isUlid(second), true);
  assert.notEqual(first, second);
  assert.equal(db.sessions.list(project.id).find((s) => s.id === first)?.endedAt, null);

  db.sessions.end(first, '2026-11-24T10:30:00Z');
  const rows = db.sessions.list(project.id);
  assert.equal(rows.find((s) => s.id === first)?.endedAt, '2026-11-24T10:30:00Z');
  assert.equal(rows.find((s) => s.id === second)?.endedAt, null);

  // An unknown id is a no-op; the store is data, never a source of authority.
  db.sessions.end('missing', '2026-11-24T12:00:00Z');
  assert.deepEqual(db.sessions.list(project.id), rows);
  db.close();
});

test('sessions: createdBinding defaults to false and round-trips through append', () => {
  const db = openTempRegistry();
  const project = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const persona = db.personas.create({ projectId: project.id, role: 'dev-a', name: 'A' });
  const wt = newId();
  db.worktrees.upsert({ id: wt, projectId: project.id, path: '/w/a', branch: null });

  const without = db.sessions.append({
    projectId: project.id, worktreeId: wt, personaId: persona.id,
    vendor: 'opencode', startedAt: '2026-11-24T10:00:00Z',
  });
  const withFlag = db.sessions.append({
    projectId: project.id, worktreeId: wt, personaId: persona.id,
    vendor: 'opencode', startedAt: '2026-11-24T11:00:00Z', createdBinding: true,
  });
  const rows = db.sessions.list(project.id);
  assert.equal(rows.find((s) => s.id === without)?.createdBinding, false);
  assert.equal(rows.find((s) => s.id === withFlag)?.createdBinding, true);
  db.close();
});

test('sessions: legacy databases gain created_binding and old rows read false', () => {
  const file = join(tmpdir(), `artinarey-registry-${newId()}.sqlite`);
  const { projectId, personaId, worktreeId } = createLegacySessionsRegistry(file);

  const db = openRegistry(file);
  assert.equal(db.sessions.list(projectId)[0]?.createdBinding, false);
  const added = db.sessions.append({
    projectId, worktreeId, personaId, vendor: 'opencode',
    startedAt: '2026-11-24T12:00:00Z', createdBinding: true,
  });
  assert.equal(db.sessions.list(projectId).find((s) => s.id === added)?.createdBinding, true);
  db.close();

  const reopened = openRegistry(file);
  assert.equal(reopened.sessions.list(projectId).find((s) => s.id === added)?.createdBinding, true);
  reopened.close();

  const raw = new Database(file, { readonly: true });
  const columns = raw.pragma('table_info(sessions)') as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null;
  }>;
  const column = columns.find((c) => c.name === 'created_binding');
  assert.ok(column, 'created_binding column exists');
  assert.equal(column.type, 'INTEGER');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, '0');
  raw.close();
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

  // An upsert without an offset keeps the stored one; an explicit 0 still clears it.
  db.worktrees.upsert({ id, projectId: project.id, path: '/w/a', branch: 'main' });
  assert.equal(db.worktrees.list(project.id)[0]?.portOffset, 30);
  db.worktrees.upsert({ id, projectId: project.id, path: '/w/a', branch: 'main', portOffset: 0 });
  assert.equal(db.worktrees.list(project.id)[0]?.portOffset, 0);
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

test('sessions: deleteForWorktree removes only that worktree\'s session history', () => {
  const db = openTempRegistry();
  const project = db.projects.create({ name: 'Alpha', repoCommonDir: '/r/a/.git', storeDir: '/d/a' });
  const persona = db.personas.create({ projectId: project.id, role: 'dev-a', name: 'A' });
  const kept = newId();
  const removed = newId();
  db.worktrees.upsert({ id: kept, projectId: project.id, path: '/w/kept', branch: 'kept' });
  db.worktrees.upsert({ id: removed, projectId: project.id, path: '/w/removed', branch: 'removed' });

  for (const [worktreeId, minute] of [[removed, '01'], [removed, '02'], [kept, '03']] as const) {
    db.sessions.append({
      projectId: project.id, worktreeId, personaId: persona.id,
      vendor: 'opencode', startedAt: `2026-11-24T10:${minute}:00Z`,
    });
  }

  db.sessions.deleteForWorktree(removed);

  assert.deepEqual(db.sessions.list(project.id).map((s) => s.worktreeId), [kept]);
  assert.deepEqual(db.worktrees.list(project.id).map((wt) => wt.id), [kept, removed]);
  db.close();
});
