import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask, newId, openRegistry, resolveXdgPaths } from '@artinarey/core';
import { ModelAdapterClient } from './model-client.ts';
import {
  collectCompletion, CompletionCollector, completionRequest, MAX_SSE_BUFFER_SIZE, MODEL_KEY_ENV,
  parseAdapterConfig, publicAdapterConfig,
} from './model-wire.ts';
import { dispatchTool, type RpcContext } from './tools.ts';

const KEY_ENV = {
  ARTINAREY_MODEL_BASE_URL: 'https://model.example.test/v1',
  [MODEL_KEY_ENV]: 'secret-in-adapter-only',
  ARTINAREY_MODEL_MODEL: 'fake-model',
};
const LOCAL_ENV = {
  ARTINAREY_MODEL_BASE_URL: 'http://127.0.0.1:9/v1',
  ARTINAREY_MODEL_MODEL: 'fake-model',
};

const SIGNAL = new AbortController().signal;

test('adapter config is validated; key never appears in public status', () => {
  const config = parseAdapterConfig(KEY_ENV);
  assert.equal(config.profile, 'openai-compatible');
  assert.equal(config.model, 'fake-model');
  assert.equal(config.key, 'secret-in-adapter-only');
  assert.equal(JSON.stringify(publicAdapterConfig(config)),
    JSON.stringify({
      baseUrl: 'https://model.example.test/v1', profile: 'openai-compatible',
      model: 'fake-model', hasKey: true,
    }));
  assert.doesNotMatch(JSON.stringify(publicAdapterConfig(config)), /secret/i);

  assert.throws(() => parseAdapterConfig({ ...KEY_ENV, ARTINAREY_MODEL_BASE_URL: 'file:///etc/passwd' }),
    /http\(s\) URL/);
  assert.throws(() => parseAdapterConfig({ ...KEY_ENV, ARTINAREY_MODEL_PROFILE: 'anthropic' }),
    /unsupported wire profile/);
  assert.throws(() => parseAdapterConfig({ ...KEY_ENV, ARTINAREY_MODEL_BASE_URL: 'http://127.0.0.1:9/v1' }),
    /https/);
  const unkeyed = parseAdapterConfig(LOCAL_ENV);
  assert.equal(unkeyed.key, null);
  assert.equal(unkeyed.baseUrl, 'http://127.0.0.1:9/v1');
});

test('credentialed requests carry the key only over https and refuse redirects', () => {
  const keyed = completionRequest(parseAdapterConfig(KEY_ENV), { prompt: 'hi' }, SIGNAL);
  assert.equal(keyed.url, 'https://model.example.test/v1/chat/completions');
  assert.equal(keyed.init.headers.Authorization, 'Bearer secret-in-adapter-only');
  assert.equal(keyed.init.redirect, 'error');
  assert.equal(keyed.init.signal, SIGNAL);

  const local = completionRequest(parseAdapterConfig(LOCAL_ENV), { prompt: 'hi' }, SIGNAL);
  assert.equal(local.url, 'http://127.0.0.1:9/v1/chat/completions');
  assert.equal(local.init.headers.Authorization, undefined);
  assert.equal(local.init.redirect, 'follow');
});

test('SSE collector accumulates model text and treats [DONE] as completion', () => {
  const collector = new CompletionCollector();
  collector.feed('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
  collector.feed('data: {"choices":[{"delta":{"content":"world"}}]}\n\ndata: [DONE]\n\n');
  assert.deepEqual(collector.result(), { text: 'Hello world', done: true });
});

function sseStream(chunks: string[], close: boolean): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
    cancel() { cancelled = true; },
  });
  return { stream, cancelled: () => cancelled };
}

function errorFrom(result: Promise<unknown>): Promise<Error & { code?: string }> {
  return result.then(
    () => { throw new Error('expected an ADAPTER_OFFLINE error'); },
    (err: unknown) => err as Error & { code?: string },
  );
}

test('[DONE] on an open response cancels the reader and returns the completed text', async () => {
  const s = sseStream([
    'data: {"choices":[{"delta":{"content":"Adapter "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"answered"}}]}\n\ndata: [DONE]\n\n',
  ], false);
  assert.deepEqual(await collectCompletion(s.stream), { text: 'Adapter answered', done: true });
  assert.equal(s.cancelled(), true);
});

test('a named SSE error event fails fast and cancels the reader', async (t) => {
  // The stream is deliberately left open: without a fast failure this hangs.
  const s = sseStream(['event: error\ndata: provider rejected the request\n\n'], false);
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('named error event did not fail fast')), 500);
    t.after(() => clearTimeout(timer));
  });
  const error = await errorFrom(Promise.race([collectCompletion(s.stream), timeout]));
  assert.equal(error.code, 'ADAPTER_OFFLINE');
  assert.match(error.message, /provider rejected the request/);
  assert.equal(s.cancelled(), true);
});

test('SSE buffer overflow is ADAPTER_OFFLINE and cancels the reader', async () => {
  const s = sseStream([`data: ${'x'.repeat(MAX_SSE_BUFFER_SIZE + 1)}`], false);
  const error = await errorFrom(collectCompletion(s.stream));
  assert.equal(error.code, 'ADAPTER_OFFLINE');
  assert.equal(s.cancelled(), true);
});

test('a stream that ends before [DONE] is ADAPTER_OFFLINE, not partial success', async () => {
  const s = sseStream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], true);
  const error = await errorFrom(collectCompletion(s.stream));
  assert.equal(error.code, 'ADAPTER_OFFLINE');
  assert.match(error.message, /before \[DONE\]/);
});

type FakeApiMode = 'complete' | 'partial' | 'open';

type FakeApi = {
  server: Server;
  port: number;
  calls: Array<{ authorization: string | undefined; body: Record<string, unknown> }>;
};

async function fakeApi(mode: FakeApiMode = 'complete'): Promise<FakeApi> {
  const calls: FakeApi['calls'] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      calls.push({ authorization: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"Adapter "}}]}\n\n');
      if (mode === 'partial') {
        res.end();
        return;
      }
      res.write('data: {"choices":[{"delta":{"content":"answered"}}]}\n\n');
      if (mode === 'complete') res.end('data: [DONE]\n\n');
      // `open` writes [DONE] but deliberately leaves the response open.
      if (mode === 'open') res.write('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake API did not bind');
  return { server, port: address.port, calls };
}

async function closeApi(api: FakeApi): Promise<void> {
  api.server.closeAllConnections();
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
}

function fixture(t: TestContext) {
  const root = join(tmpdir(), `artinarey-model-${newId()}`);
  const config = join(root, 'config');
  mkdirSync(config, { recursive: true });
  const paths = resolveXdgPaths({
    HOME: root, XDG_CONFIG_HOME: config, XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_RUNTIME_DIR: join(root, 'runtime'),
  });
  const registry = openRegistry(paths.registryFile);
  const project = registry.projects.create({
    name: 'Model', repoCommonDir: join(root, 'repo', '.git'), storeDir: join(root, 'store'),
  });
  mkdirSync(project.storeDir, { recursive: true });
  const worktreeId = newId();
  const worktreePath = join(root, 'worktree');
  mkdirSync(worktreePath, { recursive: true });
  registry.worktrees.upsert({ id: worktreeId, projectId: project.id, path: worktreePath, branch: null });
  const persona = registry.personas.create({ projectId: project.id, role: 'dev0', name: 'Dev' });
  registry.bindings.bind(persona.id, worktreeId);
  const task = createTask(project.storeDir, {
    id: newId(), projectId: project.id, title: 'Ship the adapter task',
    scope: ['src/model.ts'], assignee: persona.role, status: 'in_progress', branch: null,
    worktreeId, createdAt: new Date().toISOString(),
  });
  t.after(() => {
    registry.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { paths, registry, project, worktreeId, worktreePath, persona, task };
}

test('a task runs through the adapter socket; the daemon never calls the model API', async (t) => {
  const api = await fakeApi();
  t.after(() => closeApi(api));

  const s = fixture(t);
  const client = new ModelAdapterClient({
    socketPath: join(s.paths.configDir, 'model-adapter.sock'),
    env: {
      ...LOCAL_ENV,
      ARTINAREY_MODEL_BASE_URL: `http://127.0.0.1:${api.port}/v1`,
    },
    readyTimeoutMs: 8_000,
  });
  t.after(() => client.stop());

  const status = await client.start();
  assert.equal(status.state, 'ready');
  assert.equal(status.hasKey, false);
  assert.equal(status.profile, 'openai-compatible');
  assert.ok(status.pid && status.pid > 0);
  assert.doesNotMatch(JSON.stringify(status), /secret-in-adapter-only/);

  const ctx: RpcContext = {
    registry: s.registry, paths: s.paths, model: client,
    identity: {
      projectId: s.project.id, worktreeId: s.worktreeId,
      markerDir: s.worktreePath, storeDir: s.project.storeDir,
      personaId: s.persona.id, role: 'dev0',
    },
  };
  const response = await dispatchTool(
    { id: '1', method: 'run_task', params: { task_id: s.task.id } }, ctx,
  );
  assert.equal(response.ok, true, response.ok ? '' : response.error.message);
  assert.match(response.ok ? (response.result as { text: string }).text : '', /Adapter answered/);

  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0]?.authorization, undefined);
  assert.equal((api.calls[0]?.body as { model: string }).model, 'fake-model');
  const audit = readFileSync(join(s.project.storeDir, 'events', 'audit.jsonl'), 'utf8');
  assert.match(audit, /"type":"model_task"/);
  assert.doesNotMatch(audit, /secret-in-adapter-only/);

  // Daemon-side source makes no outbound call and never reads the key.
  for (const file of ['index.ts', 'tools.ts', 'server.ts', 'http.ts', 'gui.ts', 'model-client.ts']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} must not call out`);
    assert.doesNotMatch(source, /ARTINAREY_MODEL_KEY/, `${file} must not read the key`);
  }
});

test('a stopped adapter is a typed ADAPTER_OFFLINE error, not an empty result', async (t) => {
  const api = await fakeApi();
  t.after(() => closeApi(api));
  const s = fixture(t);
  const client = new ModelAdapterClient({
    socketPath: join(s.paths.configDir, 'model-adapter.sock'),
    env: { ...LOCAL_ENV, ARTINAREY_MODEL_BASE_URL: `http://127.0.0.1:${api.port}/v1` },
    readyTimeoutMs: 8_000,
  });
  assert.equal((await client.start()).state, 'ready');
  await client.stop();
  const error = await errorFrom(client.prompt({ prompt: 'hello' }));
  assert.equal(error.code, 'ADAPTER_OFFLINE');
});

test('a crashed adapter clears its socket and pid and returns typed ADAPTER_OFFLINE', async (t) => {
  const api = await fakeApi();
  t.after(() => closeApi(api));
  const s = fixture(t);
  const socketPath = join(s.paths.configDir, 'model-adapter.sock');
  const client = new ModelAdapterClient({
    socketPath,
    env: { ...LOCAL_ENV, ARTINAREY_MODEL_BASE_URL: `http://127.0.0.1:${api.port}/v1` },
    readyTimeoutMs: 8_000,
  });
  t.after(() => client.stop());
  const started = await client.start();
  assert.equal(started.state, 'ready');
  assert.ok(started.pid);

  // Crash the child as kill -9 would; stop() is deliberately not used here.
  process.kill(started.pid!, 'SIGKILL');
  const deadline = Date.now() + 2_000;
  while (client.status().state !== 'offline' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const status = client.status();
  assert.equal(status.state, 'offline');
  assert.equal(status.pid, null);
  assert.equal(existsSync(socketPath), false);

  const error = await errorFrom(client.prompt({ prompt: 'hello' }));
  assert.equal(error.code, 'ADAPTER_OFFLINE');
});

test('a partial SSE response is ADAPTER_OFFLINE through the adapter socket', async (t) => {
  const api = await fakeApi('partial');
  t.after(() => closeApi(api));
  const s = fixture(t);
  const client = new ModelAdapterClient({
    socketPath: join(s.paths.configDir, 'model-adapter.sock'),
    env: { ...LOCAL_ENV, ARTINAREY_MODEL_BASE_URL: `http://127.0.0.1:${api.port}/v1` },
    readyTimeoutMs: 8_000,
    promptTimeoutMs: 1_000,
  });
  t.after(() => client.stop());
  assert.equal((await client.start()).state, 'ready');
  const error = await errorFrom(client.prompt({ prompt: 'hello' }));
  assert.equal(error.code, 'ADAPTER_OFFLINE');
});

test('[DONE] returns a completed prompt even when the provider keeps the response open', async (t) => {
  const api = await fakeApi('open');
  t.after(() => closeApi(api));
  const s = fixture(t);
  const client = new ModelAdapterClient({
    socketPath: join(s.paths.configDir, 'model-adapter.sock'),
    env: { ...LOCAL_ENV, ARTINAREY_MODEL_BASE_URL: `http://127.0.0.1:${api.port}/v1` },
    readyTimeoutMs: 8_000,
    promptTimeoutMs: 1_000,
  });
  t.after(() => client.stop());
  assert.equal((await client.start()).state, 'ready');
  assert.deepEqual(await client.prompt({ prompt: 'hello' }), {
    text: 'Adapter answered', done: true,
  });
});
