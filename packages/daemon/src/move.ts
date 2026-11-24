import { createHash } from 'node:crypto';
import {
  accessSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readdirSync, rmSync, statSync, statfsSync, writeFileSync,
} from 'node:fs';
import { cp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import {
  atomicWrite, buildIndex, type XdgPaths,
} from '@artinarey/core';
import type { RpcContext } from './tools.ts';

export type MovePhase =
  | 'idle' | 'preflight' | 'paused' | 'copying' | 'verifying' | 'switching'
  | 'rebuilding' | 'resuming' | 'done' | 'undo' | 'offline';

export type MoveStatus = {
  phase: MovePhase;
  projectId: string;
  source: string;
  target: string;
  bytesCopied: number;
  bytesTotal: number;
  fileCount: number;
  verified: boolean;
  error: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  oldDeleted?: boolean;
  /** Last durable phase before an offline failure, so a resumed move never restarts a finished switch. */
  checkpoint?: MovePhase;
};

export function movePaths(target: string, projectId: string) {
  const root = resolve(target);
  return {
    root,
    incoming: join(root, `${projectId}.incoming`),
    final: join(root, projectId),
  };
}

function journalFile(paths: XdgPaths, projectId: string): string {
  return join(paths.configDir, 'moves', `${projectId}.json`);
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function moveError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function asMoveError(error: unknown): { code: string; message: string } {
  if (error && typeof error === 'object' && 'code' in error
      && typeof (error as { code: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    return { code, message: error instanceof Error ? error.message : String(error) };
  }
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
}

function absolute(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value)) {
    throw moveError('INVALID_INPUT', `${field} must be an absolute path`);
  }
  return resolve(value);
}

/** Missing or unwritable storage is a typed offline state, never an empty result. */
export function writableDirectory(path: string, label: string): void {
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory');
    accessSync(path, constants.W_OK | constants.X_OK);
  } catch {
    throw moveError('STORE_OFFLINE', `${label} is missing or not writable: ${path}`);
  }
}

export function readMove(ctx: RpcContext, projectId: string): MoveStatus {
  const project = ctx.registry.projects.get(projectId);
  if (!project) throw moveError('NOT_FOUND', `unknown project: ${projectId}`);
  const fallback: MoveStatus = {
    phase: 'idle', projectId, source: project.storeDir, target: '', bytesCopied: 0,
    bytesTotal: 0, fileCount: 0, verified: false, error: null,
    startedAt: null, updatedAt: null,
  };
  const file = journalFile(ctx.paths, projectId);
  if (!existsSync(file)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MoveStatus>;
    if (parsed.projectId !== projectId) return fallback;
    return { ...fallback, ...parsed, projectId };
  } catch {
    // A torn journal is never authority; a fresh preflight may replace it.
    return fallback;
  }
}

function writeMove(
  ctx: RpcContext, status: MoveStatus, checkpoint?: MovePhase,
): MoveStatus {
  const updated: MoveStatus = {
    ...status,
    checkpoint: status.phase === 'offline' ? status.checkpoint : checkpoint ?? status.phase,
    updatedAt: new Date().toISOString(),
  };
  // Do not append to the source store here: an audit write after the copy
  // starts would change the bytes being verified. The registry move record and
  // this durable journal are the move's authority; stores keep their own audit.
  atomicWrite(journalFile(ctx.paths, status.projectId), `${JSON.stringify(updated)}\n`, 0o600);
  return updated;
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        const info = statSync(path, { throwIfNoEntry: false });
        if (!info) continue;
        if (info.isDirectory()) walk(path);
        else if (info.isFile()) out.push(path);
      } catch {
        // A file removed mid-walk is retried on the next pass.
      }
    }
  };
  walk(root);
  return out.sort();
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

type MoveManifest = { schema: number; files: Record<string, string> };
const MANIFEST_FILE = 'manifest.json';

/** The manifest is written into the verified copy before it becomes the live store. */
function readManifest(storeDir: string): MoveManifest | undefined {
  const file = join(storeDir, MANIFEST_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<MoveManifest>;
    return parsed.files && typeof parsed.files === 'object'
      ? { schema: 1, files: parsed.files as Record<string, string> }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mail accepted between verification and the registry switch still lives in the
 * old store. Copy those late bytes into the moved store after the switch; bytes
 * already written to the moved store win, so a fresh reply is never overwritten.
 */
function syncLateWrites(source: string, final: string): void {
  const manifest = readManifest(final);
  if (!manifest) return;
  for (const file of filesUnder(source)) {
    const relative = file.slice(source.length + 1);
    if (relative === MANIFEST_FILE) continue;
    const expected = manifest.files[relative];
    const actual = sha256(file);
    if (expected === actual) continue;
    const destination = join(final, relative);
    if (existsSync(destination) && (!expected || sha256(destination) !== expected)) continue;
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, readFileSync(file));
    manifest.files[relative] = actual;
  }
  atomicWrite(join(final, MANIFEST_FILE), `${JSON.stringify({
    schema: 1, files: manifest.files,
  })}\n`);
}

/** Best-effort durability: not every filesystem permits fsync on a read-only fd. */
function syncCopiedFiles(root: string): void {
  for (const file of filesUnder(root)) {
    let fd: number | undefined;
    try {
      fd = openSync(file, 'r');
      fsyncSync(fd);
    } catch {
      // The hash verification below is the correctness gate.
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* already closed by the OS */ }
      }
    }
  }
}

/** Preflight is read-only: no journal, registry row or store byte changes. */
export function preflightMove(ctx: RpcContext, projectId: string, targetInput: string): MoveStatus {
  const project = ctx.registry.projects.get(projectId);
  if (!project) throw moveError('NOT_FOUND', `unknown project: ${projectId}`);
  const target = absolute(targetInput, 'target');
  writableDirectory(target, 'destination');
  const repoRoot = resolve(dirname(project.repoCommonDir));
  if (inside(repoRoot, target)) {
    throw moveError('INVALID_INPUT', 'destination must not be inside the repository');
  }
  const running = ctx.supervisor?.sessions(projectId).some((session) => session.status === 'running')
    ?? false;
  if (running) {
    throw moveError('INVALID_INPUT', 'stop running sessions before moving this store');
  }
  const paths = movePaths(target, projectId);
  if (existsSync(paths.final) && resolve(project.storeDir) !== resolve(paths.final)) {
    throw moveError('INVALID_INPUT', `destination store already exists: ${paths.final}`);
  }
  writableDirectory(project.storeDir, 'source');
  const sourceFiles = filesUnder(project.storeDir);
  const bytesTotal = sourceFiles.reduce((total, file) => total + statSync(file).size, 0);
  const stats = statfsSync(target);
  if (stats.bsize * stats.bavail < Math.ceil(bytesTotal * 1.2)) {
    throw moveError('STORE_OFFLINE', 'destination has less than 1.2x the store size free');
  }
  const previous = readMove(ctx, projectId);
  return {
    ...previous,
    phase: 'preflight', projectId, source: project.storeDir, target, bytesTotal,
    bytesCopied: 0, fileCount: sourceFiles.length, verified: false, error: null,
    startedAt: previous.startedAt ?? new Date().toISOString(),
    // A new move starts fresh; a resumed one keeps its durable flag and checkpoint.
    oldDeleted: false, checkpoint: undefined,
  };
}

async function copyAndVerify(ctx: RpcContext, status: MoveStatus): Promise<MoveStatus> {
  const paths = movePaths(status.target, status.projectId);
  writableDirectory(paths.root, 'destination');
  writableDirectory(status.source, 'source');
  let current = writeMove(ctx, { ...status, phase: 'copying', error: null });

  // A resumed copy starts clean: partial bytes are never treated as verified.
  await rm(paths.incoming, { recursive: true, force: true });
  await cp(status.source, paths.incoming, {
    recursive: true, force: false, errorOnExist: true, preserveTimestamps: true,
  });
  syncCopiedFiles(paths.incoming);
  current = writeMove(ctx, { ...current, bytesCopied: current.bytesTotal });

  current = writeMove(ctx, { ...current, phase: 'verifying' });
  const sourceFiles = filesUnder(status.source);
  const manifest: Record<string, string> = {};
  for (const file of sourceFiles) {
    const relative = file.slice(status.source.length + 1);
    const copied = join(paths.incoming, relative);
    const hash = sha256(file);
    if (!existsSync(copied) || hash !== sha256(copied)) {
      throw moveError('STORE_OFFLINE', `copy verification failed for ${relative}`);
    }
    if (relative !== MANIFEST_FILE) manifest[relative] = hash;
  }
  atomicWrite(join(paths.incoming, MANIFEST_FILE), `${JSON.stringify({
    schema: 1, files: manifest,
  })}\n`);
  return writeMove(ctx, { ...current, verified: true, fileCount: sourceFiles.length });
}

async function switchAndFinish(ctx: RpcContext, status: MoveStatus): Promise<MoveStatus> {
  const paths = movePaths(status.target, status.projectId);
  let current = writeMove(ctx, { ...status, phase: 'switching' });
  if (!existsSync(paths.final)) {
    if (!existsSync(paths.incoming)) {
      throw moveError('STORE_OFFLINE', `verified copy is missing: ${paths.incoming}`);
    }
    await rename(paths.incoming, paths.final);
  }
  ctx.registry.projects.updateStoreDir(status.projectId, paths.final);
  try {
    syncLateWrites(status.source, paths.final);
  } catch (err) {
    // The switch already happened: fail durably at the switching checkpoint so
    // a later resume retries the late-write sync instead of indexing and
    // completing an incomplete destination. The old store stays available.
    return toOffline(ctx, current, moveError(
      'STORE_OFFLINE', `late-write sync failed: ${asMoveError(err).message}`,
    ));
  }
  current = writeMove(ctx, { ...current, phase: 'rebuilding' });
  buildIndex(join(ctx.paths.cacheRoot, status.projectId, 'index.sqlite'), paths.final);
  current = writeMove(ctx, { ...current, phase: 'resuming' });
  const recorded = ctx.registry.moves.list(status.projectId)
    .some((event) => event.fromRoot === status.source && event.toRoot === paths.final);
  if (!recorded) {
    ctx.registry.moves.append({
      projectId: status.projectId, fromRoot: status.source, toRoot: paths.final,
      movedAt: new Date().toISOString(),
    });
  }
  return writeMove(ctx, { ...current, phase: 'done', error: null });
}

function toOffline(ctx: RpcContext, status: MoveStatus, error: unknown): MoveStatus {
  const { code, message } = asMoveError(error);
  // The journal is the durable authority: a caller's snapshot may predate a
  // successful switch, so never let it erase the phase actually reached.
  const latest = readMove(ctx, status.projectId);
  const base = latest.phase !== 'idle' || latest.target ? latest : status;
  const checkpoint = latest.checkpoint && latest.checkpoint !== 'offline'
    ? latest.checkpoint
    : status.checkpoint && status.checkpoint !== 'offline' ? status.checkpoint : undefined;
  return writeMove(ctx, {
    ...base, phase: 'offline', checkpoint, error: `${code}: ${message}`,
  });
}

/** Continue from the durable phase, never from a fresh source snapshot. */
export async function resumeMove(ctx: RpcContext, projectId: string): Promise<MoveStatus> {
  const status = readMove(ctx, projectId);
  if (status.phase === 'offline' && status.target) {
    try {
      writableDirectory(movePaths(status.target, projectId).root, 'destination');
    } catch (err) {
      return toOffline(ctx, status, err);
    }
  }
  if (['idle', 'preflight', 'done', 'undo'].includes(status.phase)) return status;
  try {
    return await runMove(ctx, status);
  } catch (err) {
    return toOffline(ctx, status, err);
  }
}

async function runMove(ctx: RpcContext, status: MoveStatus): Promise<MoveStatus> {
  const paths = movePaths(status.target, status.projectId);
  if (!ctx.registry.projects.get(status.projectId)) {
    throw moveError('NOT_FOUND', `unknown project: ${status.projectId}`);
  }
  if (!status.target) throw moveError('INVALID_INPUT', 'no move target is journaled');

  // Once the registry points at the destination, a resumed move must never
  // recopy from the original source: only the finalisation steps remain.
  const checkpoint = status.checkpoint ?? status.phase;
  if (['switching', 'rebuilding', 'resuming'].includes(checkpoint)) {
    return switchAndFinish(ctx, status);
  }
  if (status.phase === 'paused' || status.phase === 'copying' || status.phase === 'offline') {
    return switchAndFinish(ctx, await copyAndVerify(ctx, status));
  }
  if (status.phase === 'verifying') {
    const sourceFiles = filesUnder(status.source);
    const copiedFiles = filesUnder(paths.incoming);
    const matches = sourceFiles.length === copiedFiles.length
      && sourceFiles.every((file) => {
        const copied = join(paths.incoming, file.slice(status.source.length + 1));
        return existsSync(copied) && sha256(file) === sha256(copied);
      });
    return switchAndFinish(ctx, matches
      ? writeMove(ctx, { ...status, verified: true, bytesCopied: status.bytesTotal })
      : await copyAndVerify(ctx, status));
  }
  if (['switching', 'rebuilding', 'resuming'].includes(status.phase)) {
    return switchAndFinish(ctx, status);
  }
  return status;
}

export async function startMove(
  ctx: RpcContext, projectId: string, targetInput: string,
): Promise<MoveStatus> {
  const target = absolute(targetInput, 'target');
  const existing = readMove(ctx, projectId);
  const active = !['idle', 'preflight', 'done', 'undo'].includes(existing.phase);
  if (active && existing.target && resolve(existing.target) !== target) {
    throw moveError(
      'INVALID_INPUT', `a move to ${existing.target} is already in progress`,
    );
  }
  const preview = active ? existing : preflightMove(ctx, projectId, target);
  // An active move may have switched already; restart it from its checkpoint.
  const paused = writeMove(
    ctx, { ...preview, phase: 'paused', target, error: null },
    active ? existing.checkpoint : undefined,
  );
  try {
    return await runMove(ctx, paused);
  } catch (err) {
    return toOffline(ctx, paused, err);
  }
}

/** Undo only while the original files still match the moved files byte for byte. */
export function undoMove(ctx: RpcContext, projectId: string): MoveStatus {
  const status = readMove(ctx, projectId);
  if (status.phase !== 'done') {
    throw moveError('INVALID_INPUT', 'undo is only available after a completed move');
  }
  const paths = movePaths(status.target, projectId);
  writableDirectory(status.source, 'original store');
  writableDirectory(paths.final, 'moved store');
  const originals = new Set(
    filesUnder(status.source)
      .map((file) => file.slice(status.source.length + 1))
      .filter((relative) => relative !== MANIFEST_FILE),
  );
  const moved = new Set(
    filesUnder(paths.final)
      .map((file) => file.slice(paths.final.length + 1))
      .filter((relative) => relative !== MANIFEST_FILE),
  );
  if (moved.size !== originals.size
      || [...moved].some((relative) => !originals.has(relative))) {
    throw moveError(
      'MOVE_CHANGED', 'the moved store changed after the switch; copy new mail back before undoing',
    );
  }
  for (const file of filesUnder(paths.final)) {
    const relative = file.slice(paths.final.length + 1);
    if (relative === MANIFEST_FILE) continue;
    if (sha256(file) !== sha256(join(status.source, relative))) {
      throw moveError(
        'MOVE_CHANGED', 'the moved store changed after the switch; copy new mail back before undoing',
      );
    }
  }
  ctx.registry.projects.updateStoreDir(projectId, status.source);
  buildIndex(join(ctx.paths.cacheRoot, projectId, 'index.sqlite'), status.source);
  return writeMove(ctx, { ...status, phase: 'undo', error: null });
}

/** Explicit second confirmation: deletes only the untouched original store. */
export function deleteOldStore(ctx: RpcContext, projectId: string): { deleted: boolean } {
  const status = readMove(ctx, projectId);
  if (status.phase !== 'done') {
    throw moveError('INVALID_INPUT', 'delete-old is only available after a completed move');
  }
  if (status.oldDeleted) {
    throw moveError('INVALID_INPUT', 'the old store has already been deleted');
  }
  const paths = movePaths(status.target, projectId);
  const source = resolve(status.source);
  if (source === resolve(paths.final) || !existsSync(paths.final)) {
    throw moveError('INVALID_INPUT', 'refusing to delete the live store');
  }
  if (resolve(ctx.registry.projects.get(projectId)?.storeDir ?? '') === source) {
    throw moveError('INVALID_INPUT', 'the project still points at the old store');
  }
  const manifest = readManifest(paths.final);
  if (!manifest) {
    throw moveError('MOVE_CHANGED', 'the moved store has no copy manifest; refusing to delete the old store');
  }
  // Older moves could record the source store's manifest as a payload file.
  const expected = Object.keys(manifest.files).filter((relative) => relative !== MANIFEST_FILE).sort();
  // The old store matching the manifest is not enough: the live destination
  // must still hold every file the move verified, with the same bytes.
  const destinationFiles = new Set(
    filesUnder(paths.final).map((file) => file.slice(paths.final.length + 1)),
  );
  for (const relative of expected) {
    if (!destinationFiles.has(relative)
        || sha256(join(paths.final, relative)) !== manifest.files[relative]) {
      throw moveError(
        'MOVE_CHANGED', 'the moved store no longer matches the move manifest; refusing to delete the old store',
      );
    }
  }
  const actual = filesUnder(source)
    .map((file) => file.slice(source.length + 1))
    .filter((relative) => relative !== MANIFEST_FILE)
    .sort();
  if (actual.length !== expected.length
      || actual.some((relative, i) => relative !== expected[i]
        || sha256(join(source, relative)) !== manifest.files[relative])) {
    throw moveError('MOVE_CHANGED', 'the old store changed after the move; refusing to delete it');
  }
  rmSync(source, { recursive: true, force: true });
  writeMove(ctx, { ...status, oldDeleted: true });
  return { deleted: true };
}

/** Test seam for a crash between phases: a spawned child can be killed with SIGKILL. */
export function moveJournalPath(paths: XdgPaths, projectId: string): string {
  return journalFile(paths, projectId);
}

export function moveIncomingPath(status: MoveStatus): string {
  return movePaths(status.target, status.projectId).incoming;
}

export function moveFinalPath(status: MoveStatus): string {
  return movePaths(status.target, status.projectId).final;
}
