import test from 'node:test';
import assert from 'node:assert/strict';
import { shutdownModelAdapter } from './index.ts';

test('daemon cleanup waits for adapter shutdown before releasing the lock', async () => {
  let release!: () => void;
  const stopped = new Promise<void>((resolve) => { release = resolve; });
  let cleaned = false;
  const pending = shutdownModelAdapter({ stop: () => stopped }, () => { cleaned = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cleaned, false, 'cleanup must not release the lock while stop is pending');
  } finally {
    release();
  }
  await pending;
  assert.equal(cleaned, true);
});

test('daemon cleanup still runs when adapter shutdown fails', async () => {
  const originalError = console.error;
  console.error = () => {};
  let cleaned = false;
  try {
    await shutdownModelAdapter(
      { stop: () => Promise.reject(new Error('stop failed')) },
      () => { cleaned = true; },
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(cleaned, true);
});
