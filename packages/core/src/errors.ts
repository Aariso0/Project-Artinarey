export type ArtinareyErrorCode =
  | 'INVALID_INPUT'
  | 'STORE_OFFLINE'
  | 'MAIL_REJECTED'
  | 'NOT_FOUND'
  | 'ALREADY_RUNNING'
  | 'INDEX_ERROR'
  // plan.md §18 — surfaced to agents through the tool reply formatter.
  | 'NO_PROJECT'
  | 'WORKTREE_UNMANAGED'
  | 'DIRECTORY_BUSY'
  | 'NEEDS_CONFIRMATION'
  | 'FORBIDDEN_ROLE'
  | 'LEASE_OVERLAP'
  | 'CAP_REACHED'
  | 'PROJECT_PAUSED';

export class ArtinareyError extends Error {
  constructor(
    public readonly code: ArtinareyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtinareyError';
  }
}
