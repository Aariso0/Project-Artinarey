import type {
  GuiMail, GuiPersona, GuiProject, GuiWorktree,
} from '../../../packages/daemon/src/gui.ts';
export type {
  GuiMail, GuiPersona, GuiProject, GuiWorktree,
} from '../../../packages/daemon/src/gui.ts';

export type DaemonError = { code: string; message: string };

type Envelope<T> = { ok: true; result: T } | { ok: false; error: DaemonError };

export type InvokeFn = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export type MailQuery = {
  projectId: string;
  recipient?: string;
  thread?: string;
  limit?: number;
};

export type GuiTask = {
  id: string; title: string; status: string; assignee: string | null;
  worktreeId: string | null; updatedAt: string;
};

export type GuiLease = {
  id: string; projectId: string; worktreeId: string; personaId: string;
  paths: string[]; reason: string; expiresAt: string | null;
};

export type GuiSession = {
  id: string; projectId: string; worktreeId: string; personaId: string;
  vendor: string; vendorSessionId: string | null; status: string;
  startedAt: string; endedAt: string | null;
};

export type GuiPreMerge = {
  id: string; worktreeId: string; status: string; summary: string; checkedAt: string;
};

export type GuiAudit = { id: string; at: string; type: string; text: string };

export type GuiApproval = {
  id: string; projectId: string; kind: string; summary: string; status: string;
  worktreeId: string | null; requestedAt: string;
};

export type GuiChatReply = { id: string; text: string; queued: boolean; copiedTo: string | null };

export type GuiStorage = {
  dataRoot: string;
  projects: Array<{ id: string; name: string; storeDir: string; bytes: number; freeBytes: number }>;
};

export type GuiMovePhase =
  | 'idle' | 'preflight' | 'paused' | 'copying' | 'verifying' | 'switching'
  | 'rebuilding' | 'resuming' | 'done' | 'undo' | 'offline';

export type GuiMoveStatus = {
  phase: GuiMovePhase; projectId: string; source: string; target: string;
  bytesCopied: number; bytesTotal: number; verified: boolean; error: string | null;
  startedAt: string | null; updatedAt: string | null;
};

export type GuiApi = {
  projects(): Promise<GuiProject[]>;
  personas(projectId: string): Promise<GuiPersona[]>;
  worktrees(projectId: string): Promise<GuiWorktree[]>;
  mail(query: MailQuery): Promise<GuiMail[]>;
  tasks(projectId: string): Promise<GuiTask[]>;
  leases(projectId: string): Promise<GuiLease[]>;
  sessions(projectId: string): Promise<GuiSession[]>;
  preMerge(projectId: string): Promise<GuiPreMerge[]>;
  audit(projectId: string, limit?: number): Promise<GuiAudit[]>;
  approvals(projectId?: string): Promise<GuiApproval[]>;
  approve(id: string, decision: 'approved' | 'rejected', by: string): Promise<{ id: string; status: string }>;
  autoApprove(worktreeId: string, enabled: boolean): Promise<{ worktreeId: string; enabled: boolean }>;
  stopSession(id: string): Promise<{ stopped: boolean }>;
  createWorktree(projectId: string, branch: string, path?: string): Promise<{ id: string; path: string }>;
  adoptWorktree(projectId: string, path: string): Promise<{ id: string; path: string }>;
  setHomeWorktree(projectId: string, personaId: string, worktreeId: string): Promise<{ ok: true }>;
  chat(projectId: string, message: string, recipient?: string, sessionId?: string): Promise<GuiChatReply>;
  storage(): Promise<GuiStorage>;
  setStorage(dataRoot: string): Promise<{ dataRoot: string }>;
  movePreflight(projectId: string, target: string): Promise<GuiMoveStatus>;
  moveStart(projectId: string, target: string): Promise<GuiMoveStatus>;
  moveStatus(projectId: string): Promise<GuiMoveStatus>;
  moveUndo(projectId: string): Promise<GuiMoveStatus>;
  moveDeleteOld(projectId: string): Promise<{ deleted: boolean }>;
};

type CallArgs = { method: string; params: Record<string, unknown> };

const malformedReply: DaemonError = { code: 'BAD_RESPONSE', message: 'malformed daemon reply' };

function typedError(value: unknown): DaemonError | undefined {
  if (!value || typeof value !== 'object' || !('code' in value) || !('message' in value)) {
    return undefined;
  }
  const error = value as { code: unknown; message: unknown };
  if (typeof error.code !== 'string' || typeof error.message !== 'string') return undefined;
  return { code: error.code, message: error.message };
}

type PayloadShape = 'array' | 'object';

function isShape(value: unknown, shape: PayloadShape): boolean {
  return shape === 'array'
    ? Array.isArray(value)
    : Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A reply is either a bare payload from the native command or an ok/envelope.
 * Every method declares the payload shape it expects: a wrong-shaped reply is a
 * typed error, never an empty result that could be mistaken for real state.
 */
function unwrap<T>(reply: unknown, shape: PayloadShape): T {
  let result: unknown;
  if (Array.isArray(reply) || (reply && typeof reply === 'object')) {
    const envelope = reply as Envelope<T> & { result?: unknown; error?: unknown };
    if (envelope.ok === false) {
      const error = typedError(envelope.error);
      if (error) throw error;
      throw malformedReply;
    } else if (envelope.ok === true && 'result' in envelope) {
      result = envelope.result;
    } else {
      // A bare payload may itself carry `ok: true` (for example setHomeWorktree).
      result = reply;
    }
  } else {
    throw malformedReply;
  }
  if (!isShape(result, shape)) throw malformedReply;
  return result as T;
}

/** The webview knows exactly one command; every feature is a method on it. */
export function createApi(invokeFn: InvokeFn): GuiApi {
  async function call<T>(args: CallArgs, shape: PayloadShape): Promise<T> {
    let reply: unknown;
    try {
      reply = await invokeFn('daemon_call', args);
    } catch (err) {
      throw typedError(err) ?? {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return unwrap<T>(reply, shape);
  }

  const get = <T>(method: string, params: Record<string, unknown> = {}, shape: PayloadShape = 'object') =>
    call<T>({ method: `gui.${method}`, params }, shape);

  return {
    projects: () => get<GuiProject[]>('projects', {}, 'array'),
    personas: (projectId) => get<GuiPersona[]>('personas', { projectId }, 'array'),
    worktrees: (projectId) => get<GuiWorktree[]>('worktrees', { projectId }, 'array'),
    mail: (query) => get<GuiMail[]>('mail', { ...query }, 'array'),
    tasks: (projectId) => get<GuiTask[]>('tasks', { projectId }, 'array'),
    leases: (projectId) => get<GuiLease[]>('leases', { projectId }, 'array'),
    sessions: (projectId) => get<GuiSession[]>('sessions', { projectId }, 'array'),
    preMerge: (projectId) => get<GuiPreMerge[]>('preMerge', { projectId }, 'array'),
    audit: (projectId, limit) => get<GuiAudit[]>('audit', { projectId, ...(limit ? { limit } : {}) }, 'array'),
    approvals: (projectId) => get<GuiApproval[]>('approvals', projectId ? { projectId } : {}, 'array'),
    approve: (id, decision, by) => get('approve', { id, decision, by }),
    autoApprove: (worktreeId, enabled) => get('autoApprove', { worktreeId, enabled }),
    stopSession: (id) => get('stopSession', { id }),
    createWorktree: (projectId, branch, path) =>
      get('createWorktree', { projectId, branch, ...(path ? { path } : {}) }),
    adoptWorktree: (projectId, path) => get('adoptWorktree', { projectId, path }),
    setHomeWorktree: (projectId, personaId, worktreeId) =>
      get('setHomeWorktree', { projectId, personaId, worktreeId }),
    chat: (projectId, message, recipient, sessionId) =>
      get('chat', {
        projectId, message,
        ...(recipient ? { recipient } : {}), ...(sessionId ? { sessionId } : {}),
      }),
    storage: () => get<GuiStorage>('storage'),
    setStorage: (dataRoot) => get('setStorage', { dataRoot }),
    movePreflight: (projectId, target) => get('movePreflight', { projectId, target }),
    moveStart: (projectId, target) => get('moveStart', { projectId, target }),
    moveStatus: (projectId) => get('moveStatus', { projectId }),
    moveUndo: (projectId) => get('moveUndo', { projectId }),
    moveDeleteOld: (projectId) => get('moveDeleteOld', { projectId }),
  };
}
