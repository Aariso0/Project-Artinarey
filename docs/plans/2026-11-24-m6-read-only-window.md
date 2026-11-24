# M6 Read-only Window Implementation Plan

**Goal:** Build a Tauri 2 read-only desktop window that renders project, agent, worktree and mail snapshots from the daemon without exposing the daemon token to the webview.

**Architecture:** The Node daemon gains a loopback HTTP surface that accepts only authenticated, origin-checked `gui.*` calls. The Tauri native shell holds the token and proxies one `daemon_call` command over a plain TCP request. The React frontend calls only that command and renders seeded read-only snapshots.

**Tech Stack:** Tauri 2.9.5, `@tauri-apps/api` 2.12.5, `@tauri-apps/cli` 2.12.6, React 19.3.1, Vite 8.3.8, TypeScript, plain CSS, Node 26, pnpm 10.34.9, Rust 1.100.

**Spec:** `docs/designs/2026-11-24-m6-read-only-window-design.md`

## Global Constraints

- Tauri versions are fixed: Rust crate 2.9.5, `@tauri-apps/api` 2.12.5, `@tauri-apps/cli` 2.12.6. React is 19.3.1. Vite is 8.3.8. Use plain CSS only.
- All added dependencies must be MIT or Apache-2.0 and must be listed in `NOTICE` before M6 is marked done.
- The webview holds no secret. No token, port override or raw URL is accepted from `invoke` arguments.
- Token path is `resolveXdgPaths().tokenFile` with mode 0600. Port file is `join(paths.configDir, 'daemon.json')`. Rust resolves the same XDG variables.
- `POST /rpc` binds only `127.0.0.1`, requires `Authorization: Bearer <token>`, accepts `Host` only as `127.0.0.1:<port>` or `localhost:<port>`, and requires an allowed `Origin`. Allowlist: `tauri://localhost` on Linux/macOS; `http://tauri.localhost` and `https://tauri.localhost` on Windows/Android. Reject `null` and missing origins.
- Error shape is `{ ok: true, result }` or `{ ok: false, error: { code, message } }` at every layer. Stable codes: `AUTH_FAILED`, `BAD_HOST`, `BAD_ORIGIN`, `BODY_TOO_LARGE`, `DAEMON_UNREACHABLE`, `BAD_RESPONSE`, `INVALID_REQUEST`, `FORBIDDEN_METHOD`, `NOT_FOUND`, `INTERNAL_ERROR`.
- Only `gui.projects`, `gui.personas`, `gui.worktrees` and `gui.mail` are callable on the GUI surface. Every other method is `FORBIDDEN_METHOD`.
- Use `assets/artinarey.svg` as the in-app logo and `assets/artinarey.png` for the bundled icon. Do not commit role-instruction files.
- The four existing gates (`pnpm run typecheck`, `pnpm test`, `pnpm run lint`, `pnpm build`) must remain green. Add `pnpm run test:gui` and require it for M6.
- Do not commit or push unless the user explicitly asks. Commit steps below are conditional.

## File Structure

- `packages/daemon/src/gui.ts` — read-only GUI method dispatcher and result types.
- `packages/daemon/src/gui.test.ts` — seeded registry/index tests for GUI methods.
- `packages/daemon/src/http.ts` — authenticated loopback HTTP server, token/port files, header validation.
- `packages/daemon/src/http.test.ts` — real-socket security and error-contract tests.
- `packages/daemon/src/index.ts` — starts/stops the GUI HTTP server with the daemon; exports new modules.
- `apps/gui/` — Tauri app root.
- `apps/gui/src-tauri/Cargo.toml` — Rust crate manifest.
- `apps/gui/src-tauri/build.rs` and `src/{main.rs,lib.rs}` — Tauri entry points and `daemon_call` proxy.
- `apps/gui/src-tauri/tauri.conf.json` — window, frontend and bundle configuration.
- `apps/gui/src-tauri/icons/` — copy of `assets/artinarey.png`.
- `apps/gui/src/api.ts`, `src/App.tsx`, `src/components.tsx`, `src/styles.css`, `src/main.tsx` — frontend.
- `apps/gui/src/gui.test.ts` — frontend rendering and error-state tests.
- `apps/gui/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html` — frontend build setup.
- `package.json`, `tsconfig.json`, `eslint.config.js`, `NOTICE`, `README.md`, `plan.md` — workspace wiring and closeout.

## Review Focus

- Wrong `Host`, missing/`null`/unlisted `Origin`, or missing/wrong bearer token must return a typed error and never reach the dispatcher — pinned by Task 2 HTTP security tests.
- A request for `send_mail`, `approve` or any non-`gui.` method must be rejected on the GUI surface — pinned by Task 2 forbidden-method test and Task 1 dispatcher test.
- A missing token file, malformed `daemon.json` or malformed daemon reply must become `AUTH_FAILED`, `DAEMON_UNREACHABLE` or `BAD_RESPONSE`, not a blank panel — pinned by Task 3 Rust tests and Task 4 frontend error test.
- The Mail view must not expose bodies or read state, and must respect the 100-default/500-max limit — pinned by Task 1 mail contract test.
- A store path that does not exist must show `offline`, not crash or invent `paused`/`moving` — pinned by Task 1 status test and Task 4 rendering test.

---

### Task 1: Read-only GUI dispatcher

**Files:**
- Create: `packages/daemon/src/gui.ts`
- Create: `packages/daemon/src/gui.test.ts`
- Modify: `packages/daemon/src/index.ts` (export only)

**Interfaces:**
- Consumes: `RpcRequest`, `RpcResponse` from `./server.ts`; `RpcContext` from `./tools.ts`; `queryMail`, `IndexedMail` from `@artinarey/core`; `SessionSupervisor` from `./sessions.ts`.
- Produces:
  - `handleGuiRequest(request: RpcRequest, ctx: RpcContext): Promise<RpcResponse>`
  - `GuiProject = { id: string; name: string; storeDir: string; bytes: number; freeBytes: number; status: 'active' | 'offline' }`
  - `GuiPersona = { id: string; role: string; name: string; worktreeId: string | null; lastVendorSessionId: string | null; running: boolean }`
  - `GuiWorktree = { id: string; path: string; branch: string | null; locked: boolean; prunable: boolean; personaId: string | null; autoApprove: boolean }`
  - `GuiMail = { id: string; thread: string; from: string; to: string[]; cc: string[]; subject: string; kind: string; createdAt: string }`

- [ ] **Step 1: Write failing tests for project status and method isolation**

Create `packages/daemon/src/gui.test.ts` with a temp XDG registry, project, worktree and persona using the existing `setup()` pattern from `tools.test.ts`. Add:

```ts
test('gui.projects marks a missing store offline and rejects non-gui methods', async () => {
  const s = setup();
  const ok = await handleGuiRequest({ id: '1', method: 'gui.projects' }, ctx(s));
  assert.equal(ok.ok, true);
  const projects = (ok.ok ? ok.result : []) as GuiProject[];
  assert.equal(projects[0]?.status, 'offline');

  const bad = await handleGuiRequest({ id: '2', method: 'send_mail' }, ctx(s));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, 'FORBIDDEN_METHOD');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test packages/daemon/src/gui.test.ts`  
Expected: FAIL because `gui.ts` does not exist.

- [ ] **Step 3: Implement the dispatcher and result types**

In `packages/daemon/src/gui.ts`, export `handleGuiRequest`. Route only the four `gui.*` methods. Use `statfsSync(project.storeDir)` for `bytes`/`freeBytes` when present; use zeros when the path is missing and set `status: 'offline'`. Read registry rows for personas/worktrees and `queryMail(indexFile, { recipient, thread, limit })` for mail. Sort mail by `createdAt` descending. Clamp `limit` to 1–500 with default 100. Unknown `gui.*` returns `NOT_FOUND`; every other method returns `FORBIDDEN_METHOD`.

- [ ] **Step 4: Add and pass the remaining GUI contract tests**

Add tests to the same file:

```ts
test('gui.personas and gui.worktrees render registry state read-only', async () => {
  const people = await handleGuiRequest({ id: '1', method: 'gui.personas', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(people.ok, true);
  const rows = people.ok ? people.result as GuiPersona[] : [];
  assert.deepEqual(rows.map((p) => p.role), ['senior-dev', 'dev0']);
  assert.equal(rows.find((p) => p.role === 'dev0')?.worktreeId, s.worktreeIds[1]);
  const trees = await handleGuiRequest({ id: '2', method: 'gui.worktrees', params: { projectId: s.project.id } }, ctx(s));
  assert.equal(trees.ok, true);
  assert.equal((trees.ok ? trees.result as GuiWorktree[] : [])[0]?.autoApprove, false);
});

test('gui.mail returns metadata only, newest first, with a bounded limit', async () => {
  const response = await handleGuiRequest({
    id: '3', method: 'gui.mail', params: { projectId: s.project.id, limit: 999 },
  }, ctx(s));
  assert.equal(response.ok, true);
  const rows = response.ok ? response.result as GuiMail[] : [];
  assert.equal(rows.length, 500);
  assert.deepEqual(Object.keys(rows[0]!).sort(),
    ['cc', 'createdAt', 'from', 'id', 'kind', 'subject', 'thread', 'to'].sort());
  assert.ok(rows[0]!.createdAt >= rows[1]!.createdAt);
});
```

Run: `node --import tsx --test packages/daemon/src/gui.test.ts`  
Expected: PASS.

- [ ] **Step 5: Export and verify the workspace**

Modify `packages/daemon/src/index.ts` to add `export * from './gui.ts';`. Run `pnpm run typecheck` and `pnpm test`. Expected: both pass.

- [ ] **Step 6: Commit if requested**

If the user asked for commits: `git add packages/daemon/src/gui.ts packages/daemon/src/gui.test.ts packages/daemon/src/index.ts && git commit -m "feat: add read-only GUI daemon methods"`. Otherwise leave uncommitted.

---

### Task 2: Authenticated loopback HTTP surface

**Files:**
- Create: `packages/daemon/src/http.ts`
- Create: `packages/daemon/src/http.test.ts`
- Modify: `packages/daemon/src/index.ts`
- Modify: `packages/daemon/src/server.ts` (reuse `RpcRequest`/`RpcResponse` only if needed)

**Interfaces:**
- Consumes: `handleGuiRequest` from Task 1; `RpcContext`; `XdgPaths`; `randomBytes`, `timingSafeEqual`; `createServer` from `node:http`.
- Produces: `startGuiHttpServer(paths: XdgPaths, ctx: RpcContext): Promise<GuiHttpServer>`, where `GuiHttpServer = { port: number; close(): Promise<void> }`.

- [ ] **Step 1: Write failing security tests**

Create `packages/daemon/src/http.test.ts`. Seed a temp XDG root and start the server. Define helpers `post(port, token, body, extraHeaders)` and `rawPost(port, token, host, origin)` that send JSON and return the parsed response. Add one test per failure mode:

```ts
test('a valid native request reaches gui.projects', async () => {
  const body = await post(port, token, { id: '1', method: 'gui.projects' },
    { Origin: 'tauri://localhost' });
  assert.equal(body.ok, true);
});

test('wrong Host, wrong Origin, null Origin, missing Origin and wrong token are typed errors', async () => {
  assert.equal((await rawPost(port, token, 'example.com', 'tauri://localhost')).error.code, 'BAD_HOST');
  assert.equal((await post(port, token, {}, { Origin: 'https://evil.test' })).error.code, 'BAD_ORIGIN');
  assert.equal((await post(port, token, {}, { Origin: 'null' })).error.code, 'BAD_ORIGIN');
  assert.equal((await post(port, token, {}, {})).error.code, 'BAD_ORIGIN');
  assert.equal((await post(port, 'wrong', {}, { Origin: 'tauri://localhost' })).error.code, 'AUTH_FAILED');
});

test('non-gui methods and unknown gui methods are rejected', async () => {
  assert.equal((await post(port, token, { method: 'send_mail' })).error.code, 'FORBIDDEN_METHOD');
  assert.equal((await post(port, token, { method: 'gui.nope' })).error.code, 'NOT_FOUND');
});

test('an oversized body is rejected', async () => {
  assert.equal((await post(port, token, { method: 'gui.projects', params: { pad: 'x'.repeat(1_100_000) } })).error.code, 'BODY_TOO_LARGE');
});
```

Set `process.env.XDG_CONFIG_HOME` only inside the test setup and restore it after each test.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test packages/daemon/src/http.test.ts`  
Expected: FAIL because `http.ts` does not exist.

- [ ] **Step 3: Implement the server**

In `packages/daemon/src/http.ts`, bind `127.0.0.1` on port 0. Generate a 32-byte token when `paths.tokenFile` is absent and write it with mode 0600. Write `{ "port": <port> }` to `join(paths.configDir, 'daemon.json')`. Use constant-time token comparison. Validate headers in this order: token, Host, Origin, body size, method name. Call `handleGuiRequest` only after all checks pass. Return JSON with `Content-Type: application/json`; never echo the token. `GET /healthz` returns `{ ok: true, result: { running: true } }` without requiring auth.

- [ ] **Step 4: Wire startup and shutdown**

Modify `startDaemon()` in `packages/daemon/src/index.ts` to call `startGuiHttpServer(paths, ctx)` after the Unix RPC server starts, and call `gui.close()` in the existing shutdown callback and catch path. Do not change the agent socket protocol.

- [ ] **Step 5: Run the tests and gates**

Run: `node --import tsx --test packages/daemon/src/http.test.ts`, then `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, `pnpm build`.  
Expected: all pass; token file mode is 0600 in the test.

- [ ] **Step 6: Commit if requested**

If requested: `git add packages/daemon/src/http.ts packages/daemon/src/http.test.ts packages/daemon/src/index.ts && git commit -m "feat: add authenticated loopback GUI endpoint"`.

---

### Task 3: Tauri native proxy

**Files:**
- Create: `apps/gui/src-tauri/Cargo.toml`
- Create: `apps/gui/src-tauri/build.rs`
- Create: `apps/gui/src-tauri/src/main.rs`
- Create: `apps/gui/src-tauri/src/lib.rs`
- Create: `apps/gui/src-tauri/tauri.conf.json`
- Create: `apps/gui/src-tauri/capabilities/default.json`
- Create: `apps/gui/src-tauri/icons/icon.png` (copy of `assets/artinarey.png`)
- Create: `apps/gui/src-tauri/tests/proxy.test.rs`
- Modify: root `package.json` (`test:gui`)

**Interfaces:**
- Consumes: `daemon.json` and XDG token file from Task 2; error codes from Global Constraints.
- Produces: `#[tauri::command] fn daemon_call(method: String, params: Value) -> Result<Value, GuiError>`; `GuiError` serialises as `{ code, message }`.

- [ ] **Step 1: Write failing Rust tests for parsing and error mapping**

Create `apps/gui/src-tauri/tests/proxy.test.rs` with assertions for:

```rust
assert_eq!(parse_body_cap(1_048_577).unwrap_err().code, "BODY_TOO_LARGE");
assert_eq!(map_status(401).code, "AUTH_FAILED");
assert_eq!(map_status(404).code, "NOT_FOUND");
assert_eq!(map_status(500).code, "INTERNAL_ERROR");
assert_eq!(parse_http_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}").unwrap(), "{}");
assert_eq!(platform_origin("linux"), "tauri://localhost");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --manifest-path apps/gui/src-tauri/Cargo.toml`  
Expected: FAIL because the crate does not exist.

- [ ] **Step 3: Scaffold the crate and implement the proxy**

Use Tauri 2.9.5, `serde` and `serde_json` only. Implement the HTTP call with `std::net::TcpStream`; do not add an HTTP client crate or Tauri HTTP plugin. The command derives the config directory from `XDG_CONFIG_HOME` or `HOME/.config`, reads `artinarey/daemon.json` and `artinarey/token`, opens `127.0.0.1:<port>`, sends a bounded HTTP/1.1 request with token, canonical Host, platform Origin, `Content-Type` and `Content-Length`, parses response status/headers/body, and returns the daemon JSON unchanged. Map local failures to the stable codes. Never accept a URL, port or token from `params`.

- [ ] **Step 4: Configure Tauri**

In `tauri.conf.json`, point `frontendDist` at `../dist`, set `devUrl` to `http://localhost:5173`, title `Artinarey`, and bundle icon `icons/icon.png`. In `capabilities/default.json`, include only `core:default`; explicitly do not enable HTTP, filesystem or shell plugins.

- [ ] **Step 5: Add the script and pass the tests**

Add `"test:gui": "cargo test --manifest-path apps/gui/src-tauri/Cargo.toml"` to root `package.json`. Run `pnpm run test:gui` and `cargo build --manifest-path apps/gui/src-tauri/Cargo.toml`. Expected: both pass.

- [ ] **Step 6: Commit if requested**

If requested: `git add apps/gui/src-tauri package.json && git commit -m "feat: add Tauri native daemon proxy"`.

---

### Task 4: React read-only frontend

**Files:**
- Create: `apps/gui/package.json`
- Create: `apps/gui/tsconfig.json`
- Create: `apps/gui/vite.config.ts`
- Create: `apps/gui/index.html`
- Create: `apps/gui/src/main.tsx`
- Create: `apps/gui/src/api.ts`
- Create: `apps/gui/src/App.tsx`
- Create: `apps/gui/src/components.tsx`
- Create: `apps/gui/src/styles.css`
- Create: `apps/gui/src/gui.test.ts`
- Create: `apps/gui/public/logo.svg` (copy of `assets/artinarey.svg`)
- Modify: root `package.json`, `tsconfig.json`, `eslint.config.js`

**Interfaces:**
- Consumes: `invoke` from `@tauri-apps/api/core`; GUI result types from Task 1; error shape from Global Constraints.
- Produces: `createApi(invokeFn)` returning `{ projects(), personas(projectId), worktrees(projectId), mail(query) }`; `App({ api })` renderable without Tauri globals.

- [ ] **Step 1: Write failing frontend tests**

Create `apps/gui/src/gui.test.ts` using `renderToStaticMarkup` from `react-dom/server` and a fake `api` with seeded data for one senior dev and two developers. Add:

```ts
test('the window renders three agents and read-only mail metadata', () => {
  const html = renderToStaticMarkup(createElement(App, { api: fakeApi }));
  assert.match(html, /senior-dev/);
  assert.match(html, /dev0/);
  assert.match(html, /dev1/);
  assert.match(html, /Subject/);
  assert.doesNotMatch(html, /data-mutating-action/);
});

test('a typed daemon error renders a visible error panel', () => {
  const html = renderToStaticMarkup(createElement(App, { api: failingApi }));
  assert.match(html, /BAD_ORIGIN/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test apps/gui/src/gui.test.ts`  
Expected: FAIL because the app files do not exist.

- [ ] **Step 3: Build the frontend**

Implement `api.ts` so `createApi(invokeFn)` calls `invokeFn('daemon_call', { method, params })` and rejects with the `error` object when `ok` is false. Implement `App.tsx` with sidebar views Projects, Personas, Worktrees and Mail; presentational components in `components.tsx`; CSS variables for `#0d1117`, `#161b22`, `#30363d`, `#e6edf3`, `#2ea043` and `#d97757`; and the logo image from `/logo.svg`. Render no mutating controls.

- [ ] **Step 4: Wire workspace scripts and types**

Add React/React DOM, `@tauri-apps/api` and Vite dependencies with exact versions from Global Constraints. Add `@types/react`, `@types/react-dom` and `typescript` dev dependencies. Add `apps/gui` tests to root `pnpm test`. Add `apps/gui/src/**/*.tsx` to `tsconfig.json` and set `jsx: react-jsx` plus DOM libs. Extend `eslint.config.js` to lint `apps/gui/src`.

- [ ] **Step 5: Run the tests and gates**

Run `pnpm install`, `node --import tsx --test apps/gui/src/gui.test.ts`, `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, `pnpm build`. Expected: all pass.

- [ ] **Step 6: Commit if requested**

If requested: `git add apps/gui package.json tsconfig.json eslint.config.js pnpm-lock.yaml && git commit -m "feat: add read-only Artinarey window"`.

---

### Task 5: Acceptance fixture and closeout

**Files:**
- Modify: `packages/daemon/src/gui.test.ts`
- Modify: `apps/gui/src/gui.test.ts`
- Modify: `NOTICE`
- Modify: `README.md`
- Modify: `plan.md`

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Write the acceptance test**

Add to `packages/daemon/src/gui.test.ts` a fixture with one project, one senior dev, two developers, three worktrees and three mail rows (one addressed to each agent). Assert `gui.projects`, `gui.personas`, `gui.worktrees` and `gui.mail` all return the seeded rows and that no method returns a body or secret.

```ts
test('acceptance fixture shows one senior dev and two developers with their mail', async () => {
  const people = await handleGuiRequest({ id: '1', method: 'gui.personas', params: { projectId: s.project.id } }, ctx(s));
  const trees = await handleGuiRequest({ id: '2', method: 'gui.worktrees', params: { projectId: s.project.id } }, ctx(s));
  const mail = await handleGuiRequest({ id: '3', method: 'gui.mail', params: { projectId: s.project.id } }, ctx(s));
  assert.deepEqual((people.ok ? people.result as GuiPersona[] : []).map((p) => p.role).sort(),
    ['dev0', 'dev1', 'senior-dev']);
  assert.equal((trees.ok ? trees.result as GuiWorktree[] : []).length, 3);
  assert.deepEqual((mail.ok ? mail.result as GuiMail[] : []).map((m) => m.to[0]).sort(),
    ['dev0', 'dev1', 'senior-dev']);
});
```

Add a matching frontend test that renders the same fixture and asserts all three agent names and all three mail subjects are present.

- [ ] **Step 2: Run the focused tests**

Run: `node --import tsx --test packages/daemon/src/gui.test.ts apps/gui/src/gui.test.ts`  
Expected: PASS.

- [ ] **Step 3: Update docs and dependency notice**

Add every new MIT/Apache-2.0 dependency to `NOTICE` with installed version and upstream URL. In `README.md`, replace the “planned” window wording with the shipped M6 read-only screens and keep M7 features marked as later. In `plan.md`, mark all M6 checkboxes complete and record the exact gate output, the fixture result, and whether a native window launch was possible in this environment.

- [ ] **Step 4: Final verification**

Run exactly: `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, `pnpm build`, `pnpm run test:gui`, `cargo build --manifest-path apps/gui/src-tauri/Cargo.toml`, and the privacy check. Expected: all pass and privacy check reports clean.

- [ ] **Step 5: Commit if requested**

If requested: `git add NOTICE README.md plan.md packages/daemon/src/gui.test.ts apps/gui/src/gui.test.ts && git commit -m "docs: record M6 acceptance and dependencies"`.
