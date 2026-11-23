import type { ArtinareyErrorCode } from './errors.ts';

export type ToolReply = { text: string; isError: boolean };

/** plan.md §18: what the agent is told for each error code. */
const INSTRUCTION: Record<ArtinareyErrorCode, string> = {
  NO_PROJECT: 'Stop. Tell the user to run artinarey init.',
  WORKTREE_UNMANAGED: 'Stop. Tell the user to adopt this worktree.',
  DIRECTORY_BUSY: 'Stop. Tell the user; do not retry.',
  NEEDS_CONFIRMATION: 'Ask the user, then repeat with confirm_move=true.',
  FORBIDDEN_ROLE: 'Do not retry.',
  LEASE_OVERLAP: 'Senior dev: re-scope. Others: ask the senior dev.',
  CAP_REACHED: 'Wait for the user. Do not retry.',
  PROJECT_PAUSED: 'Stop. Do not retry before retry_after.',
  STORE_OFFLINE: 'Stop. Tell the user the store is unavailable.',
  MAIL_REJECTED: 'Fix and resend once.',
  NOT_FOUND: 'Do not guess; call inbox.',
  INVALID_INPUT: 'Stop. Fix the arguments and retry.',
  ALREADY_RUNNING: 'Stop. The daemon is already running.',
  INDEX_ERROR: 'Stop. Rebuild with artinarey reindex.',
};

const NEXT: Record<ArtinareyErrorCode, string> = {
  NO_PROJECT: 'run artinarey init',
  WORKTREE_UNMANAGED: 'adopt this worktree',
  DIRECTORY_BUSY: 'tell the user',
  NEEDS_CONFIRMATION: 'ask the user',
  FORBIDDEN_ROLE: 'stop',
  LEASE_OVERLAP: 'ask the senior dev',
  CAP_REACHED: 'wait for the user',
  PROJECT_PAUSED: 'wait for retry_after',
  STORE_OFFLINE: 'tell the user',
  MAIL_REJECTED: 'fix and resend',
  NOT_FOUND: 'inbox',
  INVALID_INPUT: 'fix the arguments',
  ALREADY_RUNNING: 'stop',
  INDEX_ERROR: 'run artinarey reindex',
};

/** Every successful tool reply is short and ends with unread/next. */
export function ok(body: string, unread: number, next: string): ToolReply {
  return {
    text: `${body.replace(/\s+$/, '')}\nunread: ${unread}\nnext: ${next}`,
    isError: false,
  };
}

/** Errors say stop or retry-after, and still end with unread/next. */
export function fail(
  code: ArtinareyErrorCode,
  message: string,
  retryAfter?: string,
): ToolReply {
  const retry = code === 'PROJECT_PAUSED' || code === 'CAP_REACHED'
    ? `\nretry_after: ${retryAfter ?? 'unknown'}`
    : '';
  return {
    text: `${code}: ${message}\n${INSTRUCTION[code]}${retry}\nunread: 0\nnext: ${NEXT[code]}`,
    isError: true,
  };
}
