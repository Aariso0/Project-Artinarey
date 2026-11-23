export type ArtinareyErrorCode =
  | 'INVALID_INPUT'
  | 'STORE_OFFLINE'
  | 'MAIL_REJECTED'
  | 'NOT_FOUND'
  | 'ALREADY_RUNNING'
  | 'INDEX_ERROR';

export class ArtinareyError extends Error {
  constructor(
    public readonly code: ArtinareyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ArtinareyError';
  }
}
