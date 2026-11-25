import { existsSync, readFileSync, readdirSync, realpathSync, statfsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ArtinareyError, branchChangedFiles, buildIndex, changedFiles, getAutoApprove,
  listGitWorktrees, loadConfig, newId, queryMail, readApprovals, readSessions, readTasks,
  rehomePersona, resolveRepo, saveConfig, sendMail, sessionLogFile, setAutoApprove,
  adoptWorktree as coreAdoptWorktree, createWorktree as coreCreateWorktree, planWorktree,
  cloneProjectInto, registerProjectAt, uncoveredFiles, type Project, type SessionSummary,
  type XdgPaths,
} from '@artinarey/core';
import {
  deleteOldStore, preflightMove, readMove, startMove, undoMove,
} from './move.ts';
import type { RpcRequest, RpcResponse } from './server.ts';
import type { SessionSupervisor } from './sessions.ts';
import type { RpcContext } from './tools.ts';

export type GuiProject = {
  id: string;
  name: string;
  storeDir: string;
  bytes: number;
  freeBytes: number;
  status: 'active' | 'offline' | 'paused' | 'moving';
};

export type GuiPersona = {
  id: string;
  role: string;
  name: string;
  worktreeId: string | null;
  lastVendorSessionId: string | null;
  running: boolean;
};

export type GuiWorktree = {
  id: string;
  path: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
  personaId: string | null;
  autoApprove: boolean;
};

export type GuiMail = {
  id: string;
  thread: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  kind: string;
  createdAt: string;
};

export type GuiTask = {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
  worktreeId: string | null;
  updatedAt: string;
};

export type GuiLease = {
  id: string;
  projectId: string;
  worktreeId: string;
  personaId: string;
  paths: string[];
  reason: string;
  expiresAt: string | null;
};

export type GuiSession = {
  id: string;
  projectId: string;
  worktreeId: string;
  personaId: string;
  vendor: string;
  vendorSessionId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
};

export type GuiPreMerge = {
  id: string;
  worktreeId: string;
  status: string;
  summary: string;
  checkedAt: string;
};

export type GuiAudit = { id: string; at: string; type: string; text: string };

export type GuiApproval = {
  id: string;
  projectId: string;
  kind: string;
  summary: string;
  status: string;
  worktreeId: string | null;
  requestedAt: string;
};

export type GuiChatReply = { id: string; text: string; queued: boolean; copiedTo: string | null };

export type GuiStorage = {
  dataRoot: string;
  projects: Array<{ id: string; name: string; storeDir: string; bytes: number; freeBytes: number }>;
};

function ok(id: string, result: unknown): RpcResponse {
  return { id, ok: true, result };
}

function fail(id: string, code: string, message: string): RpcResponse {
  return { id, ok: false, error: { code, message } };
}

/** GUI request errors keep their code even when a code is not an agent-tool code. */
function requestError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function failure(id: string, error: unknown): RpcResponse {
  const code = error && typeof error === 'object' && 'code' in error
    && typeof (error as { code: unknown }).code === 'string'
    ? (error as { code: string }).code : 'INTERNAL_ERROR';
  return fail(id, code, error instanceof Error ? error.message : 'request failed');
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function paramsOf(request: RpcRequest): Record<string, unknown> {
  return request.params && typeof request.params === 'object' && !Array.isArray(request.params)
    ? request.params as Record<string, unknown> : {};
}

function projectsOf(ctx: RpcContext, projectId?: string): Project[] {
  const projects = ctx.registry.projects.list();
  return projectId ? projects.filter((project) => project.id === projectId) : projects;
}

/** A webview string is checked against the registry before it becomes a path. */
function knownProject(ctx: RpcContext, projectId: unknown): Project {
  if (typeof projectId !== 'string' || !projectId || !ctx.registry.projects.get(projectId)) {
    throw requestError('INVALID_REQUEST', 'a known projectId is required');
  }
  return ctx.registry.projects.get(projectId)!;
}

function dirSize(root: string): number {
  if (!existsSync(root)) return 0;
  let bytes = 0;
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
        else if (info.isFile()) bytes += info.size;
      } catch {
        // A disappearing file is not a reason to fail a read-only view.
      }
    }
  };
  walk(root);
  return bytes;
}

function storageOf(ctx: RpcContext, project: Project): Pick<GuiProject, 'bytes' | 'freeBytes' | 'status'> {
  if (!existsSync(project.storeDir)) return { bytes: 0, freeBytes: 0, status: 'offline' };
  try {
    const stats = statfsSync(project.storeDir);
    let status: GuiProject['status'] = 'active';
    try {
      const phase = readMove(ctx, project.id).phase;
      if (phase === 'offline') status = 'offline';
      else if (phase === 'paused') status = 'paused';
      else if (['copying', 'verifying', 'switching', 'rebuilding', 'resuming'].includes(phase)) {
        status = 'moving';
      }
    } catch {
      status = 'active';
    }
    return { bytes: dirSize(project.storeDir), freeBytes: stats.bsize * stats.bavail, status };
  } catch {
    return { bytes: 0, freeBytes: 0, status: 'offline' };
  }
}

function canonical(path: string): string {
  if (!existsSync(path)) return resolve(path);
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Git metadata is optional for the GUI; absent flags mean neither is set. */
function gitFlags(project: Project): Map<string, { locked: boolean; prunable: boolean }> {
  const flags = new Map<string, { locked: boolean; prunable: boolean }>();
  try {
    for (const entry of listGitWorktrees(project.repoCommonDir)) {
      flags.set(canonical(entry.path), { locked: entry.locked, prunable: entry.prunable });
    }
  } catch {
    // Missing or unreadable git metadata must not hide registered worktrees.
  }
  return flags;
}

function sessionsOf(
  supervisor: SessionSupervisor | undefined,
  ctx: RpcContext,
  projectId: string,
): SessionSummary[] {
  return supervisor?.sessions(projectId)
    ?? readSessions(sessionLogFile(ctx.paths.cacheRoot, projectId));
}

function limitOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
  return Math.min(500, Math.max(1, Math.floor(value)));
}

function approvalRows(
  ctx: RpcContext,
  supervisor: SessionSupervisor | undefined,
  projectId: string | undefined,
): GuiApproval[] {
  const approvals = supervisor
    ? supervisor.approvals(projectId)
    : projectsOf(ctx, projectId).flatMap((project) => readApprovals(project.storeDir));
  return approvals.map((approval) => ({
    id: approval.id,
    projectId: approval.projectId,
    kind: approval.kind,
    summary: approval.summary,
    status: approval.status,
    worktreeId: approval.worktreeId ?? null,
    requestedAt: approval.createdAt,
  }));
}

/** Audit rows are summaries: never echo mail, bodies, tokens or opaque payloads. */
function safeAuditText(event: Record<string, unknown>): string {
  const labels = ['summary', 'message', 'reason', 'path', 'role', 'worktree_id', 'kind', 'phase'];
  const parts: string[] = [];
  for (const label of labels) {
    const value = event[label];
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  }
  return parts.join(' · ') || String(event.type ?? 'event');
}

function auditRows(storeDir: string, limit: number): GuiAudit[] {
  const file = join(storeDir, 'events', 'audit.jsonl');
  if (!existsSync(file)) return [];
  const rows: GuiAudit[] = [];
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  for (const line of lines.slice(-limit).reverse()) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = typeof event.type === 'string' ? event.type : 'event';
      rows.push({
        id: typeof event.id === 'string' ? event.id : newId(),
        at: typeof event.created_at === 'string' ? event.created_at : '',
        type,
        text: safeAuditText(event),
      });
    } catch {
      // A torn final line is ignored rather than inventing an audit event.
    }
  }
  return rows;
}

function preMergeRows(ctx: RpcContext, project: Project): GuiPreMerge[] {
  const tasks = readTasks(project.storeDir)
    .filter((task) => task.status === 'ready_for_review' && task.worktreeId);
  const worktrees = new Map(
    ctx.registry.worktrees.list(project.id).map((worktree) => [worktree.id, worktree]),
  );
  // Diff the worktree's branch against the main checkout's HEAD: comparing it
  // against its own checked-out branch would always fail and look "verified".
  const repoRoot = dirname(project.repoCommonDir);
  return tasks.map((task) => {
    const worktree = worktrees.get(task.worktreeId!);
    let changed: string[] = [];
    let available = true;
    if (!worktree) {
      available = false;
    } else {
      try {
        changed = worktree.branch
          ? branchChangedFiles(repoRoot, worktree.branch) : changedFiles(worktree.path, false);
      } catch {
        available = false;
      }
    }
    // Use the core lease rule: a literal scope covers its descendants and globs match.
    const uncovered = uncoveredFiles([task], changed);
    return {
      id: task.id,
      worktreeId: task.worktreeId!,
      status: !available ? 'unavailable' : uncovered.length === 0 ? 'verified' : 'needs-review',
      summary: !available
        ? 'scope check unavailable: committed changes could not be compared'
        : uncovered.length === 0
          ? `${changed.length} changed files are inside the lease`
          : `${uncovered.length} changed files are outside the lease`,
      checkedAt: task.updatedAt,
    };
  });
}

/** Rebuild the XDG environment from the daemon's resolved paths so project setup
 * registers into the same registry the window is reading. */
function setupEnv(paths: XdgPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: dirname(paths.configDir),
    XDG_CACHE_HOME: dirname(paths.cacheRoot),
    XDG_RUNTIME_DIR: dirname(dirname(paths.socketPath)),
  };
}

/**
 * The GUI surface is a different door from agent tools: every method starts
 * with `gui.`, and the HTTP proxy checks auth, Host, Origin and body size first.
 * Results are snapshots — no bodies, tokens, secrets or read-state fields.
 */
export async function handleGuiRequest(request: RpcRequest, ctx: RpcContext): Promise<RpcResponse> {
  if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
    return fail('invalid', 'INVALID_REQUEST', 'invalid request');
  }
  if (!request.method.startsWith('gui.')) {
    return fail(request.id, 'FORBIDDEN_METHOD', `method not allowed on the GUI surface: ${request.method}`);
  }
  const params = paramsOf(request);

  try {
    switch (request.method) {
      case 'gui.projects': {
        const rows: GuiProject[] = ctx.registry.projects.list().map((project) => ({
          id: project.id,
          name: project.name,
          storeDir: project.storeDir,
          ...storageOf(ctx, project),
        }));
        return ok(request.id, rows);
      }
      case 'gui.personas': {
        const rows: GuiPersona[] = [];
        for (const project of projectsOf(ctx, str(params.projectId))) {
          const worktreeIds = new Map<string, string>();
          for (const worktree of ctx.registry.worktrees.list(project.id)) {
            const bound = ctx.registry.bindings.forWorktree(worktree.id);
            if (bound) worktreeIds.set(bound.id, worktree.id);
          }
          const sessions = sessionsOf(ctx.supervisor, ctx, project.id);
          for (const persona of ctx.registry.personas.list(project.id)) {
            rows.push({
              id: persona.id,
              role: persona.role,
              name: persona.name,
              worktreeId: worktreeIds.get(persona.id) ?? null,
              lastVendorSessionId: persona.lastVendorSessionId ?? null,
              running: sessions.some((session) => session.personaId === persona.id
                && session.status === 'running'),
            });
          }
        }
        return ok(request.id, rows);
      }
      case 'gui.worktrees': {
        const rows: GuiWorktree[] = [];
        for (const project of projectsOf(ctx, str(params.projectId))) {
          const flags = gitFlags(project);
          for (const worktree of ctx.registry.worktrees.list(project.id)) {
            const state = flags.get(canonical(worktree.path)) ?? { locked: false, prunable: false };
            const bound = ctx.registry.bindings.forWorktree(worktree.id);
            rows.push({
              id: worktree.id,
              path: worktree.path,
              branch: worktree.branch,
              locked: state.locked,
              prunable: state.prunable,
              personaId: bound?.id ?? null,
              autoApprove: getAutoApprove(ctx.registry, worktree.id),
            });
          }
        }
        return ok(request.id, rows);
      }
      case 'gui.mail': {
        const project = knownProject(ctx, params.projectId);
        const query: { recipient?: string; thread?: string } = {};
        const recipient = str(params.recipient);
        const thread = str(params.thread);
        if (recipient) query.recipient = recipient;
        if (thread) query.thread = thread;
        const mail = queryMail(join(ctx.paths.cacheRoot, project.id, 'index.sqlite'), query);
        const rows: GuiMail[] = mail
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .slice(0, limitOf(params.limit))
          .map((entry) => ({
            id: entry.id,
            thread: entry.thread,
            from: entry.from,
            to: [...entry.to],
            cc: [...entry.cc],
            subject: entry.subject,
            kind: entry.kind,
            createdAt: entry.createdAt,
          }));
        return ok(request.id, rows);
      }
      case 'gui.tasks': {
        const project = knownProject(ctx, params.projectId);
        const rows: GuiTask[] = readTasks(project.storeDir).map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          assignee: task.assignee,
          worktreeId: task.worktreeId,
          updatedAt: task.updatedAt,
        }));
        return ok(request.id, rows);
      }
      case 'gui.leases': {
        const project = knownProject(ctx, params.projectId);
        const rows: GuiLease[] = readTasks(project.storeDir)
          .filter((task) => task.status !== 'done' && task.worktreeId)
          .map((task) => ({
            id: task.id,
            projectId: project.id,
            worktreeId: task.worktreeId!,
            personaId: task.assignee,
            paths: [...task.scope],
            reason: task.title,
            expiresAt: null,
          }));
        return ok(request.id, rows);
      }
      case 'gui.sessions': {
        const project = knownProject(ctx, params.projectId);
        const rows: GuiSession[] = sessionsOf(ctx.supervisor, ctx, project.id).map((session) => ({
          id: session.id,
          projectId: session.projectId,
          worktreeId: session.worktreeId,
          personaId: session.personaId,
          vendor: session.vendor,
          vendorSessionId: session.vendorSessionId ?? null,
          status: session.status,
          startedAt: session.startedAt,
          endedAt: session.endedAt ?? null,
        }));
        return ok(request.id, rows);
      }
      case 'gui.preMerge': {
        const project = knownProject(ctx, params.projectId);
        return ok(request.id, preMergeRows(ctx, project));
      }
      case 'gui.audit': {
        const project = knownProject(ctx, params.projectId);
        return ok(request.id, auditRows(project.storeDir, limitOf(params.limit)));
      }
      case 'gui.approvals': {
        const projectId = str(params.projectId);
        if (projectId) knownProject(ctx, projectId);
        return ok(request.id, approvalRows(ctx, ctx.supervisor, projectId));
      }
      case 'gui.approve': {
        if (!ctx.supervisor) throw requestError('STORE_OFFLINE', 'supervisor is unavailable');
        const id = str(params.id);
        const decision = str(params.decision);
        if (!id || (decision !== 'approved' && decision !== 'rejected')) {
          throw new ArtinareyError('INVALID_INPUT', 'approve needs an id and a decision');
        }
        const result = await ctx.supervisor.approve(id, decision, str(params.by) ?? 'user');
        return ok(request.id, { id: result.approval.id, status: result.approval.status });
      }
      case 'gui.autoApprove': {
        const worktreeId = str(params.worktreeId);
        const enabled = bool(params.enabled);
        if (!worktreeId || enabled === undefined) {
          throw new ArtinareyError('INVALID_INPUT', 'autoApprove needs a worktree and a boolean');
        }
        const found = ctx.registry.projects.list().some((project) =>
          ctx.registry.worktrees.list(project.id).some((worktree) => worktree.id === worktreeId));
        if (!found) throw new ArtinareyError('NOT_FOUND', `unknown worktree: ${worktreeId}`);
        setAutoApprove(ctx.registry, worktreeId, enabled);
        return ok(request.id, { worktreeId, enabled });
      }
      case 'gui.stopSession': {
        if (!ctx.supervisor) throw requestError('STORE_OFFLINE', 'supervisor is unavailable');
        const id = str(params.id);
        if (!id) throw new ArtinareyError('INVALID_INPUT', 'stopSession needs an id');
        return ok(request.id, { stopped: await ctx.supervisor.stopSession(id) });
      }
      case 'gui.openProject': {
        const path = str(params.path);
        if (!path) throw new ArtinareyError('INVALID_INPUT', 'openProject needs a path');
        return ok(request.id, registerProjectAt(path, setupEnv(ctx.paths)));
      }
      case 'gui.cloneProject': {
        const url = str(params.url);
        const target = str(params.target);
        if (!url || !target) {
          throw new ArtinareyError('INVALID_INPUT', 'cloneProject needs a URL and a target folder');
        }
        return ok(request.id, cloneProjectInto(url, target, setupEnv(ctx.paths)));
      }
      case 'gui.createWorktree': {
        const project = knownProject(ctx, params.projectId);
        const branch = str(params.branch);
        if (!branch) throw new ArtinareyError('INVALID_INPUT', 'createWorktree needs a branch');
        const name = branch.startsWith('artinarey/') ? branch.slice('artinarey/'.length) : branch;
        const repoRoot = str(params.path) ? resolve(str(params.path)!) : dirname(project.repoCommonDir);
        try {
          if (resolveRepo(repoRoot).commonDir !== resolve(project.repoCommonDir)) {
            throw new ArtinareyError('INVALID_INPUT', 'path belongs to another repository');
          }
        } catch (err) {
          if (err instanceof ArtinareyError) throw err;
          throw new ArtinareyError('INVALID_INPUT', 'path is not a repository root');
        }
        const plan = planWorktree(ctx.registry, project.id, repoRoot, name);
        const worktree = coreCreateWorktree(ctx.registry, project.storeDir, plan);
        return ok(request.id, { id: worktree.id, path: worktree.path });
      }
      case 'gui.adoptWorktree': {
        const project = knownProject(ctx, params.projectId);
        const path = str(params.path);
        if (!path) throw new ArtinareyError('INVALID_INPUT', 'adoptWorktree needs a path');
        const worktree = coreAdoptWorktree(ctx.registry, project.storeDir, project.id, path);
        return ok(request.id, { id: worktree.id, path: worktree.path });
      }
      case 'gui.setHomeWorktree': {
        const project = knownProject(ctx, params.projectId);
        const personaId = str(params.personaId);
        const worktreeId = str(params.worktreeId);
        if (!personaId || !worktreeId) {
          throw new ArtinareyError('INVALID_INPUT', 'setHomeWorktree needs a persona and worktree');
        }
        const result = rehomePersona(ctx.registry, project.storeDir, personaId, worktreeId);
        if (!result.ok) throw requestError(result.code, result.message);
        return ok(request.id, { ok: true });
      }
      case 'gui.chat': {
        const project = knownProject(ctx, params.projectId);
        const message = str(params.message);
        if (!message) throw new ArtinareyError('INVALID_INPUT', 'chat needs a message');
        const sessionId = str(params.sessionId);
        if (sessionId && ctx.supervisor) {
          try {
            if (await ctx.supervisor.sendMessage(sessionId, message)) {
              return ok(request.id, {
                id: newId(), text: 'Sent to the live session.', queued: false, copiedTo: null,
              });
            }
          } catch {
            // A session that died mid-send falls back to durable mail.
          }
        }
        const personas = ctx.registry.personas.list(project.id);
        const recipient = str(params.recipient) ?? 'senior-dev';
        const record = await sendMail(project.storeDir, {
          from: 'user',
          to: [recipient],
          cc: recipient === 'senior-dev' ? [] : ['senior-dev'],
          subject: 'Window message',
          kind: 'question',
          action: 'reply in the next session',
          body: message,
        }, {
          knownPersonas: ['user', 'senior-dev', ...personas.map((persona) => persona.role)],
          role: 'user',
        });
        buildIndex(join(ctx.paths.cacheRoot, project.id, 'index.sqlite'), project.storeDir);
        return ok(request.id, {
          id: record.id,
          text: 'Queued as mail for the next session.',
          queued: true,
          copiedTo: record.cc.includes('senior-dev') ? 'senior-dev' : null,
        });
      }
      case 'gui.storage': {
        const dataRoot = loadConfig(join(ctx.paths.configDir, 'config.json')).dataRoot
          || ctx.paths.dataRoot;
        const rows = ctx.registry.projects.list().map((project) => ({
          id: project.id,
          name: project.name,
          storeDir: project.storeDir,
          bytes: dirSize(project.storeDir),
          freeBytes: storageOf(ctx, project).freeBytes,
        }));
        return ok(request.id, { dataRoot, projects: rows });
      }
      case 'gui.setStorage': {
        const dataRoot = str(params.dataRoot);
        if (!dataRoot) throw new ArtinareyError('INVALID_INPUT', 'setStorage needs an absolute path');
        const config = saveConfig(join(ctx.paths.configDir, 'config.json'), { dataRoot });
        return ok(request.id, { dataRoot: config.dataRoot || ctx.paths.dataRoot });
      }
      case 'gui.movePreflight': {
        const project = knownProject(ctx, params.projectId);
        const target = str(params.target);
        if (!target) throw new ArtinareyError('INVALID_INPUT', 'movePreflight needs a target');
        return ok(request.id, preflightMove(ctx, project.id, target));
      }
      case 'gui.moveStart': {
        const project = knownProject(ctx, params.projectId);
        const target = str(params.target);
        if (!target) throw new ArtinareyError('INVALID_INPUT', 'moveStart needs a target');
        return ok(request.id, await startMove(ctx, project.id, target));
      }
      case 'gui.moveStatus': {
        const project = knownProject(ctx, params.projectId);
        return ok(request.id, readMove(ctx, project.id));
      }
      case 'gui.moveUndo': {
        const project = knownProject(ctx, params.projectId);
        return ok(request.id, undoMove(ctx, project.id));
      }
      case 'gui.moveDeleteOld': {
        const project = knownProject(ctx, params.projectId);
        return ok(request.id, deleteOldStore(ctx, project.id));
      }
      default:
        return fail(request.id, 'NOT_FOUND', `unknown method: ${request.method}`);
    }
  } catch (err) {
    return failure(request.id, err);
  }
}
