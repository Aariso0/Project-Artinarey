import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, openRegistry, resolveXdgPaths } from '@artinarey/core';
import { startGuiHttpServer, type GuiHttpServer } from './http.ts';
import type { RpcContext } from './tools.ts';

type Envelope =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

const ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/** Reject with missing, null and unlisted origins on every platform. */
const nativeOrigin = process.platform === 'win32' || process.platform === 'android'
  ? 'http://tauri.localhost' : 'tauri://localhost';

function setup(t: TestContext) {
  const root = join(tmpdir(), `artinarey-http-${newId()}`);
  const dirs = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  Object.assign(process.env, dirs);
  const paths = resolveXdgPaths();
  const registry = openRegistry(paths.registryFile);
  t.after(() => {
    registry.close();
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, registry };
}

type Fixture = ReturnType<typeof setup>;

function ctx(s: Fixture): RpcContext {
  return { registry: s.registry, paths: s.paths };
}

async function start(t: TestContext, s: Fixture): Promise<{ server: GuiHttpServer; token: string }> {
  const server = await startGuiHttpServer(s.paths, ctx(s));
  t.after(() => server.close());
  return { server, token: readFileSync(s.paths.tokenFile, 'utf8').trim() };
}

function codeOf(body: Envelope): string | undefined {
  return body.ok ? undefined : body.error.code;
}

function request(port: number, options: {
  method: string;
  path: string;
  host: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: Envelope }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: options.method,
      path: options.path,
      headers: { Host: options.host, ...options.headers },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Envelope });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** An omitted extraHeaders argument means the native shell's normal Origin. */
function post(port: number, token: string, body: unknown, extraHeaders?: Record<string, string>) {
  const headers = extraHeaders === undefined ? { Origin: nativeOrigin } : extraHeaders;
  return request(port, {
    method: 'POST', path: '/rpc', host: `127.0.0.1:${port}`,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
}

function rawPost(port: number, token: string | undefined, host: string, origin: string | undefined) {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  if (origin !== undefined) headers.Origin = origin;
  return request(port, {
    method: 'POST', path: '/rpc', host, headers,
    body: JSON.stringify({ id: '1', method: 'gui.projects' }),
  });
}

/** No Content-Length: the server must count the bytes it actually reads. */
function chunkedPost(port: number, token: string, origin: string, padding: string) {
  return new Promise<Envelope>((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, method: 'POST', path: '/rpc',
      headers: {
        Host: `127.0.0.1:${port}`,
        Authorization: `Bearer ${token}`,
        Origin: origin,
        'Transfer-Encoding': 'chunked',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data) as Envelope); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify({ id: '1', method: 'gui.projects' }).slice(0, -1));
    req.write(`,"params":{"pad":"${padding}"}}`);
    req.end();
  });
}

test('a valid native request reaches gui.projects', async (t) => {
  const s = setup(t);
  const { server, token } = await start(t, s);
  const { body } = await post(server.port, token, { id: '1', method: 'gui.projects' });
  assert.equal(body.ok, true);
  assert.deepEqual(body.ok ? body.result : [], []);

  const published = JSON.parse(readFileSync(join(s.paths.configDir, 'daemon.json'), 'utf8')) as { port: number };
  assert.equal(published.port, server.port);
});

test('wrong Host, wrong Origin, null Origin, missing Origin and wrong token are typed errors', async (t) => {
  const s = setup(t);
  const { server, token } = await start(t, s);
  const port = server.port;

  assert.equal(codeOf((await rawPost(port, token, 'example.com', nativeOrigin)).body), 'BAD_HOST');
  assert.equal(codeOf((await rawPost(port, token, `localhost:${port + 1}`, nativeOrigin)).body), 'BAD_HOST');
  assert.equal((await rawPost(port, token, `localhost:${port}`, nativeOrigin)).body.ok, true);
  assert.equal(codeOf((await post(port, token, {}, { Origin: 'https://evil.test' })).body), 'BAD_ORIGIN');
  assert.equal(codeOf((await post(port, token, {}, { Origin: 'null' })).body), 'BAD_ORIGIN');
  assert.equal(codeOf((await post(port, token, {}, {})).body), 'BAD_ORIGIN');
  assert.equal(codeOf((await post(port, 'wrong', {}, { Origin: nativeOrigin })).body), 'AUTH_FAILED');
  assert.equal(codeOf((await rawPost(port, undefined, `127.0.0.1:${port}`, nativeOrigin)).body), 'AUTH_FAILED');
  // Authentication is checked before Host and Origin, even when all three are wrong.
  assert.equal(codeOf((await rawPost(port, 'wrong', 'example.com', undefined)).body), 'AUTH_FAILED');
});

test('non-gui methods and unknown gui methods are rejected', async (t) => {
  const s = setup(t);
  const { server, token } = await start(t, s);
  assert.equal(codeOf((await post(server.port, token, { method: 'send_mail' })).body), 'FORBIDDEN_METHOD');
  assert.equal(codeOf((await post(server.port, token, { method: 'status' })).body), 'FORBIDDEN_METHOD');
  assert.equal(codeOf((await post(server.port, token, { method: 'gui.nope' })).body), 'NOT_FOUND');
});

test('an oversized body is rejected by Content-Length and by bytes read', async (t) => {
  const s = setup(t);
  const { server, token } = await start(t, s);
  const padding = 'x'.repeat(1_100_000);
  assert.equal(codeOf((await post(server.port, token, { method: 'gui.projects', params: { pad: padding } })).body),
    'BODY_TOO_LARGE');
  assert.equal(codeOf(await chunkedPost(server.port, token, nativeOrigin, padding)), 'BODY_TOO_LARGE');
});

test('healthz is unauthenticated and exposes no state', async (t) => {
  const s = setup(t);
  const { server } = await start(t, s);
  const { status, body } = await request(server.port, {
    method: 'GET', path: '/healthz', host: `127.0.0.1:${server.port}`, headers: {},
  });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, result: { running: true } });
});

test('the token file is created only when absent and is pinned to mode 0600', async (t) => {
  const s = setup(t);
  const first = await start(t, s);
  assert.equal(statSync(s.paths.tokenFile).mode & 0o777, 0o600);
  await first.server.close();

  const reopened = await startGuiHttpServer(s.paths, ctx(s));
  t.after(() => reopened.close());
  assert.equal(readFileSync(s.paths.tokenFile, 'utf8').trim(), first.token);
  const { body } = await post(reopened.port, first.token, { id: '2', method: 'gui.projects' });
  assert.equal(body.ok, true);
});

test('malformed requests and unknown endpoints are typed errors', async (t) => {
  const s = setup(t);
  const { server, token } = await start(t, s);
  assert.equal(codeOf((await request(server.port, {
    method: 'POST', path: '/rpc', host: `127.0.0.1:${server.port}`,
    headers: { Authorization: `Bearer ${token}`, Origin: nativeOrigin }, body: '{oops',
  })).body), 'INVALID_REQUEST');
  assert.equal(codeOf((await request(server.port, {
    method: 'GET', path: '/rpc', host: `127.0.0.1:${server.port}`, headers: {},
  })).body), 'NOT_FOUND');
});
