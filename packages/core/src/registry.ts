import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { ArtinareyError } from './errors.ts';
import { newId } from './ids.ts';

export type Project = {
  id: string;
  name: string;
  repoCommonDir: string;
  storeDir: string;
  createdAt: string;
  schemaVersion: number;
};

export type Worktree = {
  id: string;
  projectId: string;
  path: string;
  branch: string | null;
  createdAt: string;
  portOffset: number;
};

export type Persona = {
  id: string;
  projectId: string;
  role: string;
  name: string;
  vendor: string | null;
  lastVendorSessionId: string | null;
};

export type SessionEvent = {
  id: string;
  projectId: string;
  worktreeId: string;
  personaId: string;
  vendor: string;
  startedAt: string;
  endedAt: string | null;
  /** True if this run created the binding; later joiners inherit it through the overlap set. */
  createdBinding: boolean;
};

export type MoveEvent = {
  id: string;
  projectId: string;
  fromRoot: string;
  toRoot: string;
  movedAt: string;
};

type ProjectInput = Pick<Project, 'name' | 'repoCommonDir' | 'storeDir'>;
type PersonaInput = Pick<Persona, 'projectId' | 'role' | 'name'> &
  Partial<Pick<Persona, 'vendor' | 'lastVendorSessionId'>>;
type WorktreeInput = Pick<Worktree, 'id' | 'projectId' | 'path' | 'branch'> &
  Partial<Pick<Worktree, 'portOffset'>>;
type SessionInput = Omit<SessionEvent, 'id' | 'endedAt' | 'createdBinding'> &
  Partial<Pick<SessionEvent, 'endedAt' | 'createdBinding'>>;
type MoveInput = Omit<MoveEvent, 'id'>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    repo_common_dir TEXT NOT NULL,
    store_dir TEXT NOT NULL,
    created_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    path TEXT NOT NULL,
    branch TEXT,
    created_at TEXT NOT NULL,
    port_offset INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project_id, path)
  );
  CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    vendor TEXT,
    last_vendor_session_id TEXT,
    UNIQUE(project_id, role)
  );
  CREATE TABLE IF NOT EXISTS bindings (
    persona_id TEXT PRIMARY KEY REFERENCES personas(id),
    worktree_id TEXT NOT NULL UNIQUE REFERENCES worktrees(id),
    bound_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    worktree_id TEXT NOT NULL REFERENCES worktrees(id),
    persona_id TEXT NOT NULL REFERENCES personas(id),
    vendor TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    created_binding INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS moves (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    from_root TEXT NOT NULL,
    to_root TEXT NOT NULL,
    moved_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

type ProjectRow = {
  id: string; name: string; repo_common_dir: string; store_dir: string;
  created_at: string; schema_version: number;
};
type WorktreeRow = {
  id: string; project_id: string; path: string; branch: string | null; created_at: string;
  port_offset: number;
};
type PersonaRow = {
  id: string; project_id: string; role: string; name: string;
  vendor: string | null; last_vendor_session_id: string | null;
};
type SessionRow = {
  id: string; project_id: string; worktree_id: string; persona_id: string;
  vendor: string; started_at: string; ended_at: string | null; created_binding: number;
};
type MoveRow = {
  id: string; project_id: string; from_root: string; to_root: string; moved_at: string;
};

function toProject(r: ProjectRow): Project {
  return {
    id: r.id, name: r.name, repoCommonDir: r.repo_common_dir,
    storeDir: r.store_dir, createdAt: r.created_at, schemaVersion: r.schema_version,
  };
}
function toWorktree(r: WorktreeRow): Worktree {
  return {
    id: r.id, projectId: r.project_id, path: r.path,
    branch: r.branch, createdAt: r.created_at, portOffset: r.port_offset,
  };
}
function toPersona(r: PersonaRow): Persona {
  return {
    id: r.id, projectId: r.project_id, role: r.role, name: r.name,
    vendor: r.vendor, lastVendorSessionId: r.last_vendor_session_id,
  };
}
function toSession(r: SessionRow): SessionEvent {
  return {
    id: r.id, projectId: r.project_id, worktreeId: r.worktree_id, personaId: r.persona_id,
    vendor: r.vendor, startedAt: r.started_at, endedAt: r.ended_at,
    createdBinding: r.created_binding === 1,
  };
}
function toMove(r: MoveRow): MoveEvent {
  return {
    id: r.id, projectId: r.project_id, fromRoot: r.from_root,
    toRoot: r.to_root, movedAt: r.moved_at,
  };
}

export type Registry = {
  projects: {
    create(input: ProjectInput): Project;
    get(id: string): Project | undefined;
    list(): Project[];
  };
  worktrees: {
    upsert(input: WorktreeInput): void;
    list(projectId: string): Worktree[];
    delete(id: string): void;
  };
  personas: {
    create(input: PersonaInput): Persona;
    get(id: string): Persona | undefined;
    list(projectId: string): Persona[];
    /** Records the vendor session id from a daemon-launched session. */
    setVendor(id: string, vendor: string, vendorSessionId: string): void;
    delete(id: string): void;
  };
  bindings: {
    bind(personaId: string, worktreeId: string): void;
    forWorktree(worktreeId: string): Persona | undefined;
    release(personaId: string): void;
  };
  sessions: {
    append(event: SessionInput): string;
    end(id: string, endedAt: string): void;
    list(projectId: string): SessionEvent[];
    deleteForWorktree(worktreeId: string): void;
  };
  moves: {
    append(event: MoveInput): void;
    list(projectId: string): MoveEvent[];
  };
  /** Local per-worktree toggles. Pending approvals live in the project's store. */
  settings: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
  };
  close(): void;
};

/** Local, never-moved SQLite index of projects, worktrees, personas, and history. */
export function openRegistry(file: string): Registry {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  const worktreeColumns = db.pragma('table_info(worktrees)') as Array<{ name: string }>;
  if (!worktreeColumns.some((column) => column.name === 'port_offset')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN port_offset INTEGER NOT NULL DEFAULT 0');
  }
  const sessionColumns = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  if (!sessionColumns.some((column) => column.name === 'created_binding')) {
    db.exec('ALTER TABLE sessions ADD COLUMN created_binding INTEGER NOT NULL DEFAULT 0');
  }

  return {
    projects: {
      create(input) {
        const id = newId();
        db.prepare(`INSERT INTO projects (id, name, repo_common_dir, store_dir, created_at, schema_version)
                    VALUES (?, ?, ?, ?, ?, 1)`)
          .run(id, input.name, input.repoCommonDir, input.storeDir, new Date().toISOString());
        return toProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow);
      },
      get(id) {
        const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
        return row ? toProject(row) : undefined;
      },
      list() {
        return (db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[]).map(toProject);
      },
    },
    worktrees: {
      upsert(input) {
        // Insert defaults to 0; an update without an explicit offset keeps the stored one.
        db.prepare(`INSERT INTO worktrees (id, project_id, path, branch, created_at, port_offset)
                    VALUES (@id, @projectId, @path, @branch, @createdAt, COALESCE(@portOffset, 0))
                    ON CONFLICT(id) DO UPDATE SET path = excluded.path, branch = excluded.branch,
                      port_offset = COALESCE(@portOffset, worktrees.port_offset)`)
          .run({
            id: input.id, projectId: input.projectId, path: input.path, branch: input.branch,
            createdAt: new Date().toISOString(), portOffset: input.portOffset ?? null,
          });
      },
      list(projectId) {
        return (db.prepare('SELECT * FROM worktrees WHERE project_id = ? ORDER BY id')
          .all(projectId) as WorktreeRow[]).map(toWorktree);
      },
      delete(id) {
        db.prepare('DELETE FROM worktrees WHERE id = ?').run(id);
      },
    },
    personas: {
      create(input) {
        const id = newId();
        db.prepare(`INSERT INTO personas (id, project_id, role, name, vendor, last_vendor_session_id)
                    VALUES (?, ?, ?, ?, ?, ?)`)
          .run(id, input.projectId, input.role, input.name, input.vendor ?? null, input.lastVendorSessionId ?? null);
        return toPersona(db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as PersonaRow);
      },
      get(id) {
        const row = db.prepare('SELECT * FROM personas WHERE id = ?').get(id) as PersonaRow | undefined;
        return row ? toPersona(row) : undefined;
      },
      list(projectId) {
        return (db.prepare('SELECT * FROM personas WHERE project_id = ? ORDER BY id')
          .all(projectId) as PersonaRow[]).map(toPersona);
      },
      setVendor(id, vendor, vendorSessionId) {
        db.prepare(`UPDATE personas SET vendor = ?, last_vendor_session_id = ? WHERE id = ?`)
          .run(vendor, vendorSessionId, id);
      },
      delete(id) {
        db.prepare('DELETE FROM personas WHERE id = ?').run(id);
      },
    },
    bindings: {
      bind(personaId, worktreeId) {
        const existing = db.prepare('SELECT persona_id FROM bindings WHERE worktree_id = ?')
          .get(worktreeId) as { persona_id: string } | undefined;
        if (existing && existing.persona_id !== personaId) {
          throw new ArtinareyError('INVALID_INPUT', 'worktree already has an active persona');
        }
        db.prepare(`INSERT INTO bindings (persona_id, worktree_id, bound_at)
                    VALUES (?, ?, ?)
                    ON CONFLICT(persona_id) DO UPDATE SET worktree_id = excluded.worktree_id`)
          .run(personaId, worktreeId, new Date().toISOString());
      },
      forWorktree(worktreeId) {
        const row = db.prepare(`SELECT p.* FROM personas p
                                JOIN bindings b ON b.persona_id = p.id
                                WHERE b.worktree_id = ?`)
          .get(worktreeId) as PersonaRow | undefined;
        return row ? toPersona(row) : undefined;
      },
      release(personaId) {
        db.prepare('DELETE FROM bindings WHERE persona_id = ?').run(personaId);
      },
    },
    sessions: {
      append(event) {
        const id = newId();
        db.prepare(`INSERT INTO sessions
                    (id, project_id, worktree_id, persona_id, vendor, started_at, ended_at, created_binding)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, event.projectId, event.worktreeId, event.personaId, event.vendor,
            event.startedAt, event.endedAt ?? null, event.createdBinding ? 1 : 0);
        return id;
      },
      end(id, endedAt) {
        db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(endedAt, id);
      },
      list(projectId) {
        return (db.prepare('SELECT * FROM sessions WHERE project_id = ? ORDER BY id')
          .all(projectId) as SessionRow[]).map(toSession);
      },
      deleteForWorktree(worktreeId) {
        db.prepare('DELETE FROM sessions WHERE worktree_id = ?').run(worktreeId);
      },
    },
    moves: {
      append(event) {
        db.prepare(`INSERT INTO moves (id, project_id, from_root, to_root, moved_at)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(newId(), event.projectId, event.fromRoot, event.toRoot, event.movedAt);
      },
      list(projectId) {
        return (db.prepare('SELECT * FROM moves WHERE project_id = ? ORDER BY id')
          .all(projectId) as MoveRow[]).map(toMove);
      },
    },
    settings: {
      get(key) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
          { value: string } | undefined;
        return row?.value;
      },
      set(key, value) {
        db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
      },
    },
    close() {
      db.close();
    },
  };
}
