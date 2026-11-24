import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { XdgPaths } from '@artinarey/core';

/** Daemon-wide actions that must never be reachable from a raw agent socket. */
export const OPERATOR_METHODS = new Set([
  'shutdown', 'approve', 'auto_approve', 'stop_session', 'release_force',
  'model_status', 'model_prompt',
]);

export function isOperatorMethod(method: string): boolean {
  return OPERATOR_METHODS.has(method);
}

export function operatorTokenPath(paths: XdgPaths): string {
  return join(paths.configDir, 'operator-token');
}

/** The token is created once and reused, so a daemon restart does not change it. */
export function loadOrCreateOperatorToken(paths: XdgPaths): string {
  const file = operatorTokenPath(paths);
  mkdirSync(dirname(file), { recursive: true });
  if (!existsSync(file)) {
    try {
      writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  chmodSync(file, 0o600);
  return readFileSync(file, 'utf8').trim();
}

/** Hash both inputs so timingSafeEqual compares equal-length buffers for any input. */
export function authorizeOperator(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const supplied = createHash('sha256').update(provided).digest();
  const configured = createHash('sha256').update(expected).digest();
  return timingSafeEqual(supplied, configured);
}
