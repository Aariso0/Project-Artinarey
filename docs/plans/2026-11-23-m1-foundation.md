# M1 Foundation — Store, Mail, Registry, Daemon Skeleton

**Branch:** `MO/foundation` (continues from M0)
**Plan date:** 2026-11-23
**Source of truth:** `plan.md` §15 M1 (lines 622–636), §4 architecture, §5 data model, §6 identity, §11 CLI, §16 tests
**Estimate:** 1–1.5 d. Deliver in thin vertical slices; each slice tested, verified, committed.
**Method:** TDD (watch each test fail before writing production code), incremental implementation.

---

## 0. Goal and definition of done

Build the persistent foundation that M2's MCP shim will call. **No shim, no vendor adapter, no GUI, no leases, no approval logic** — those are M2+.

Done when:

1. `pnpm test`, `pnpm typecheck`, and `pnpm lint` pass at the repo root.
2. 50 concurrent `sendMail` calls produce 50 unique ULIDs, 50 immutable mail files, and no loss.
3. A real `kill -9` during a journal write leaves a torn last line that startup recovery discards cleanly.
4. `artinarey daemon start|stop|status` and `artinarey reindex <project>` work against a temp XDG environment.

The source of truth remains **files**; SQLite is a rebuildable index. The daemon is the sole writer.

---

## 1. Scope

**In:** monorepo scaffold, `core` (ids, paths, config, store writer, mail validation, registry, index), `daemon` skeleton, minimal `cli`.

**Out:** MCP shim and tools (M2), worktree manager (M3), leases/git hook (M4), OpenCode adapter and approvals (M5), window (M6/M7), API adapter (M8), storage Move (M7). Do not reopen settled decisions in `plan.md` §17.

---

## 2. Verified environment inputs

| Item | Value |
|---|---|
| pnpm | 10.34.9 |
| Node | v26.13.1 (built-in `node:sqlite` available as fallback) |
| TypeScript | 5.9.3 (pinned: typescript-eslint 8.74 requires `<6.1.0`) |
| tsx | 4.23.15 |
| ulid | 3.0.2 |
| better-sqlite3 | 13.2.0 (test native install in slice 2; fall back to `node:sqlite` if it cannot build) |
| ESLint / typescript-eslint | 10.15.0 / 8.74.0 |

Use `node:test` + `tsx` as the test runner — proven in M0, zero extra dependencies.

---

## 3. Repo layout (created by this plan)

```
package.json                     private root, scripts: test/typecheck/lint/build
pnpm-workspace.yaml
tsconfig.base.json
eslint.config.js
packages/core/
  package.json  tsconfig.json
  src/index.ts  ids.ts  paths.ts  config.ts  errors.ts
  src/store.ts  mail.ts  registry.ts  index-builder.ts
  src/*.test.ts
packages/daemon/
  package.json  tsconfig.json
  src/index.ts  server.ts  lock.ts
  src/*.test.ts
packages/cli/
  package.json  tsconfig.json
  src/index.ts
```

Test convention: `*.test.ts` beside the source file, run with `node --import tsx --test 'packages/*/src/*.test.ts'`.

---

## 4. Shared contracts (fixed now so M2 can build against them)

```typescript
// core/src/errors.ts
export type ArtinareyErrorCode =
  | 'INVALID_INPUT' | 'STORE_OFFLINE' | 'MAIL_REJECTED' | 'NOT_FOUND'
  | 'ALREADY_RUNNING' | 'INDEX_ERROR';
export class ArtinareyError extends Error {
  constructor(public readonly code: ArtinareyErrorCode, message: string) { super(message); }
}
```

```typescript
// core/src/ids.ts
export type ProjectId = string & { readonly __brand: 'ProjectId' };
export type MailId = string & { readonly __brand: 'MailId' };
export function newId(): string;          // ULID, daemon-assigned, sortable
export function isUlid(value: string): boolean;
```

```typescript
// core/src/paths.ts
export type XdgPaths = {
  configDir: string;   // ~/.config/artinarey
  registryFile: string;
  tokenFile: string;
  socketPath: string;  // $XDG_RUNTIME_DIR/artinarey/daemon.sock
  dataRoot: string;    // ~/.local/share/artinarey (user-overridable)
  cacheRoot: string;   // ~/.cache/artinarey
};
export function resolveXdgPaths(env?: NodeJS.ProcessEnv): XdgPaths;
export function projectStore(root: string, projectId: string): string;
```

```typescript
// core/src/store.ts
export function atomicWrite(path: string, content: string, mode?: number): void;
export function appendJournal(path: string, event: unknown): void;   // one JSON line + fsync
export function recoverProject(storeDir: string): RecoveryReport;    // sweep temps, trim torn lines
export type RecoveryReport = { removedTemps: string[]; trimmedLines: number };
```

```typescript
// core/src/mail.ts
export type MailKind = 'task' | 'question' | 'status' | 'decision' | 'blocker' | 'receipt' | 'note';
export type MailInput = {
  id?: string; thread?: string; in_reply_to?: string;
  from: string; to: string[]; cc?: string[];
  subject: string; kind: MailKind; action: string; eta?: string;
  worktree?: string; body: string;
};
export type ValidationResult = { ok: true; value: Required<MailInput> } | { ok: false; reason: string };
export function validateMail(
  input: MailInput,
  ctx: { knownPersonas: string[]; role: string; now?: Date },
): ValidationResult;
export function sendMail(storeDir: string, input: MailInput, ctx: MailContext): Promise<MailRecord>;
```

`sendMail` takes the project write lock (an in-process mutex keyed by store dir), validates, calls `atomicWrite` with mode `0444`, appends `audit.jsonl`, then updates the index. It never returns a path into the store to callers who are agents — the CLI/daemon may use it internally.

```typescript
// core/src/registry.ts
export type Registry = {
  projects: { create(input): Project; get(id): Project | undefined; list(): Project[] };
  worktrees: { upsert(input): void; list(projectId): Worktree[] };
  personas: { create(input): Persona; get(id): Persona | undefined; list(projectId): Persona[] };
  bindings: { bind(personaId, worktreeId): void; forWorktree(worktreeId): Persona | undefined; release(personaId): void };
  sessions: { append(event): void; list(projectId): SessionEvent[] };
  moves: { append(event): void; list(projectId): MoveEvent[] };
  close(): void;
};
export function openRegistry(file: string): Registry;
```

```typescript
// daemon protocol — newline-delimited JSON over $XDG_RUNTIME_DIR/artinarey/daemon.sock
type Request  = { id: string; method: string; params?: unknown };
type Response = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };
```

M1 methods: `ping`, `status`, `shutdown`. M2 adds `check_in`, `send_mail`, etc. on the same transport.

---

## 5. Tasks

### Task 1 — Scaffold the pnpm monorepo and make CI match

Create root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, and the three package manifests. Scripts:

```json
{
  "test": "node --import tsx --test 'packages/*/src/*.test.ts'",
  "typecheck": "tsc --noEmit -p tsconfig.json --pretty false",
  "lint": "eslint packages",
  "build": "tsc --noEmit -p tsconfig.json --pretty false"
}
```

Update `.github/workflows/ci.yml` node job: use `pnpm/action-setup@v4` with `version: 10`, `actions/setup-node@v4` with `cache: pnpm`, then `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`. The `npm ci` job is wrong once a root `package.json` exists. Set workflow-level `permissions: contents: read` and add `persist-credentials: false` to the `actions/checkout@v4` step. Credential persistence is disabled at checkout, not in `actions/setup-node`.

**Verify:** `pnpm install` succeeds, `pnpm test` exits 0 with no tests yet, `pnpm typecheck` clean, `pnpm lint` clean. Commit `chore: scaffold pnpm monorepo`.

### Task 2 — `core`: ids, XDG paths, config loader

**RED tests first:**

- `ids.test.ts`: 1000 `newId()` values are unique and lexicographically sorted by creation order; `isUlid` accepts a real id and rejects `''` and a UUID.
- `paths.test.ts`: with `HOME=/tmp/h`, `XDG_CONFIG_HOME=/tmp/c`, `XDG_DATA_HOME=/tmp/d`, `XDG_RUNTIME_DIR=/tmp/r`, `XDG_CACHE_HOME=/tmp/k`, paths resolve exactly as §5 of `plan.md`; unset overrides fall back to `$HOME/.config` etc.
- `config.test.ts`: missing config file returns defaults (`dataRoot` override empty, spawnCap 3); a valid partial JSON merges; invalid JSON throws `ArtinareyError('INVALID_INPUT')`.

**GREEN:** implement `ids.ts`, `paths.ts`, `config.ts`, `errors.ts`, `index.ts` exports. Use `ulid@3.0.2`.

**Verify:** `pnpm test`, `pnpm typecheck`, `pnpm lint`. Commit `feat(core): ids, XDG paths, config loader`.

### Task 3 — `core`: atomic write and crash recovery

**RED tests first:**

- `store.test.ts`: `atomicWrite` leaves no temp files, creates the file with mode `0444`, and overwriting replaces content atomically.
- `store.test.ts`: a journal ending in `{"id":"tor` (no newline) is trimmed by `recoverProject`; complete lines survive; stray `.tmp-*` files are removed.
- **kill -9 test:** spawn a child `node --import tsx` script that opens `audit.jsonl`, writes a partial JSON line, prints `READY`, then sleeps. Parent kills the child with `SIGKILL` after seeing `READY`; `recoverProject` must leave only complete lines and return `trimmedLines: 1`.

**GREEN:** `atomicWrite` (temp in same dir → fsync file → chmod → rename → fsync dir), `appendJournal` (append + fsync), `recoverProject` (sweep `*.tmp-*`, keep only newline-terminated journal lines), and a per-store-dir in-process mutex (`withProjectLock`).

**Verify:** full `pnpm test` including the kill -9 case. Commit `feat(core): crash-safe store writer`.

### Task 4 — `core`: mail schema, validation, and 50-way concurrency

**RED tests first:**

- `mail.test.ts`: missing `subject`/`kind`/`action` or empty body → `MAIL_REJECTED` with the field named; body over 8 KB rejected; a line resembling `API_KEY=...` or `-----BEGIN` rejected; unknown recipient rejected; broadcasting (`to: []` or wildcard) rejected.
- `mail.test.ts`: valid mail serialises to the exact frontmatter shape in `plan.md` §5, with `thread` defaulting to `id` and `created_at` in UTC.
- `mail.test.ts` (the M1 gate): 50 concurrent `sendMail` calls into one temp store resolve with 50 distinct ids and 50 files exist, all mode `0444`; `audit.jsonl` has 50 complete lines.

**GREEN:** `mail.ts` validation + serialisation; `sendMail` using `withProjectLock`, `newId`, `atomicWrite`, `appendJournal`. Keep the secret tripwire as a small regex list — it is a tripwire, not a scanner.

**Verify:** full suite. Commit `feat(core): mail validation and concurrent send`.

### Task 5 — `core`: registry (SQLite)

**RED tests first:** `registry.test.ts` covers create/get/list for projects, personas, worktrees; bind → `forWorktree`; rebinding the same worktree to a different persona throws (one active persona per directory); release clears the binding; sessions and moves append and list in order.

**GREEN:** `registry.ts` with `better-sqlite3` (or `node:sqlite` if native install fails — record the deviation in the commit message). Tables: `projects`, `worktrees`, `personas`, `bindings`, `sessions`, `moves`. Foreign keys ON; `bindings.worktree_id` UNIQUE.

**Verify:** full suite. Commit `feat(core): SQLite registry`.

### Task 6 — `core`: index builder and `reindex`

**RED tests first:** `index-builder.test.ts` — build from a store with three mail files; query returns them ordered by id; a deleted mail file disappears after rebuild; malformed mail files are skipped without aborting the rebuild.

**GREEN:** `index-builder.ts` writes `~/.cache/artinarey/<project-id>/index.sqlite` with a `mail` table; source of truth stays the files. `cli/src/index.ts` implements `artinarey reindex <project>` reading the registry for the store path.

**Verify:** full suite + run `pnpm --filter @artinarey/cli exec tsx src/index.ts reindex <id>` against a temp project. Commit `feat(core,cli): index builder and reindex`.

### Task 7 — `daemon`: single-instance lock, unix socket, start/stop/status

**RED tests first:**

- `lock.test.ts`: acquiring twice in one process fails with `ALREADY_RUNNING`; a stale lockfile whose pid is dead is replaced automatically.
- `server.test.ts`: start on a temp socket path, send `{"id":"1","method":"ping"}`, get `{"id":"1","ok":true,...}`; an unknown method returns a typed error; `shutdown` closes the socket.

**GREEN:** `lock.ts` (pidfile + `process.kill(pid, 0)` liveness; pidfd is for agent sessions in M2, not the daemon lock), `server.ts` (newline-delimited JSON over `net.createServer`, socket mode 0600), `index.ts` (CLI entry). Extend `cli/src/index.ts` with `daemon start|stop|status` using temp-XDG env in tests.

**Verify:** full suite + manual `status` against a running daemon. Commit `feat(daemon): single instance and unix socket API`.

### Task 8 — Final verification and docs

- Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.
- Tick M1 checkboxes and mark status ✅ in `plan.md`; update progress board and README.
- Confirm no `opencode.json` was committed (`.gitignore` still covers it).
- Run the CI docs checks locally.

Commit `docs: mark M1 complete`.

---

## 6. Stop rules

- Do not implement M2 tools, leases, adapters, or GUI — even if a stub seems convenient.
- Do not change a settled decision from `plan.md` §17.
- If `better-sqlite3` cannot build on Node 26, use built-in `node:sqlite` and record the deviation; do not block the milestone.
- Every new production function has a test that was watched failing first.

---

## 7. Risk notes

| Risk | Mitigation |
|---|---|
| `better-sqlite3` native build on Node 26 | Try install in task 5; fall back to `node:sqlite` (already verified available). |
| kill -9 test flakiness | Use a stdout `READY` handshake before killing; assert on recovered file contents, not timing. |
| CI pnpm cache needs a lockfile | `pnpm install` in task 1 creates `pnpm-lock.yaml`, which is committed. |
| 50-way test could pass with duplicate ids by luck | Assert `new Set(ids).size === 50` and compare file count, not just resolution count. |
