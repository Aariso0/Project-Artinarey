import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';

export type PersonaState = {
  role: string;
  name: string;
  home_worktree_id: string | null;
  state: 'new' | 'idle' | 'active' | 'retired';
  vendor: string | null;
  last_vendor_session_id: string | null;
};

export const DEFAULT_PERSONA: PersonaState = {
  role: '',
  name: '',
  home_worktree_id: null,
  state: 'new',
  vendor: null,
  last_vendor_session_id: null,
};

export function personaDir(storeDir: string, personaId: string): string {
  return join(storeDir, 'personas', personaId);
}

export function readPersona(storeDir: string, personaId: string): PersonaState {
  const file = join(personaDir(storeDir, personaId), 'persona.json');
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_PERSONA };
    throw err;
  }
  return { ...DEFAULT_PERSONA, ...(JSON.parse(content) as Partial<PersonaState>) };
}

export function writePersona(storeDir: string, personaId: string, value: PersonaState): void {
  atomicWrite(join(personaDir(storeDir, personaId), 'persona.json'), `${JSON.stringify(value, null, 2)}\n`);
}
