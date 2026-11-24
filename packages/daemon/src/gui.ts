import { existsSync, realpathSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  getAutoApprove, listGitWorktrees, queryMail, readSessions, sessionLogFile,
  type Project, type SessionSummary,
} from '@artinarey/core';
import type { RpcRequest, RpcResponse } from './server.ts';
import type { SessionSupervisor } from './sessions.ts';
import type { RpcContext } from './tools.ts';

export type GuiProject = {
  id: string;
  name: string;
  storeDir: string;
  bytes: number;
  freeBytes: number;
  status: 'active' | 'offline';
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

function ok(id: string, result: unknown): RpcResponse {
  return { id, ok: true, result };
}

function fail(id: string, code: string, message: string): RpcResponse {
  return { id, ok: false, error: { code, message } };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function paramsOf(request: RpcRequest): Record<string, unknown> {
  return request.params && typeof request.params === 'object' && !Array.isArray(request.params)
    ? request.params as Record<string, unknown> : {};
}

function projectsOf(ctx: RpcContext, projectId?: string): Project[] {
  const projects = ctx.registry.projects.list();
  return projectId ? projects.filter((project) => project.id === projectId) : projects;
}

/** The cache path must come from a registered project, never from a webview string. */
function knownProject(ctx: RpcContext, projectId?: string): Project | undefined {
  if (!projectId) return undefined;
  return ctx.registry.projects.list().find((project) => project.id === projectId);
}

function storageOf(project: Project): Pick<GuiProject, 'bytes' | 'freeBytes' | 'status'> {
  if (!existsSync(project.storeDir)) return { bytes: 0, freeBytes: 0, status: 'offline' };
  try {
    const stats = statfsSync(project.storeDir);
    return {
      bytes: stats.bsize * stats.blocks,
      freeBytes: stats.bsize * stats.bavail,
      status: 'active',
    };
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

function gitFlags(project: Project): Map<string, { locked: boolean; prunable: boolean }> {
  const flags = new Map<string, { locked: boolean; prunable: boolean }>();
  try {
    for (const entry of listGitWorktrees(project.repoCommonDir)) {
      flags.set(canonical(entry.path), { locked: entry.locked, prunable: entry.prunable });
    }
  } catch {
    // Git metadata is optional for this read-only view; absent means neither flag is set.
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

/** Read-only snapshot methods for the desktop window. No agent tool is reachable here. */
export async function handleGuiRequest(request: RpcRequest, ctx: RpcContext): Promise<RpcResponse> {
  if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
    return fail('invalid', 'INVALID_REQUEST', 'invalid request');
  }
  if (!request.method.startsWith('gui.')) {
    return fail(request.id, 'FORBIDDEN_METHOD', `method not allowed on the GUI surface: ${request.method}`);
  }
  const params = paramsOf(request);
  const projectId = str(params.projectId);

  try {
    switch (request.method) {
      case 'gui.projects': {
        const rows: GuiProject[] = ctx.registry.projects.list().map((project) => ({
          id: project.id,
          name: project.name,
          storeDir: project.storeDir,
          ...storageOf(project),
        }));
        return ok(request.id, rows);
      }
      case 'gui.personas': {
        const rows: GuiPersona[] = [];
        for (const project of projectsOf(ctx, projectId)) {
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
        for (const project of projectsOf(ctx, projectId)) {
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
        const project = knownProject(ctx, projectId);
        if (!project) return fail(request.id, 'INVALID_REQUEST', 'gui.mail needs a known projectId');
        const recipient = str(params.recipient);
        const thread = str(params.thread);
        const query: { recipient?: string; thread?: string } = {};
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
      default:
        return fail(request.id, 'NOT_FOUND', `unknown method: ${request.method}`);
    }
  } catch (err) {
    return fail(request.id, 'INTERNAL_ERROR', err instanceof Error ? err.message : 'request failed');
  }
}
