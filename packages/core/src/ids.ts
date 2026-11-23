import { monotonicFactory } from 'ulid';

const monotonicUlid = monotonicFactory();

export type ProjectId = string & { readonly __brand: 'ProjectId' };
export type WorktreeId = string & { readonly __brand: 'WorktreeId' };
export type PersonaId = string & { readonly __brand: 'PersonaId' };
export type MailId = string & { readonly __brand: 'MailId' };

/** ULID assigned by the daemon: unique and sortable, including within one millisecond. */
export function newId(): string {
  return monotonicUlid();
}

/** ULID: 48-bit timestamp (first char 0-7) + 80-bit randomness, Crockford base32 without I, L, O, U. */
export function isUlid(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}
