import type {
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

export type GuiApi = {
  projects(): Promise<GuiProject[]>;
  personas(projectId: string): Promise<GuiPersona[]>;
  worktrees(projectId: string): Promise<GuiWorktree[]>;
  mail(query: MailQuery): Promise<GuiMail[]>;
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

/** Every GUI method returns a row array; anything else is a malformed reply. */
function unwrap<T>(reply: unknown): T {
  let result: unknown;
  if (Array.isArray(reply)) {
    result = reply;
  } else if (!reply || typeof reply !== 'object') {
    throw malformedReply;
  } else {
    const envelope = reply as Envelope<T> & { result?: unknown; error?: unknown };
    if (envelope.ok === true) {
      if (!('result' in envelope)) throw malformedReply;
      result = envelope.result;
    } else {
      const error = typedError(envelope.error);
      if (error) throw error;
      if (envelope.ok === false) throw malformedReply;
      result = reply;
    }
  }
  if (!Array.isArray(result)) throw malformedReply;
  return result as T;
}

/** The webview knows exactly one command and four read-only methods. */
export function createApi(invokeFn: InvokeFn): GuiApi {
  async function call<T>(args: CallArgs): Promise<T> {
    let reply: unknown;
    try {
      reply = await invokeFn('daemon_call', args);
    } catch (err) {
      throw typedError(err) ?? {
        code: 'INTERNAL_ERROR',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return unwrap<T>(reply);
  }

  return {
    projects(): Promise<GuiProject[]> {
      return call<GuiProject[]>({ method: 'gui.projects', params: {} });
    },
    personas(projectId: string): Promise<GuiPersona[]> {
      return call<GuiPersona[]>({ method: 'gui.personas', params: { projectId } });
    },
    worktrees(projectId: string): Promise<GuiWorktree[]> {
      return call<GuiWorktree[]>({ method: 'gui.worktrees', params: { projectId } });
    },
    mail(query: MailQuery): Promise<GuiMail[]> {
      return call<GuiMail[]>({ method: 'gui.mail', params: { ...query } });
    },
  };
}
