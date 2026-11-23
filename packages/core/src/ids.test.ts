import test from 'node:test';
import assert from 'node:assert/strict';
import { isUlid, newId } from './ids.ts';

test('newId produces unique ULIDs that sort by creation order', () => {
  const ids = Array.from({ length: 1000 }, () => newId());

  assert.equal(new Set(ids).size, 1000, 'every id must be unique');
  assert.deepEqual([...ids].sort(), ids, 'ULIDs must sort lexicographically by creation order');
});

test('isUlid accepts a generated id and rejects malformed values', () => {
  const id = newId();
  assert.equal(isUlid(id), true);
  assert.equal(isUlid(''), false);
  assert.equal(isUlid('550e8400-e29b-41d4-a716-446655440000'), false);
  assert.equal(isUlid('I'.repeat(26)), false);
});

test('isUlid keeps the 48-bit timestamp boundary at 7', () => {
  assert.equal(isUlid(`0${'0'.repeat(25)}`), true);
  assert.equal(isUlid(`7${'Z'.repeat(25)}`), true);
  assert.equal(isUlid(`8${'0'.repeat(25)}`), false);
  assert.equal(isUlid(`Z${'0'.repeat(25)}`), false);
  assert.equal(isUlid(`0${'U'.repeat(25)}`), false);
  assert.equal(isUlid(`7${'0'.repeat(24)}`), false);
  assert.equal(isUlid(`0${'0'.repeat(26)}`), false);
});
