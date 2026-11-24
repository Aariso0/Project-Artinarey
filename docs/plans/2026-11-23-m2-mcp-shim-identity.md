# M2 — MCP Shim, Tools, Identity by Folder

**Branch:** `MO/foundation` (continues from M1)
**Plan date:** 2026-11-23
**Status:** ✅ complete — all tasks and gates green; two real OpenCode sessions exchanged mail both ways.
**Source of truth:** `plan.md` §15 M2 (lines 638–650), §4 transport/architecture, §5 store layout, §6 identity, §10 tools, §18 errors
**Estimate:** 1 d. Thin TDD slices; each verified and committed.
**Method:** TDD (watch each test fail first), incremental implementation.

---

## 0. Goal and definition of done

Make identity come from the working directory and expose the first eight MCP tools over real OpenCode. No worktree manager (M3), no leases (M4), no adapter/spawning (M5), no window (M6).

Done when:

1. `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` pass.
2. Two real OpenCode sessions in two directories claim two different personas and exchange mail both ways through the shim.
3. `DIRECTORY_BUSY`, `NEEDS_CONFIRMATION`, `NO_PROJECT` and `WORKTREE_UNMANAGED` each have a recorded test result.
4. Every tool reply ends with `unread: N` and `next: <one action>`; every error says stop or retry-after.

---

## 1. Scope

**In:** `packages/shim`, marker finder, persona store, identity resolver, roster, claim/release rules, daemon tool RPC methods, reply formatter, `artinarey connect opencode`, `artinarey release --force`.

**Out:** `artinarey init`, `worktree new|adopt|remove`, `run`, leases, overlap, approvals, spawns, GUI, model API adapter. Do not reopen settled decisions in `plan.md` §17.

---

## 2. Verified environment inputs

| Item | Value |
|---|---|
| MCP SDK | `@modelcontextprotocol/server@2.4.0` (official split package, same repo as `@modelcontextprotocol/sdk`) |
| stdio helper | `serveStdio(factory)` from `@modelcontextprotocol/server/stdio`; handles 2025-era and modern openings |
| Server class | `McpServer` from `@modelcontextprotocol/server`; `registerTool(name, {description, inputSchema}, handler)` |
| Validation | `zod@4.6.7` (`import * as z from 'zod/v4'` is not needed; top-level `z` works) |
| Node | v26.13.1 |

**Deviation to record:** Node 26 exposes no pidfd API (`process.pidfd` / `node:process` Pidfd are absent). The plan's settled *intent* — liveness tied to the session, not the parent pid — is met with a dedicated long-lived shim→daemon connection: the daemon releases the binding when that socket closes (EOF) and cross-checks the forwarded pid with `process.kill(pid, 0)`. This is event-driven rather than polled and is at least as strong as pidfd for release-on-exit. Record as an implementation deviation in the project notes; no design decision changes.

---

## 3. Repo layout additions

```
packages/core/src/identity.ts      marker finder, resolver, claim/release, roster
packages/core/src/persona-store.ts persona.json read/write in the store
packages/core/src/reply.ts         unread/next formatter and typed error texts
packages/shim/                     package.json, tsconfig.json, src/index.ts, src/tools.ts, src/daemon-client.ts, tests
packages/daemon/src/tools.ts       tool RPC dispatch (uses per-connection identity)
packages/cli/src/index.ts          + connect opencode, release --force
```

`opencode.json` remains gitignored and machine-local; `connect` writes it in the working directory.

---

## 4. Shared contracts (fixed now so M3+ can build against them)

```typescript
// core/src/identity.ts
export type Marker = { schema: 1; project_id: string; worktree_id: string };
export function findMarker(startDir: string): { dir: string; marker: Marker } | undefined;
export function writeMarker(dir: string, projectId: string, worktreeId: string): void;

export type Identity = {
  projectId: string;
  worktreeId: string;
  markerDir: string;
  personaId?: string;
  role?: string;
};
export function resolveIdentity(
  registry: Registry,
  cwd: string,
): { ok: true; identity: Identity } | { ok: false; code: 'NO_PROJECT' | 'WORKTREE_UNMANAGED'; message: string };

export type RosterEntry = {
  personaId: string; name: string; role: string; state: string;
  homeWorktreeId: string | null; lastTask: string;
};
export function roster(registry: Registry, storeDir: string, projectId: string): RosterEntry[];
```

```typescript
// core/src/reply.ts
export type ToolReply = { text: string; isError: boolean };
export function ok(body: string, unread: number, next: string): ToolReply;
export function fail(code: ErrorCode, message: string): ToolReply;
```
`ok` appends exactly `\nunread: N\nnext: <action>`. `fail` prepends the code and appends the settled stop/retry-after instruction from `plan.md` §18, and sets `isError: true`.

```typescript
// daemon RPC — new methods on the existing 0600 unix socket
attach   params { cwd: string; pid: number }  → { project, worktree, persona?, roster? }
<tool>   params = tool args; identity comes from the attached connection, never from args
release_force params { worktreeId: string }   → { released: boolean }
```
Per-connection state holds the attached identity. On socket close, any binding acquired by that connection is released.

Tool names: `check_in`, `claim_persona`, `inbox`, `read_mail`, `send_mail`, `mark_done`, `report`, `worktrees`.

---

## 5. Tasks

### Task 1 — Scaffold the shim package

Add `packages/shim` with `@modelcontextprotocol/server@2.4.0` and `zod@4.6.7`. Add a test asserting `createShimServer()` returns an `McpServer` and that `TOOL_NAMES` is exactly the eight names above.

**Verify:** gates green. Commit `chore: scaffold MCP shim package`.

### Task 2 — Core: marker finder and persona store

**RED tests:** `findMarker` walks up from a nested directory and returns the nearest marker; no marker → `undefined`; a malformed marker is ignored. `writeMarker` produces exactly `{"schema":1,"project_id":…,"worktree_id":…}` and creates no parent dirs. `persona-store` reads a missing persona file as a default record, writes `persona.json` atomically, and preserves `homeWorktreeId` across updates.

**GREEN:** `identity.ts` marker half + `persona-store.ts`.

**Verify/commit:** `feat(core): marker finder and persona store`.

### Task 3 — Core: identity resolver, roster, claim/release

**RED tests:** resolve with a marker whose directory realpath matches the registered worktree → ok; a marker with an unknown worktree id → `WORKTREE_UNMANAGED`; no marker → `NO_PROJECT`. Roster returns all personas for the project with state/home/last task. Claim binds a persona; a second claim of a different persona to the same worktree → `DIRECTORY_BUSY`; claiming a persona whose home is another worktree → `NEEDS_CONFIRMATION`; `confirm_move` binds, `rehome` updates the persona's home; release frees the binding; senior dev may claim anywhere.

**GREEN:** rest of `identity.ts`. Use the registry plus the persona store; every successful/failed mismatch writes an audit line.

**Verify/commit:** `feat(core): identity resolution and persona binding rules`.

### Task 4 — Core: reply format and error texts

**RED tests:** `ok` ends with `unread: 3\nnext: inbox`; `fail('DIRECTORY_BUSY', …)` contains the code and "stop", `isError` true; `fail('NEEDS_CONFIRMATION', …)` says ask the user and repeat with `confirm_move=true`; `fail('PROJECT_PAUSED', …)` includes `retry_after`.

**GREEN:** `reply.ts` with the full §18 code→instruction table.

**Verify/commit:** `feat(core): tool reply format and error texts`.

### Task 5 — Daemon: attach and tool dispatch

**RED tests:** start the RPC server on a temp socket; `attach` with a temp marker/worktree resolves identity; a tool call before attach returns `NO_PROJECT`; `send_mail` through RPC writes a mail file; closing the client socket releases the binding; `release_force` frees a binding held by another connection.

**GREEN:** extend `server.ts` with per-connection state and `tools.ts` dispatch calling core functions. Reuse `withProjectLock` and `sendMail`.

**Verify/commit:** `feat(daemon): session attachment and tool RPC`.

### Task 6 — Shim: register tools and forward to the daemon

**RED tests:** a test daemon (in-process `createRpcServer`) receives each tool call with the right method/params and returns a formatted reply; the shim turns a daemon error into an MCP `isError` result; `whoami` is **not** registered (no leftover M0 probe).

**GREEN:** `shim/src/daemon-client.ts` (RPC over unix socket, auto-start daemon if absent via `artinareyd` from `packages/daemon`), `shim/src/tools.ts` (zod schemas and handler wiring), `shim/src/index.ts` (`serveStdio`).

**Verify/commit:** `feat(shim): stdio MCP server with eight tools`.

### Task 7 — CLI: `connect opencode` and `release --force`

**RED tests:** `connect opencode` in a temp dir writes `opencode.json` with the shim command, the `mcp.servers` entry and an allow rule per tool, and preserves an existing config's unrelated keys; `release <worktree> --force` calls the daemon and reports the result.

**GREEN:** extend `cli/src/index.ts`. Do not commit any generated `opencode.json`.

**Verify/commit:** `feat(cli): connect opencode and force release`.

### Task 8 — Integration: two directories, two personas, mail both ways through real OpenCode

Create two temp directories with markers and registered worktrees/personas, each with a local `opencode.json` from `connect`. In each, run `opencode run --standalone --auto` with a prompt that forces a specific tool call sequence: `check_in` → `claim_persona(persona_id)` → `send_mail(to=<other persona>)`. Verify two mail files exist (one each direction), each with the expected `from`/`to`, and save the raw output to a local evidence file outside version control.

Record a separate `DIRECTORY_BUSY` run with the same directory claimed twice.

**Verify:** integration test passes; save evidence. Commit `test: real OpenCode two-persona mail exchange`.

### Task 9 — Final verification and docs

Gates green; tick M2 boxes and mark status ✅ in `plan.md`; progress board and README; implementation note + decision record for the pidfd deviation; confirm no `opencode.json` tracked.

Commit `docs: mark M2 complete`.

---

## 6. Stop rules

- No M3+ code, even as stubs. Marker writing here is only the primitive the fixtures need.
- Do not change a settled decision from `plan.md` §17; record the pidfd implementation deviation instead.
- Do not commit `opencode.json` or any generated local config.
- No tool takes a path into the store.

---

## 7. Risk notes

| Risk | Mitigation |
|---|---|
| MCP SDK v2 API differs from v1 examples | Verified exports and `serveStdio` signature against the installed 2.4.0 type definitions before planning. |
| Real OpenCode tool naming / permission rules | Reuse the exact M0 pattern: `mcp.servers.<name>.command` plus `permissions` allow rules named `artinarey_<tool>`. |
| Integration test flakiness on first MCP discovery | M0 showed a transient empty `mcp list`; wait/retry discovery before the run. |
| Daemon auto-start from shim races with two sessions | Single-instance pidfile lock already returns `ALREADY_RUNNING`; treat it as success if the socket answers. |
| Binding released when client disconnects during a test | Integration prompts must finish all tool calls in one `opencode run` per directory. |
