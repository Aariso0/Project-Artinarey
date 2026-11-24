export type ArtinareyErrorCode =
  | 'INVALID_INPUT'
  | 'STORE_OFFLINE'
  | 'MAIL_REJECTED'
  /** Mail file committed, audit append failed: the id is already durable. */
  | 'MAIL_PARTIAL'
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
  | 'PROJECT_PAUSED'
  /** M8: the adapter process is unavailable; the daemon itself never calls out. */
  | 'ADAPTER_OFFLINE';

export class ArtinareyError extends Error {
  constructor(
    public readonly code: ArtinareyErrorCode,
    message: string,
    /** Set when a mail file was committed but a later write step failed. */
    public readonly mailId?: string,
  ) {
    super(message);
    this.name = 'ArtinareyError';
  }
}
