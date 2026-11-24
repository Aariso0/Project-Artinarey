import {
  closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readFileSync,
  realpathSync, rmSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ArtinareyError, type ArtinareyErrorCode } from './errors.ts';
import { personaDir, readPersona, writePersona, type PersonaState } from './persona-store.ts';
import { appendJournal } from './store.ts';
import type { Registry } from './registry.ts';
import { listGitWorktrees, lockGitWorktree, unlockGitWorktree } from './worktree.ts';

/** An env copy Artinarey created itself, identified by the exact bytes it wrote. */
export type GeneratedEnv = { name: string; sha256: string };

export type Marker = {
  schema: 1;
  project_id: string;
  worktree_id: string;
  generated_env?: GeneratedEnv[];
};

export const MARKER_FILE = '.artinarey.json';

function isGeneratedEnv(value: unknown): value is GeneratedEnv {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.name === 'string' && typeof entry.sha256 === 'string';
}

function isMarker(value: unknown): value is Marker {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.schema === 1 && typeof m.project_id === 'string' && typeof m.worktree_id === 'string'
    && (m.generated_env === undefined
      || (Array.isArray(m.generated_env) && m.generated_env.every(isGeneratedEnv)));
}

/** IDs and generated-file ownership only: no store path, no persona. */
export function writeMarker(
  dir: string, projectId: string, worktreeId: string, generatedEnv?: GeneratedEnv[],
): void {
  const marker: Marker = {
    schema: 1,
    project_id: projectId,
    worktree_id: worktreeId,
    ...(generatedEnv && generatedEnv.length > 0 ? { generated_env: generatedEnv } : {}),
  };
  // O_NOFOLLOW closes the lstat→write window; never write through a foreign marker.
  const fd = openSync(join(dir, MARKER_FILE),
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o644);
  try {
    writeSync(fd, JSON.stringify(marker));
  } finally {
    closeSync(fd);
  }
}

/** Read a marker in one directory only, without walking up to a parent project. */
export function readMarker(dir: string): Marker | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8'));
    return isMarker(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Walk up from a directory to the nearest valid marker. */
export function findMarker(startDir: string): { dir: string; marker: Marker } | undefined {
  let current = resolve(startDir);
  while (true) {
    const marker = readMarker(current);
    if (marker) return { dir: current, marker };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** A non-regular marker is foreign state: reject it before any cleanup can run. */
export function assertPlainMarkerPath(dir: string): boolean {
  try {
    const stat = lstatSync(join(dir, MARKER_FILE));
    if (!stat.isFile()) {
      throw new ArtinareyError('INVALID_INPUT', `marker is not a regular file: ${join(dir, MARKER_FILE)}`);
    }
    return true;
  } catch (err) {
    if (err instanceof ArtinareyError) throw err;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new ArtinareyError('INVALID_INPUT', `unusable marker path: ${join(dir, MARKER_FILE)}`);
  }
}

export type Identity = {
  projectId: string;
  worktreeId: string;
  markerDir: string;
  storeDir: string;
  personaId?: string;
  role?: string;
};

export type IdentityFailure = {
  ok: false;
  code: ArtinareyErrorCode;
  message: string;
};

export type IdentityResult = { ok: true; identity: Identity } | IdentityFailure;
export type ClaimResult =
  | { ok: true; identity: Identity; personaId: string; created: boolean }
  | IdentityFailure;

export type RosterEntry = {
  personaId: string;
  name: string;
  role: string;
  state: string;
  homeWorktreeId: string | null;
  lastTask: string;
};

function audit(storeDir: string, event: Record<string, unknown>): void {
  appendJournal(join(storeDir, 'events', 'audit.jsonl'), {
    ...event,
    created_at: new Date().toISOString(),
  });
}

/** Removal audit, including the session history discarded with the worktree. */
export function auditWorktreeRemoval(
  storeDir: string, worktreeId: string, sessionsRemoved: number,
): void {
  audit(storeDir, {
    type: 'worktree_removed', worktree_id: worktreeId, sessions_removed: sessionsRemoved,
  });
}

/** Bindings have no by-persona lookup, so find the path through registered worktrees. */
function boundWorktreePath(registry: Registry, personaId: string): string | undefined {
  for (const project of registry.projects.list()) {
    for (const worktree of registry.worktrees.list(project.id)) {
      if (registry.bindings.forWorktree(worktree.id)?.id === personaId) return worktree.path;
    }
  }
  return undefined;
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

/** Marker → registered worktree → bound persona. Every mismatch is audited. */
export function resolveIdentity(registry: Registry, cwd: string): IdentityResult {
  const found = findMarker(cwd);
  if (!found) {
    return { ok: false, code: 'NO_PROJECT', message: 'no .artinarey.json found; run artinarey init' };
  }

  let registeredPath: string | undefined;
  let registeredBranch: string | null = null;
  let storeDir: string | undefined;
  for (const project of registry.projects.list()) {
    const worktree = registry.worktrees.list(project.id)
      .find((wt) => wt.id === found.marker.worktree_id);
    if (worktree && project.id === found.marker.project_id) {
      registeredPath = worktree.path;
      registeredBranch = worktree.branch;
      storeDir = project.storeDir;
      break;
    }
  }

  const pathMatches = registeredPath !== undefined && storeDir !== undefined
    && sameDirectory(found.dir, registeredPath);
  let branchMismatch: { registered: string | null; git: string | null } | undefined;
  if (pathMatches) {
    try {
      const gitWorktree = listGitWorktrees(found.dir).find((wt) =>
        sameDirectory(wt.path, found.dir));
      if (gitWorktree && gitWorktree.branch !== registeredBranch) {
        branchMismatch = { registered: registeredBranch, git: gitWorktree.branch };
      }
    } catch {
      // No git worktree here (e.g. a plain temp dir): nothing to compare against.
    }
  }

  if (!pathMatches || !storeDir || branchMismatch) {
    const message = branchMismatch
      ? `branch changed; confirm the move (registered: ${branchMismatch.registered ?? 'detached'}, git: ${branchMismatch.git ?? 'detached'})`
      : 'marker does not match a registered worktree; run artinarey worktree adopt';
    try {
      audit(storeDir ?? join(cwd, '.artinarey-unmanaged'), {
        type: 'worktree_unmanaged',
        worktree_id: found.marker.worktree_id,
        marker_dir: found.dir,
        registered_path: registeredPath ?? null,
        ...(branchMismatch ? {
          registered_branch: branchMismatch.registered,
          git_branch: branchMismatch.git,
          message,
        } : {}),
      });
    } catch {
      // Diagnostics are best-effort: a read-only checkout must still get the typed result.
    }
    return { ok: false, code: 'WORKTREE_UNMANAGED', message };
  }

  const binding = registry.bindings.forWorktree(found.marker.worktree_id);
  const identity: Identity = {
    projectId: found.marker.project_id,
    worktreeId: found.marker.worktree_id,
    markerDir: found.dir,
    storeDir,
    ...(binding ? { personaId: binding.id, role: binding.role } : {}),
  };
  return { ok: true, identity };
}

export function createPersona(
  registry: Registry,
  storeDir: string,
  projectId: string,
  role: string,
  name: string,
): string {
  const persona = registry.personas.create({ projectId, role, name });
  const dir = personaDir(storeDir, persona.id);
  const dirExisted = existsSync(dir);
  try {
    writePersona(storeDir, persona.id, {
      role, name, home_worktree_id: null, state: 'new', vendor: null, last_vendor_session_id: null,
    });
    audit(storeDir, { type: 'persona_created', persona_id: persona.id, role, name });
  } catch (err) {
    // A retry must not create a second persona for this failed attempt, whether
    // the persona file or the audit append was the step that failed.
    registry.personas.delete(persona.id);
    if (!dirExisted) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return persona.id;
}

export function roster(registry: Registry, storeDir: string, projectId: string): RosterEntry[] {
  return registry.personas.list(projectId).map((persona) => {
    const state = readPersona(storeDir, persona.id);
    const statusFile = join(storeDir, 'personas', persona.id, 'status.md');
    const lastTask = existsSync(statusFile)
      ? readFileSync(statusFile, 'utf8').trim().replace(/\s+/g, ' ')
      : '';
    return {
      personaId: persona.id,
      name: persona.name,
      role: persona.role,
      state: state.state,
      homeWorktreeId: state.home_worktree_id,
      lastTask,
    };
  });
}

export type RehomeResult =
  | { ok: true }
  | { ok: false; code: 'INVALID_INPUT' | 'NOT_FOUND'; message: string };

/** Point a persona's home at a worktree of the same project. Bindings are untouched. */
export function rehomePersona(
  registry: Registry,
  storeDir: string,
  personaId: string,
  worktreeId: string,
): RehomeResult {
  if (!personaId || !worktreeId) {
    return { ok: false, code: 'INVALID_INPUT', message: 'provide a persona and a worktree' };
  }
  const persona = registry.personas.get(personaId);
  if (!persona) {
    return { ok: false, code: 'NOT_FOUND', message: `unknown persona: ${personaId}` };
  }
  const worktree = registry.projects.list()
    .flatMap((project) => registry.worktrees.list(project.id))
    .find((candidate) => candidate.id === worktreeId);
  if (!worktree) {
    return { ok: false, code: 'NOT_FOUND', message: `unknown worktree: ${worktreeId}` };
  }
  if (persona.projectId !== worktree.projectId) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'persona and worktree belong to different projects',
    };
  }

  const state = readPersona(storeDir, personaId);
  writePersona(storeDir, personaId, { ...state, home_worktree_id: worktreeId });
  audit(storeDir, {
    type: 'persona_rehome', persona_id: personaId, worktree_id: worktreeId,
    previous_home_worktree_id: state.home_worktree_id,
  });
  return { ok: true };
}

export type ClaimOptions = {
  personaId?: string;
  newRole?: string;
  name?: string;
  confirmMove?: boolean;
  rehome?: boolean;
};

/** Bind a persona to the attached worktree, enforcing the settled one-per-directory rules. */
export function claimPersona(
  registry: Registry,
  storeDir: string,
  identity: Identity,
  options: ClaimOptions,
): ClaimResult {
  const requestedId = options.personaId;
  const newRole = options.newRole;
  if (!requestedId && !newRole) {
    return { ok: false, code: 'INVALID_INPUT', message: 'provide persona_id or new_role' };
  }

  // Check the directory before creating a persona: an occupied worktree must not
  // leave an orphan persona/registry row behind.
  const busy = registry.bindings.forWorktree(identity.worktreeId);
  if (busy && busy.id !== requestedId) {
    audit(storeDir, { type: 'claim_refused', code: 'DIRECTORY_BUSY', persona_id: requestedId ?? null,
      worktree_id: identity.worktreeId, other_persona_id: busy.id });
    return {
      ok: false,
      code: 'DIRECTORY_BUSY',
      message: `directory is already bound to ${busy.role} (${busy.name}); stop and tell the user`,
    };
  }

  let personaId = requestedId;
  let created = false;
  if (!personaId) {
    personaId = createPersona(
      registry, storeDir, identity.projectId, newRole!, options.name ?? newRole!,
    );
    created = true;
  }

  const persona = registry.personas.get(personaId);
  if (!persona || persona.projectId !== identity.projectId) {
    return { ok: false, code: 'NOT_FOUND', message: `unknown persona: ${personaId}` };
  }

  const previousPath = boundWorktreePath(registry, personaId);
  const personaState = readPersona(storeDir, personaId);
  const home = personaState.home_worktree_id;
  const isSeniorDev = persona.role === 'senior-dev';
  if (home && home !== identity.worktreeId && !options.confirmMove && !options.rehome && !isSeniorDev) {
    audit(storeDir, { type: 'claim_needs_confirmation', persona_id: personaId,
      home_worktree_id: home, worktree_id: identity.worktreeId });
    return {
      ok: false,
      code: 'NEEDS_CONFIRMATION',
      message: `${persona.role} is home in another worktree; ask the user, then repeat with confirm_move=true (or rehome=true)`,
    };
  }

  registry.bindings.bind(personaId, identity.worktreeId);
  lockGitWorktree(identity.markerDir, persona.role);
  const nextHome = options.rehome || !home ? identity.worktreeId : home;
  writePersona(storeDir, personaId, { ...personaState, home_worktree_id: nextHome, state: 'active' });
  try {
    audit(storeDir, { type: 'persona_claimed', persona_id: personaId,
      worktree_id: identity.worktreeId, home_worktree_id: nextHome,
      confirmed_move: Boolean(options.confirmMove), rehome: Boolean(options.rehome) });
  } finally {
    // A confirmed move transfers the lock: release the worktree this persona left,
    // even if the audit append fails. The audit error still propagates.
    if (previousPath && !sameDirectory(previousPath, identity.markerDir)) {
      unlockGitWorktree(previousPath);
    }
  }

  return {
    ok: true,
    personaId,
    created,
    identity: { ...identity, personaId, role: persona.role },
  };
}

/** Undo a claim that threw after acquiring its binding, persona state and locks. */
export function rollbackFailedClaim(
  registry: Registry,
  identity: Identity,
  personaId: string | undefined,
  previousBinding: string | undefined,
  previousState: PersonaState,
  originalWorktree: { id: string; path: string } | undefined,
  created: boolean,
): void {
  if (!personaId) return;
  const boundHere = registry.bindings.forWorktree(identity.worktreeId)?.id === personaId;
  try {
    if (boundHere) writePersona(identity.storeDir, personaId, previousState);
  } finally {
    try {
      // Only undo resources this attempt acquired; keep a binding/lock that predated it.
      if (boundHere && previousBinding !== personaId) {
        registry.bindings.release(personaId);
        unlockGitWorktree(identity.markerDir);
        if (originalWorktree && originalWorktree.id !== identity.worktreeId) {
          registry.bindings.bind(personaId, originalWorktree.id);
          lockGitWorktree(originalWorktree.path, registry.personas.get(personaId)?.role ?? personaId);
        }
      }
    } finally {
      // A persona created by this attempt must not survive as an ambiguous role,
      // even when the claim failed before binding or another rollback step threw.
      if (created) {
        registry.personas.delete(personaId);
        rmSync(personaDir(identity.storeDir, personaId), { recursive: true, force: true });
      }
    }
  }
}

/** Delete first: an unlock after a failed delete would remove Git's protection. */
function releasePersonaCore(
  registry: Registry,
  storeDir: string,
  personaId: string,
  boundPath: string | undefined,
): void {
  registry.bindings.release(personaId);
  try {
    const state = readPersona(storeDir, personaId);
    if (state.state !== 'new' || state.role) {
      writePersona(storeDir, personaId, { ...state, state: 'idle' });
    }
  } finally {
    if (boundPath) unlockGitWorktree(boundPath);
  }
}

export function releasePersona(
  registry: Registry,
  storeDir: string,
  personaId: string,
): void {
  releasePersonaCore(registry, storeDir, personaId, boundWorktreePath(registry, personaId));
  audit(storeDir, { type: 'persona_released', persona_id: personaId });
}

/** User-initiated override via `artinarey release --force`. Returns false if nothing was bound. */
export function releaseWorktreeForce(
  registry: Registry,
  storeDir: string,
  worktreeId: string,
): boolean {
  const bound = registry.bindings.forWorktree(worktreeId);
  if (!bound) return false;
  const boundPath = registry.projects.list()
    .flatMap((project) => registry.worktrees.list(project.id))
    .find((worktree) => worktree.id === worktreeId)?.path;
  releasePersonaCore(registry, storeDir, bound.id, boundPath);
  audit(storeDir, {
    type: 'forced_release', persona_id: bound.id, worktree_id: worktreeId,
  });
  return true;
}
