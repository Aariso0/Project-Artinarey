import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  approvalFingerprint, appendSession, ArtinareyError, buildFirstPrompt, claimPersona,
  createApproval, endSession, getAutoApprove, isProcessAlive, newId, pendingApproval, readApprovals,
  readPersona, readRoleCard, readSessions, readTasks, resolveApproval,
  resolveIdentity, riskyReasons, rollbackFailedClaim, sessionLogFile, setAutoApprove,
  updateTask, type Approval, type ApprovalKind, type ArtinareyErrorCode, type Identity,
  type Registry, type SessionSummary, type XdgPaths,
} from '@artinarey/core';

/**
 * The daemon is the only component that launches processes. The senior dev
 * requests a session through a tool; every spawn check (lease, worktree, cap,
 * pending work, approval) happens here, never in an agent. Supervisor state is
 * derived from the registry plus append-only files, so a daemon restart can
 * re-adopt live sessions and mark dead ones failed.
 */

export type SpawnRequest = {
  role?: string;
  persona_id?: string;
  task_id: string;
  vendor?: string;
  worktree_id?: string;
};

export type SpawnResult =
  | { ok: true; session: SessionSummary; vendorSessionId: string; message: string }
  | { ok: false; code: ArtinareyErrorCode; approvalId?: string; message: string };

export type PermissionRequest = {
  projectId: string;
  worktreeId: string;
  sessionId: string;
  action?: string;
  resources?: string[];
  command?: string;
};

export type PermissionDecision = {
  effect: 'allow' | 'ask' | 'deny';
  message?: string;
  approvalId?: string;
};

type ServeState = { pid: number; port: number; password: string; startedAt: string };

/** The subset of OpencodeAdapter the supervisor needs; lets tests inject a fake. */
export type SessionAdapter = {
  ensureServe(): Promise<ServeState>;
  createSession(state: ServeState, directory: string): Promise<string>;
  sendPrompt(state: ServeState, sessionId: string, text: string, id?: string): Promise<void>;
  interrupt(state: ServeState, sessionId: string): Promise<void>;
  interruptSession(sessionId: string): Promise<void>;
};

export type Notifier = (message: string) => void;
export type TimerApi = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

export type SupervisorOptions = {
  registry: Registry;
  paths: XdgPaths;
  adapter: SessionAdapter;
  rolesDir: string;
  spawnCap?: number;
  notifier?: Notifier;
  timers?: TimerApi;
};

/** Test seam: the async error listener must exist before unref, or ENOENT kills the daemon. */
export function spawnNotifier(message: string): ChildProcess {
  const child = spawn('/usr/bin/notify-send', ['Artinarey', message], {
    stdio: 'ignore', detached: true,
  });
  child.on('error', () => {
    // A missing desktop notifier must never block an agent or an approval.
  });
  child.unref();
  return child;
}

export const defaultNotifier: Notifier = (message) => {
  try {
    spawnNotifier(message);
  } catch {
    // Synchronous spawn failures are equally non-fatal.
  }
};

const defaultTimers: TimerApi = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function fail(code: ArtinareyErrorCode, message: string, approvalId?: string): SpawnResult {
  return { ok: false, code, message, ...(approvalId ? { approvalId } : {}) };
}

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export class SessionSupervisor {
  private readonly registry: Registry;
  private readonly paths: XdgPaths;
  private readonly adapter: SessionAdapter;
  private readonly rolesDir: string;
  private readonly spawnCap: number;
  private readonly notify: Notifier;
  private readonly timers: TimerApi;
  private readonly reminders = new Map<string, unknown[]>();
  /** In-flight launches reserve capacity and persona ownership before any await. */
  private readonly reservedByProject = new Map<string, number>();
  private readonly reservedPersonas = new Set<string>();
  /** Reservations kept after an unconfirmed vendor cleanup stay owned by the session. */
  private readonly heldBySession = new Map<string, { projectId: string; personaId: string }>();

  constructor(options: SupervisorOptions) {
    this.registry = options.registry;
    this.paths = options.paths;
    this.adapter = options.adapter;
    this.rolesDir = options.rolesDir;
    this.spawnCap = options.spawnCap ?? 3;
    this.notify = options.notifier ?? defaultNotifier;
    this.timers = options.timers ?? defaultTimers;
  }

  private storeOf(projectId: string): string {
    const project = this.registry.projects.get(projectId);
    if (!project) throw new ArtinareyError('NOT_FOUND', `unknown project: ${projectId}`);
    return project.storeDir;
  }

  private summaryFile(projectId: string): string {
    return sessionLogFile(this.paths.cacheRoot, projectId);
  }

  private reserve(projectId: string, personaId: string): void {
    this.reservedByProject.set(projectId, (this.reservedByProject.get(projectId) ?? 0) + 1);
    this.reservedPersonas.add(personaId);
  }

  private releaseReservation(projectId: string, personaId: string): void {
    const remaining = (this.reservedByProject.get(projectId) ?? 0) - 1;
    if (remaining > 0) this.reservedByProject.set(projectId, remaining);
    else this.reservedByProject.delete(projectId);
    this.reservedPersonas.delete(personaId);
  }

  private boundWorktree(personaId: string): { id: string; path: string } | undefined {
    for (const project of this.registry.projects.list()) {
      for (const worktree of this.registry.worktrees.list(project.id)) {
        if (this.registry.bindings.forWorktree(worktree.id)?.id === personaId) {
          return { id: worktree.id, path: worktree.path };
        }
      }
    }
    return undefined;
  }

  /** Dead handles are failed once at startup; live ones keep their registry session. */
  adopt(): void {
    for (const project of this.registry.projects.list()) {
      const file = this.summaryFile(project.id);
      for (const session of readSessions(file)) {
        if (session.status !== 'running') continue;
        if (isProcessAlive(session.pid)) continue;
        endSession(file, session.id, 'failed');
        this.registry.sessions.end(session.id, new Date().toISOString());
      }
    }
  }

  sessions(projectId: string): SessionSummary[] {
    const file = this.summaryFile(projectId);
    const summaries = readSessions(file);
    const ended = new Set(this.registry.sessions.list(projectId)
      .filter((session) => session.endedAt).map((session) => session.id));
    let reconciled = false;
    for (const summary of summaries) {
      // Only a registry-ended session is authoritative; no agent-exit guess here.
      if (summary.status === 'running' && ended.has(summary.id)) {
        endSession(file, summary.id, 'failed');
        reconciled = true;
      }
    }
    return reconciled ? readSessions(file) : summaries;
  }

  liveCount(projectId: string): number {
    return this.registry.sessions.list(projectId).filter((session) => !session.endedAt).length
      + (this.reservedByProject.get(projectId) ?? 0);
  }

  approvals(projectId?: string): Approval[] {
    const projects = projectId
      ? this.registry.projects.list().filter((p) => p.id === projectId)
      : this.registry.projects.list();
    return projects.flatMap((p) => readApprovals(p.storeDir));
  }

  /** Approval decisions are user actions; the CLI is the only caller. */
  async approve(
    id: string,
    decision: 'approved' | 'rejected',
    by = 'user',
  ): Promise<{ approval: Approval; spawn?: SpawnResult }> {
    const approval = this.approvals().find((a) => a.id === id);
    if (!approval) throw new ArtinareyError('NOT_FOUND', `unknown approval: ${id}`);
    const resolved = resolveApproval(this.storeOf(approval.projectId), id, decision, by);
    for (const handle of this.reminders.get(id) ?? []) this.timers.clear(handle);
    this.reminders.delete(id);
    const result: { approval: Approval; spawn?: SpawnResult } = { approval: resolved };
    if (decision === 'approved' && resolved.kind === 'spawn_cap' && resolved.payload) {
      const caller = this.callerFromPayload(resolved);
      result.spawn = await this.requestSession(caller, resolved.payload as unknown as SpawnRequest,
        { approved: true });
    }
    return result;
  }

  private callerFromPayload(approval: Approval): Identity {
    const payload = approval.payload ?? {};
    const personaId = String(payload.caller_persona_id ?? '');
    const worktreeId = String(payload.caller_worktree_id ?? '');
    const persona = this.registry.personas.get(personaId);
    const worktree = this.registry.worktrees.list(approval.projectId)
      .find((wt) => wt.id === worktreeId);
    if (!persona || !worktree) {
      throw new ArtinareyError('NOT_FOUND', 'the approving session context no longer exists');
    }
    return {
      projectId: approval.projectId,
      worktreeId: worktree.id,
      markerDir: worktree.path,
      storeDir: this.storeOf(approval.projectId),
      personaId: persona.id,
      role: persona.role,
    };
  }

  toggle(worktreeId: string, enabled: boolean): void {
    let found = false;
    for (const project of this.registry.projects.list()) {
      if (this.registry.worktrees.list(project.id).some((wt) => wt.id === worktreeId)) {
        setAutoApprove(this.registry, worktreeId, enabled);
        found = true;
        break;
      }
    }
    if (!found) throw new ArtinareyError('NOT_FOUND', `unknown worktree: ${worktreeId}`);
  }

  isAutoApprove(worktreeId: string): boolean {
    return getAutoApprove(this.registry, worktreeId);
  }

  /** The shim/plugin hook asks the daemon for the decision and audit trail. */
  evaluatePermission(input: PermissionRequest): PermissionDecision {
    const worktree = this.registry.worktrees.list(input.projectId)
      .find((wt) => wt.id === input.worktreeId);
    if (!worktree) return { effect: 'deny', message: 'unknown worktree for this session' };
    const root = resolve(worktree.path);
    const resources = input.resources ?? [];
    const outside = resources.filter((resource) => {
      const target = resolve(isAbsolute(resource) ? resource : join(root, resource));
      return !inside(root, target);
    });
    const reasons = riskyReasons(input.command ?? '', worktree.path);
    if (outside.length > 0) reasons.push(`outside worktree: ${outside.join(', ')}`);
    if (reasons.length === 0) return { effect: 'allow' };
    if (this.isAutoApprove(worktree.id)
        && !reasons.some((reason) => reason.includes('outside worktree'))) {
      return { effect: 'allow' };
    }
    const storeDir = this.storeOf(input.projectId);
    const fingerprint = approvalFingerprint({
      projectId: input.projectId,
      worktreeId: worktree.id,
      action: input.action,
      resources,
      command: input.command,
      sessionId: input.sessionId,
    });
    const key = { projectId: input.projectId, kind: 'risky_call' as ApprovalKind,
      worktreeId: worktree.id, fingerprint };
    const existing = pendingApproval(storeDir, key);
    const summary = `${worktree.path} [sessionId=${input.sessionId} action=${input.action ?? ''} resources=${JSON.stringify(resources)} command=${input.command ?? ''}]: ${reasons.join('; ')}`;
    const approval = existing ?? createApproval(storeDir, {
      ...key,
      id: newId(),
      summary,
      payload: {
        action: input.action ?? '',
        resources: [...resources],
        command: input.command ?? '',
        sessionId: input.sessionId,
      },
    });
    if (!existing) this.schedule(approval.id, summary);
    return {
      effect: 'ask',
      approvalId: approval.id,
      message: `Waiting for user approval ${approval.id}: ${reasons.join('; ')}`,
    };
  }

  private schedule(id: string, summary: string): void {
    this.notify(`Approval needed: ${summary} (artinarey approve ${id})`);
    const handles = [5 * 60_000, 15 * 60_000].map((ms) => this.timers.set(() => {
      const stillPending = this.approvals().some((a) => a.id === id && a.status === 'pending');
      if (stillPending) this.notify(`Approval still waiting: ${id} — ${summary}`);
    }, ms));
    this.reminders.set(id, handles);
  }

  /** Escalate a blocked spawn to the user; agents cannot self-approve. */
  private blockingApproval(
    input: SpawnRequest,
    caller: Identity,
    kind: 'active_worktree' | 'pending_work',
    summary: string,
  ): SpawnResult {
    const storeDir = this.storeOf(caller.projectId);
    const key = { projectId: caller.projectId, kind, worktreeId: input.worktree_id ?? null };
    const existing = pendingApproval(storeDir, key);
    const approval = existing ?? createApproval(storeDir, {
      ...key,
      id: newId(),
      personaId: input.persona_id ?? input.role ?? null,
      summary,
      payload: { ...input, caller_persona_id: caller.personaId,
        caller_worktree_id: caller.worktreeId },
    });
    if (!existing) this.schedule(approval.id, summary);
    return fail('NEEDS_CONFIRMATION',
      `Only the user may approve this session (approval ${approval.id}): ${summary}`, approval.id);
  }

  async requestSession(
    caller: Identity,
    input: SpawnRequest,
    options: { approved?: boolean } = {},
  ): Promise<SpawnResult> {
    if (caller.role !== 'senior-dev') {
      return fail('FORBIDDEN_ROLE', 'only the senior dev may request sessions');
    }
    const storeDir = this.storeOf(caller.projectId);
    const task = readTasks(storeDir).find((t) => t.id === input.task_id);
    if (!task) return fail('NOT_FOUND', `no task with id ${input.task_id}`);
    if (task.status === 'done' || task.scope.length === 0) {
      return fail('INVALID_INPUT', 'task has no active lease');
    }
    const worktrees = this.registry.worktrees.list(caller.projectId);
    const worktree = (input.worktree_id
      ? worktrees.find((wt) => wt.id === input.worktree_id)
      : worktrees.find((wt) => wt.id === task.worktreeId)
        ?? worktrees.find((wt) => wt.branch === task.branch)
        ?? worktrees.find((wt) => wt.id === caller.worktreeId));
    if (!worktree) return fail('NOT_FOUND', 'task has no registered worktree');
    if (input.worktree_id) {
      if (task.worktreeId && worktree.id !== task.worktreeId) {
        return fail('INVALID_INPUT', 'explicit worktree does not match the task lease');
      }
      if (!task.worktreeId && task.branch && worktree.branch !== task.branch) {
        return fail('INVALID_INPUT', 'explicit worktree does not match the task branch');
      }
    }
    updateTask(storeDir, task.id, { worktreeId: worktree.id });

    const personas = this.registry.personas.list(caller.projectId);
    const persona = (input.persona_id
      ? personas.find((p) => p.id === input.persona_id)
      : personas.find((p) => p.role === input.role));
    if (!persona) return fail('NOT_FOUND', `unknown persona: ${input.persona_id ?? input.role}`);

    const bound = this.registry.bindings.forWorktree(worktree.id);
    if (bound && bound.id !== persona.id) {
      return this.blockingApproval(input, caller, 'active_worktree',
        `${worktree.path} is active as ${bound.role}; stop or release it first`);
    }
    const pending = readTasks(storeDir).some((t) => t.worktreeId === worktree.id
      && t.status !== 'done' && t.assignee !== persona.role);
    if (pending) {
      return this.blockingApproval(input, caller, 'pending_work',
        `${worktree.path} has pending work for another persona`);
    }
    const liveElsewhere = this.registry.sessions.list(caller.projectId)
      .some((session) => !session.endedAt && session.personaId === persona.id)
      || this.reservedPersonas.has(persona.id);
    if (liveElsewhere) return fail('DIRECTORY_BUSY', `${persona.role} already has a live session`);

    if (!options.approved && this.liveCount(caller.projectId) >= this.spawnCap) {
      const store = this.storeOf(caller.projectId);
      const existing = pendingApproval(store, { projectId: caller.projectId, kind: 'spawn_cap' });
      const approval = existing ?? createApproval(store, {
        id: newId(), projectId: caller.projectId, kind: 'spawn_cap',
        worktreeId: worktree.id, personaId: persona.id,
        summary: `Spawn cap ${this.spawnCap} reached; ${persona.role} waits for user approval`,
        payload: { ...input, caller_persona_id: caller.personaId,
          caller_worktree_id: caller.worktreeId },
      });
      if (!existing) this.schedule(approval.id, approval.summary);
      return fail('CAP_REACHED',
        `Spawn cap ${this.spawnCap} reached (token consumption rises with parallel sessions). Approval ${approval.id} is pending.`,
        approval.id);
    }

    const target = resolveIdentity(this.registry, worktree.path);
    if (!target.ok) return fail(target.code, target.message);

    // Snapshot first: claimPersona may bind, lock and write persona state before
    // its audit append throws. The same snapshot restores a failed launch.
    const previousBinding = this.registry.bindings.forWorktree(target.identity.worktreeId)?.id;
    const previousState = readPersona(storeDir, persona.id);
    const originalWorktree = this.boundWorktree(persona.id);
    this.reserve(caller.projectId, persona.id);
    let reservationHeld = true;
    const release = () => {
      if (!reservationHeld) return;
      reservationHeld = false;
      this.releaseReservation(caller.projectId, persona.id);
    };
    const rollbackClaim = () => {
      try {
        rollbackFailedClaim(this.registry, target.identity, persona.id,
          previousBinding, previousState, originalWorktree, false);
      } catch {
        // Rollback itself must never mask the original failure.
      }
    };

    // The senior dev is exempt from the home-worktree confirmation (plan.md §6).
    let claim;
    try {
      claim = claimPersona(this.registry, storeDir, target.identity, {
        personaId: persona.id, confirmMove: true,
      });
    } catch (err) {
      rollbackClaim();
      release();
      return fail('STORE_OFFLINE', `spawn failed: ${(err as Error).message ?? String(err)}`);
    }
    if (!claim.ok) {
      rollbackClaim();
      release();
      return fail(claim.code, claim.message);
    }

    let sessionId: string | undefined;
    let vendorSessionId: string | undefined;
    let summary: SessionSummary | undefined;
    let summaryAppended = false;
    try {
      const serve = await this.adapter.ensureServe();
      sessionId = this.registry.sessions.append({
        projectId: caller.projectId,
        worktreeId: worktree.id,
        personaId: persona.id,
        vendor: input.vendor ?? 'opencode',
        startedAt: new Date().toISOString(),
        createdBinding: !bound,
      });
      const logFile = join(this.paths.cacheRoot, 'logs', `${sessionId}.log`);
      summary = {
        id: sessionId,
        projectId: caller.projectId,
        worktreeId: worktree.id,
        personaId: persona.id,
        vendor: input.vendor ?? 'opencode',
        vendorSessionId: null,
        pid: serve.pid,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: 'running',
        logFile,
      };
      vendorSessionId = await this.adapter.createSession(serve, worktree.path);
      summary.vendorSessionId = vendorSessionId;
      appendSession(this.summaryFile(caller.projectId), summary);
      summaryAppended = true;
      mkdirSync(join(this.paths.cacheRoot, 'logs'), { recursive: true });
      const handoffFile = join(storeDir, 'personas', persona.id, 'handoff.md');
      const prompt = buildFirstPrompt({
        role: persona.role,
        roleCard: readRoleCard(this.rolesDir, persona.role),
        handoff: existsSync(handoffFile) ? readFileSync(handoffFile, 'utf8').trim() : '',
        task: { id: task.id, title: task.title, scope: task.scope, body: '' },
      });
      appendFileSync(logFile, `> first prompt (session ${vendorSessionId})\n${prompt}\n`);
      await this.adapter.sendPrompt(serve, vendorSessionId, prompt, `${sessionId}-first`);
      this.registry.personas.setVendor(persona.id, summary.vendor, vendorSessionId);
      release();
      return {
        ok: true,
        session: summary,
        vendorSessionId,
        message: `Started ${persona.role} in ${worktree.path} (session ${vendorSessionId}).`,
      };
    } catch (err) {
      // A vendor session created before the failure must be reconciled first;
      // an unconfirmed interrupt leaves the execution visible and owned.
      let cleanupConfirmed = true;
      if (vendorSessionId) {
        try {
          await this.adapter.interruptSession(vendorSessionId);
        } catch {
          cleanupConfirmed = false;
        }
      }
      if (cleanupConfirmed) {
        try { if (sessionId) this.registry.sessions.end(sessionId, new Date().toISOString()); } catch { /* best effort */ }
        try {
          if (sessionId && summary && summaryAppended) {
            endSession(this.summaryFile(caller.projectId), sessionId, 'failed');
          }
        } catch { /* best effort */ }
        rollbackClaim();
        release();
      } else {
        try {
          if (summary && !summaryAppended) {
            appendSession(this.summaryFile(caller.projectId), summary);
            summaryAppended = true;
          }
        } catch { /* registry row already keeps the launch visible */ }
        if (sessionId) {
          this.heldBySession.set(sessionId, { projectId: caller.projectId, personaId: persona.id });
        }
      }
      return fail('STORE_OFFLINE', `spawn failed: ${(err as Error).message ?? String(err)}`);
    }
  }

  async stopSession(id: string): Promise<boolean> {
    const summaries = this.registry.projects.list()
      .flatMap((project) => readSessions(this.summaryFile(project.id)));
    const session = summaries.find((s) => s.id === id && s.status === 'running');
    if (!session) return false;
    if (session.vendorSessionId) {
      try {
        await this.adapter.interruptSession(session.vendorSessionId);
      } catch {
        return false;
      }
    }
    endSession(this.summaryFile(session.projectId), id, 'stopped');
    this.registry.sessions.end(id, new Date().toISOString());
    const held = this.heldBySession.get(id);
    if (held) {
      this.releaseReservation(held.projectId, held.personaId);
      this.heldBySession.delete(id);
    }
    return true;
  }
}
