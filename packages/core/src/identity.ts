import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Marker = {
  schema: 1;
  project_id: string;
  worktree_id: string;
};

export const MARKER_FILE = '.artinarey.json';

function isMarker(value: unknown): value is Marker {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return m.schema === 1 && typeof m.project_id === 'string' && typeof m.worktree_id === 'string';
}

/** IDs only: no store path, no persona. */
export function writeMarker(dir: string, projectId: string, worktreeId: string): void {
  writeFileSync(join(dir, MARKER_FILE), JSON.stringify({
    schema: 1,
    project_id: projectId,
    worktree_id: worktreeId,
  }));
}

/** Walk up from a directory to the nearest valid marker. */
export function findMarker(startDir: string): { dir: string; marker: Marker } | undefined {
  let current = resolve(startDir);
  while (true) {
    const file = join(current, MARKER_FILE);
    if (existsSync(file)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (isMarker(parsed)) return { dir: current, marker: parsed };
      } catch {
        // ignore malformed markers and keep walking
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
