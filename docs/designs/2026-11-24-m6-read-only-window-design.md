# M6 — Read-only desktop window design

**Date:** 2026-11-24  
**Status:** Proposed  
**Milestone:** M6 (Slice 1)  
**Depends on:** M5

## Intent

Give the user a desktop window that shows the current state of Artinarey without letting the webview talk to the daemon or hold its secret. This is the first visible product surface and the foundation for M7, where mutating controls will be added behind explicit dialogs.

The window is read-only. It answers “what projects, agents, worktrees and mail exist right now?” It does not start sessions, approve requests, move worktrees or edit records.

## Goals

1. Ship a Tauri 2 desktop app with a React 19.3.1 frontend built by Vite 8.3.8, using plain CSS only.
2. Keep the daemon token out of the webview. The native shell holds and sends it.
3. Add a loopback HTTP surface to the Node daemon for the native shell, alongside the existing Unix socket used by agents.
4. Enforce a bearer token, loopback `Host` check, and a platform-specific `Origin` allowlist that rejects `null`.
5. Show read-only screens for Projects, Personas, Worktrees and Mail.
6. Use `assets/artinarey.svg` as the in-app logo and `assets/artinarey.png` for the native bundle icon.
7. Use the GitHub-dark palette with the Claude-orange accent from the existing logo.
8. Prove the window with an acceptance run containing one senior dev and two developers in one project.

## Non-goals

- Chat, approvals, scope requests, session controls, worktree creation, Move, storage settings or any mutation.
- Direct webview-to-daemon HTTP calls.
- A token, session id or secret in `localStorage`, JavaScript globals or bundled code.
- New UI kits, component libraries or CSS frameworks.
- Committing role-instruction files. Role instructions are supplied at runtime from `ARTINAREY_ROLES_DIR` or the user config directory.
- A model API adapter; that is M8.

## Anti-goals

- A window that silently shows an empty state when the daemon rejects a call. Auth and validation failures must be visible, typed errors.
- Exposing the existing agent tool methods through the GUI surface. The GUI gets a separate set of read-only methods.
- Treating `null`, a missing `Origin`, a LAN address or an arbitrary localhost alias as valid.
- Letting the webview choose the daemon port, token or Origin.

## Constraints and settled decisions

| Area | Decision |
|---|---|
| Stack | Tauri 2 (`@tauri-apps/api` 2.12.5, `@tauri-apps/cli` 2.12.6, Rust crate 2.9.5), React 19.3.1, Vite 8.3.8, TypeScript, plain CSS. |
| Licence | GPL-3.0 source-only project. All added dependencies must be MIT or Apache-2.0 and listed in `NOTICE`. |
| Secret storage | `resolveXdgPaths().tokenFile`, mode 0600. Port in `join(paths.configDir, 'daemon.json')`. With no XDG overrides these are `~/.config/artinarey/token` and `~/.config/artinarey/daemon.json`; Rust resolves the same XDG variables. |
| Transport | Native proxy connects to `127.0.0.1:<ephemeral port>`. The daemon binds only loopback. |
| Origin | `tauri://localhost` on Linux/macOS; `http://tauri.localhost` or `https://tauri.localhost` on Windows/Android. `null` and absent origins are rejected on `/rpc`. |
| Existing socket | The Unix socket and all agent tools stay unchanged. |
| Data authority | The registry and cache index remain the truth. The window only renders snapshots returned by the daemon. |
| Logo | `assets/artinarey.svg` in the UI; `assets/artinarey.png` for bundled icons. |
| Gates | Existing `pnpm run typecheck`, `pnpm test`, `pnpm run lint`, `pnpm build` must stay green. Add Rust compilation/tests as a separate `pnpm run test:gui` script. |

## Approaches considered

1. **Electron or a browser-only page.** Easy to build, but the webview would need the daemon token or a broad local API. That violates the settled no-secret-in-webview rule. Rejected.

2. **Webview calls the daemon HTTP surface directly.** Avoids Rust code, but makes webview `Origin` the security boundary. Tauri Origins vary by platform and can be `null`; this is exactly the assumption M6 exists to remove. Rejected.

3. **Tauri native-command proxy (chosen).** The webview calls only `invoke('daemon_call', …)`. Rust reads the token and port, sets the expected `Host` and `Origin`, calls loopback HTTP, and returns a JSON value. The browser cannot reach the daemon directly. This matches the settled decision and keeps the existing agent socket untouched.

## Architecture

### Error contract

Every layer preserves one shape: `{ ok: true, result }` or `{ ok: false, error: { code, message } }`. The Tauri command returns `Result<Value, GuiError>`, where `GuiError` serialises to the same error object; it does not flatten failures to a bare string. `src/api.ts` rejects with `error` on `ok: false`.

Stable codes are `AUTH_FAILED`, `BAD_HOST`, `BAD_ORIGIN`, `BODY_TOO_LARGE`, `DAEMON_UNREACHABLE`, `BAD_RESPONSE`, `INVALID_REQUEST`, `FORBIDDEN_METHOD`, `NOT_FOUND` and `INTERNAL_ERROR`. Daemon validation failures use these codes directly. Transport and parse failures are mapped to them by the Rust proxy. A missing token file is `AUTH_FAILED`, a missing or malformed `daemon.json` is `DAEMON_UNREACHABLE`, and an invalid JSON reply is `BAD_RESPONSE`.

### Daemon HTTP surface

Add `packages/daemon/src/http.ts`:

- `createHttpServer(paths, ctx)` returns `{ start(), close(), port }`.
- `POST /rpc` accepts `{ id, method, params }`, applies auth and header checks, then routes only methods prefixed `gui.` through a dedicated dispatcher.
- `GET /healthz` returns a small loopback-only health response without exposing state.
- Bind `127.0.0.1` on OS-assigned port. Write the port and token paths to `daemon.json`.
- Generate a random 256-bit token when `token` is absent; create it with mode 0600. Never log it.
- Validate `Authorization: Bearer <token>` with a constant-time comparison.
- Validate `Host` against `127.0.0.1:<port>` and `localhost:<port>` only.
- Require an `Origin` header on `/rpc` and match it against the platform allowlist; reject `null` and unknown values.
- Cap request bodies at 1 MiB and return typed JSON errors with a stable `code`.
- Reuse `RpcRequest`, `RpcResponse` and the existing supervisor/registry context; do not duplicate business logic.

Add read-only methods in `packages/daemon/src/gui.ts`:

- `gui.projects` → id, name, store path, byte size, free bytes, and a status chip. M6 only emits `active` when the store path exists, or `offline` when it does not. `paused` and `moving` are not invented or persisted in M6.
- `gui.personas` → id, role, name, bound worktree, last vendor session id, running state.
- `gui.worktrees` → id, path, branch, lock/prune state, bound persona, auto-approve state.
- `gui.mail({ projectId, recipient?, thread?, limit? })` → newest-first metadata from the cache index: id, thread, from, to, cc, subject, kind and createdAt. Default limit is 100, maximum 500. It does not read mail bodies or per-persona read state.

Any unknown `gui.` method is `NOT_FOUND`. Any non-`gui.` method is `FORBIDDEN` on this surface.

### Native shell

Create `apps/gui/src-tauri/`:

- `Cargo.toml` with Tauri 2.9.5, `serde`, `serde_json`; no HTTP client crate. The proxy uses `std::net::TcpStream` for the single loopback request.
- `src/main.rs` and `src/lib.rs` registering one command: `daemon_call(method: String, params: Value) -> Result<Value, GuiError>`.
- The command reads `daemon.json` and `token`, opens a TCP connection to `127.0.0.1:<port>`, sends a bounded HTTP/1.1 request with the token, correct `Host`, platform `Origin`, `Content-Type` and `Content-Length`, parses status, headers and body, and returns the JSON result. It never returns the token and never accepts a URL from the frontend.
- `tauri.conf.json` sets the frontend dist directory, dev URL, window title and bundle icon. Use the existing PNG for the bundle icon.
- A capability allowing only the `core:default` permission set. No HTTP plugin, no filesystem plugin, no shell plugin.

Rust unit tests cover the HTTP response parser, request-body cap, token absence and disallowed method mapping.

### Frontend

Create `apps/gui/`:

- `package.json` with React 19.3.1, React DOM 19.3.1, `@tauri-apps/api` 2.12.5, Vite 8.3.8, TypeScript and the existing lint/test tooling conventions.
- `src/api.ts` wraps `invoke('daemon_call', { method, params })` and converts typed daemon errors into visible error states.
- `src/App.tsx` renders a sidebar with four read-only views: Projects, Personas, Worktrees, Mail.
- `src/components/` contains small presentational components: `StatusChip`, `EmptyState`, `ErrorPanel`, `Panel`, `Logo`.
- `src/styles.css` defines the theme as CSS variables and uses a responsive two-column layout. No control is rendered that can send a mutating method.
- Static assets are copied from `assets/artinarey.svg`; no second logo is authored.

### Validation

- Node tests: token creation mode, wrong/missing token, wrong Host, wrong/null/missing Origin, non-`gui.` method rejection, unknown `gui.` method, oversized body, and each read-only method against a seeded registry/index.
- Rust tests: request builder, response parser, body cap and error mapping.
- Frontend tests: renders seeded data, renders a typed error, and contains no mutating `invoke` calls.
- Acceptance fixture: seed a registry/store/index with one project, one senior dev, two developers in three worktrees, and mail addressed to each. Live spawning is already proven in M5 and is not repeated here. “Their mail appear” means each developer's address is selectable in the Mail view and its seeded metadata rows are listed; bodies are not part of M6.
- Environment: done in this repository means all four existing gates are green, `pnpm run test:gui` is green, and `cargo build --manifest-path apps/gui/src-tauri/Cargo.toml` succeeds. Launching a bundled window needs a desktop display and is recorded separately if the environment cannot provide one; it is not required for the source-level done state.

## What is left to the builder

- Exact file names and module boundaries inside `apps/gui/`, as long as the public command name stays `daemon_call`.
- Whether the read-only methods are fetched in parallel or by a single overview method; prefer one overview only if it does not blur the method boundaries above.
- The concrete CSS layout details, provided the theme variables and read-only constraint are kept.
- The exact TypeScript test runner used for the frontend, provided it runs under the existing `pnpm test` gate or a documented extra script.
- CI wiring for `cargo test`, provided it does not weaken the four existing gates.

## Definition of done

- All M6 checkboxes in `plan.md` are complete.
- The acceptance run works end to end with one senior dev and two developers visible in the window.
- Four existing gates are green and `pnpm run test:gui` is green.
- `NOTICE` includes any newly added MIT/Apache-2.0 dependencies.
- No secret, no mutating GUI method and no private-agent reference is present in published files.
