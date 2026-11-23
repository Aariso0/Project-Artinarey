import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from './ids.ts';
import { readPersona, writePersona, type PersonaState } from './persona-store.ts';

const store = join(tmpdir(), `artinarey-persona-store-${newId()}`);

test('readPersona returns a default record for a missing persona', () => {
  assert.deepEqual(readPersona(store, 'missing'), {
    role: '',
    name: '',
    home_worktree_id: null,
    state: 'new',
    vendor: null,
    last_vendor_session_id: null,
  });
});

test('writePersona writes persona.json under personas/<id> and round-trips', () => {
  const id = newId();
  const value: PersonaState = {
    role: 'developer',
    name: 'Dev One',
    home_worktree_id: '01HOME',
    state: 'idle',
    vendor: 'opencode',
    last_vendor_session_id: 'ses_123',
  };

  writePersona(store, id, value);
  assert.equal(typeof readFileSync(join(store, 'personas', id, 'persona.json')).length, 'number');
  assert.deepEqual(readPersona(store, id), value);

  writePersona(store, id, { ...value, state: 'active' });
  assert.equal(readPersona(store, id).home_worktree_id, '01HOME', 'updates must preserve the home worktree');
  assert.equal(readPersona(store, id).state, 'active');
});
