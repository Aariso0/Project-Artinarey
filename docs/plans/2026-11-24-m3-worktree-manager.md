# M3 — Worktree Manager and Home-Worktree Rule Implementation Plan

**Goal:** Make worktrees first-class: parse and reconcile git's view, create/adopt/list/remove them from the CLI, and enforce the home-worktree rule from the terminal.

**Architecture:** Pure parsing and reconciliation live in `core`, git mutations live in a small `core` action module, and the CLI is a thin shell over both. The daemon keeps its M2 binding rules; M3 adds git lock/unlock and a user-facing rehome command without changing the settled identity model.

**Tech Stack:** TypeScript ~5.9.3, Node 26, pnpm workspaces, `node:test` + `tsx`, `better-sqlite3@13.2.0`, git 2.56.

**Spec:** `plan.md` §7 (worktrees), §6 (home-worktree rule), §11 (CLI), §15 M3. This is the authoritative spec; no decision in §17 is reopened.

## Global Constraints

- Keep `rullama-permission` at 0.12.0 and `thiserror` at 1.0.x — not used here, never bump.
- Never edit the tracked `.gitignore`, global git config, or the global ignore file. The exclude block goes only in `$GIT_COMMON_DIR/info/exclude`; global ignore coverage is reported read-only. **M0 validation to close here:** create a real `.worktrees/<name>/` directory with `git worktree add`, then verify from every linked worktree (`git check-ignore -v .worktrees/<name>`) that it is ignored by the shared `$GIT_COMMON_DIR/info/exclude` rule — not just the `.artinarey.json` marker file. Do not make this pass by editing the tracked `.gitignore`.
- `git worktree remove` runs **without** `--force`, and never deletes a branch.
- A persona's home may only be changed to a worktree of the **same project** (`repoCommonDir` comparison).
- Senior dev is exempt from the home-worktree warning.
- Every mismatch, confirmed or refused, writes an `audit.jsonl` line.
- `opencode.json` stays machine-local and gitignored; no generated config is committed.
- TDD: write the failing test, watch it fail, implement, verify, commit each slice. Gates are `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`.

## Review Focus

| Input / condition | Expected behavior | Owning task |
|---|---|---|
| Empty or single-worktree git repo | parser returns exactly the entries git printed, never a phantom row | 1 |
| Global ignore coverage check | reports the result, changes no config file and no tracked file | 2 |
| Preflight failure in `worktree new` | no directory, branch, marker, `.env.*` or registry row is left behind | 5 |
| `worktree remove` on a bound worktree | refused; branch survives; binding untouched | 6 |
| `persona rehome` to a worktree of another project | refused with `INVALID_INPUT` and no audit of a successful rehome | 7 |

---

### Task 1: Porcelain parser

**Files:**
- Create: `packages/core/src/worktree.ts`, `packages/core/src/worktree.test.ts`
- Modify: `packages/core/src/index.ts` (export the module)

**Interfaces:**
- Produces: `export type GitWorktree = { path: string; head: string; branch: string | null; detached: boolean; locked: boolean; prunable: boolean; bare: boolean }`; `export function parseWorktreePorcelain(text: string): GitWorktree[]`; `export function listGitWorktrees(repoDir: string): GitWorktree[]`.

- [ ] **Step 1: RED tests with captured fixtures**

Assert: a normal block yields `{path,head,branch,detached:false,locked:false,prunable:false,bare:false}`; `detached` block has `branch:null,detached:true`; `locked reason` and `prunable reason` set their flags and keep the following block separate; a `bare` block sets `bare:true`; `''` returns `[]`. Also assert `listGitWorktrees(repoRoot)` returns at least the current worktree against this repository.

- [ ] **Step 2: Run `pnpm test` — RED**

Expected: module-not-found for `./worktree.ts` in the new test.

- [ ] **Step 3: Implement the parser and `listGitWorktrees`**

Use `execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repoDir, encoding: 'utf8' })`. Split blocks on blank lines; each key is the first word of a line (`worktree`, `HEAD`, `branch`, `detached`, `locked`, `prunable`, `bare`), the rest is value/reason. Strip `refs/heads/` from `branch`.

- [ ] **Step 4: GREEN + commit**

Run `pnpm test`, then commit `feat(core): parse git worktree porcelain output`.

---

### Task 2: Repo resolution, exclude block, and `artinarey init`

**Files:**
- Modify: `packages/core/src/worktree.ts`, `packages/core/src/worktree.test.ts`
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/connect.test.ts`

**Interfaces:**
- Consumes: `newId`, `projectStore`, `writeMarker` (core); `resolveXdgPaths`, `openRegistry` (core).
- Produces: `export function resolveRepo(cwd: string): { root: string; commonDir: string }`; `export function ensureExcludeBlock(commonDir: string): void`; `export function globalIgnoreCoverage(repoDir: string): { globalFile: string | null; coversWorktrees: boolean }`.

- [ ] **Step 1: RED tests**

Assert `resolveRepo` on a real git temp repo returns a root whose marker resolves and a `commonDir` that exists. Assert `ensureExcludeBlock` called twice leaves exactly one managed block containing `.worktrees/`, `.artinarey.json`, `.env.artinarey` and preserves unrelated lines. Assert `globalIgnoreCoverage` on a repo with no global excludes returns `{globalFile:null,coversWorktrees:false}` and leaves both the repo `.gitignore` and global config unchanged. Assert CLI `init` in that repo: creates the marker with the new project/worktree ids, creates a registry project with `repoCommonDir`, writes the exclude block, prints `global ignore` coverage, and is idempotent on a second run (no duplicate project).

- [ ] **Step 2: Run `pnpm test` — RED**

Expected: `resolveRepo is not a function` / `unknown command: init`.

- [ ] **Step 3: Implement**

`resolveRepo` uses `git rev-parse --show-toplevel` and `--git-common-dir` (resolve a relative common dir against root). Exclude block delimiters are `# >>> artinarey >>>` / `# <<< artinarey <<<`, written to `join(commonDir, 'info', 'exclude')`. `globalIgnoreCoverage` reads `git config --global --get core.excludesFile` and uses `git check-ignore --no-index -v .worktrees/probe`; it never writes. CLI `init` resolves repo from `cwd`, ensures the block, creates/reuses the project by `repoCommonDir`, upserts the main worktree, writes the marker, and prints a one-line coverage report.

- [ ] **Step 4: GREEN + commit**

Run `pnpm test`, then commit `feat(cli): init registers a project and writes the marker`.

---

### Task 3: Reconciliation and `worktree list`

**Files:**
- Modify: `packages/core/src/worktree.ts`, `packages/core/src/worktree.test.ts`
- Modify: `packages/core/src/identity.ts`, `packages/core/src/identity.test.ts`
- Modify: `packages/daemon/src/tools.test.ts`
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/connect.test.ts`

**Interfaces:**
- Consumes: `Registry`, `Worktree`, `GitWorktree`.
- Produces: `export type ReconciledWorktree = { path: string; branch: string | null; head: string; state: 'managed' | 'unmanaged' | 'missing'; worktreeId?: string; flag?: 'moved' | 'branch_changed' }`; `export function reconcileWorktrees(registry: Registry, projectId: string, gitWorktrees: GitWorktree[]): ReconciledWorktree[]`.

- [ ] **Step 1: RED tests**

Fixture: three registered worktrees, git reports one at the same path, one at the same branch but a new path, one absent; git also reports an unregistered path. Assert states `managed`, `moved`, `missing`, `unmanaged` respectively, that `worktreeId` is present for registered rows, and that output order is git entries first, then missing rows. Assert CLI `worktree list` prints each state and never prints a registry id for `unmanaged`.

- [ ] **Step 2: Run `pnpm test` — RED**

Expected: `reconcileWorktrees is not a function` / `unknown command: worktree`.

- [ ] **Step 3: Implement**

Normalize paths with `realpathSync` when they exist, else `resolve`. Match registered rows to git entries by path first, then by branch. Missing rows use their registered path and `branch`. CLI `worktree list` resolves the project from the marker, calls `listGitWorktrees` on the repo root, then `reconcileWorktrees`.

- [ ] **Step 4: RED test for paused bindings**

In `packages/daemon/src/tools.test.ts`, assert that `attach` over RPC on a registered worktree whose branch changed in git returns `WORKTREE_UNMANAGED` with a "changed branch" message, leaving no binding. Watch it fail.

- [ ] **Step 5: Implement the pause**

In `resolveIdentity`, when a git worktree is found for the marker path and its branch differs from the registered branch, return `WORKTREE_UNMANAGED` with "branch changed; confirm the move". A moved path is already caught by the existing realpath check.

- [ ] **Step 6: GREEN + commit**

Run `pnpm test`, then commit `feat(core): worktree reconciliation and list`.

---

### Task 4: Registry port offsets

**Files:**
- Modify: `packages/core/src/registry.ts`, `packages/core/src/registry.test.ts`

**Interfaces:**
- Consumes: existing `Registry`.
- Produces: `Worktree.portOffset: number`; `WorktreeInput.portOffset?: number` (default `0`); `worktrees.delete(id: string): void`; schema migration adds `port_offset INTEGER NOT NULL DEFAULT 0` to existing databases.

- [ ] **Step 1: RED tests**

Assert an opened legacy database (created with the old schema helper in the test) gains the column and existing rows read `portOffset: 0`. Assert `upsert({..., portOffset: 30})` round-trips and `delete(id)` removes only that row.

- [ ] **Step 2: Run `pnpm test` — RED**

Expected: `portOffset is not a function`/`undefined` and no `delete` on `worktrees`.

- [ ] **Step 3: Implement**

After `db.exec(SCHEMA)`, check `PRAGMA table_info(worktrees)` and `ALTER TABLE worktrees ADD COLUMN port_offset INTEGER NOT NULL DEFAULT 0` when absent. Add the column to `SCHEMA` for fresh databases, map it in `toWorktree`, and add `delete`.

- [ ] **Step 4: GREEN + commit**

Run `pnpm test`, then commit `feat(core): persist worktree port offsets`.

---

### Task 5: `worktree new` with preflight and C4 warning

**Files:**
- Modify: `packages/core/src/worktree.ts`, `packages/core/src/worktree.test.ts`
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/connect.test.ts`

**Interfaces:**
- Consumes: `resolveRepo`, `ensureExcludeBlock`, `reconcileWorktrees`, `Registry.worktrees.upsert`.
- Produces: `export type WorktreePlan = { path: string; branch: string; base: string; portOffset: number; copy: string[]; envFile: string }`; `export function planWorktree(registry: Registry, projectId: string, repoRoot: string, name: string, base?: string): WorktreePlan`; `export function createWorktree(registry: Registry, storeDir: string, plan: WorktreePlan): Worktree`.

- [ ] **Step 1: RED tests**

Assert `planWorktree` rejects a name with `/`, an existing target directory, an existing branch, and a missing base ref with `INVALID_INPUT` before anything is created. Assert a valid plan has path `<root>/.worktrees/<name>`, branch `artinarey/<name>`, `portOffset = existingCount * 10`, `copy` containing only env files that actually exist, and `envFile` ending `.env.artinarey`. Assert `createWorktree` runs `git worktree add`, writes the marker, writes `ARTINAREY_PORT_OFFSET=<n>` to `envFile`, copies the listed files, and registers a worktree. Assert CLI without `--yes` prints the C4 warning and makes no changes; with `--yes` it succeeds.

- [ ] **Step 2: Run `pnpm test` — RED**

Expected: `planWorktree is not a function`.

- [ ] **Step 3: Implement**

Preflight uses `existsSync`, `git show-ref --verify --quiet refs/heads/<branch>`, and `git rev-parse --verify <base>`. Use `execFileSync('git', ['worktree','add',path,'-b',branch,base], {cwd: repoRoot})`. Create env files with mode 0600. Never register or write a marker if any git command fails.

- [ ] **Step 4: GREEN + commit**

Run `pnpm test`, then commit `feat(cli): create worktrees with preflight and port offsets`.

---

### Task 6: Adopt, remove, and lock while bound

**Files:**
- Modify: `packages/core/src/worktree.ts`, `packages/core/src/worktree.test.ts`
- Modify: `packages/core/src/identity.ts` (lock/unlock hooks), `packages/cli/src/index.ts`, `packages/cli/src/connect.test.ts`

**Interfaces:**
- Consumes: `writeMarker`, `reconcileWorktrees`, `releasePersona` (identity).
- Produces: `export function adoptWorktree(registry: Registry, storeDir: string, projectId: string, path: string): Worktree`; `export function removeWorktree(registry: Registry, projectId: string, id: string): void`; `export function lockGitWorktree(markerDir: string, reason: string): boolean`; `export function unlockGitWorktree(markerDir: string): boolean`. Lock helpers return `false` outside a git worktree so M2 temp-dir tests stay green.

- [ ] **Step 1: RED tests**

Assert `adoptWorktree` on an unmanaged git worktree writes the marker and registers it with the branch from porcelain. Assert `removeWorktree` refuses a registered worktree whose persona is bound with `INVALID_INPUT`, leaves the branch present, then succeeds after release and deletes only the registry row. Assert `lockGitWorktree`/`unlockGitWorktree` return `true` on a real git worktree and `false` in a plain temp dir. Assert CLI `worktree adopt <path>` and `worktree remove <name>` produce the same outcomes.

- [ ] **Step 2: Run `pnpm test` — RED**

Expected: `adoptWorktree is not a function`.

- [ ] **Step 3: Implement**

Adopt checks the path is inside the project's common git dir and not already registered. Remove calls `git worktree remove <path>` with no `--force`, then `worktrees.delete`. In `claimPersona`, after a successful bind, call `lockGitWorktree(identity.markerDir, persona.role)`; in `releasePersona` and `releaseWorktreeForce`, call `unlockGitWorktree` using the persona's registered worktree path. Ignore `false` returns and keep the existing audit lines.

- [ ] **Step 4: GREEN + commit**

Run `pnpm test`, then commit `feat(cli): adopt and remove worktrees with binding lock`.

---

### Task 7: Home-worktree rule from the CLI

**Files:**
- Modify: `packages/core/src/identity.ts`, `packages/core/src/identity.test.ts`
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/connect.test.ts`

**Interfaces:**
- Consumes: `claimPersona`, `registry`, persona store, audit.
- Produces: `export function rehomePersona(registry: Registry, storeDir: string, personaId: string, worktreeId: string): { ok: true } | { ok: false; code: 'INVALID_INPUT' | 'NOT_FOUND'; message: string }`.

- [ ] **Step 1: RED tests**

Assert `rehomePersona` refuses a worktree belonging to another project, refuses an unknown persona/worktree, and on success updates `persona.json.home_worktree_id` plus an audit line. Assert `persona rehome` CLI mirrors it. Assert `claimPersona` still returns `NEEDS_CONFIRMATION` for a non-senior persona homed elsewhere and succeeds for `senior-dev` without confirmation (both already covered in M2; extend with the rehome CLI path).

- [ ] **Step 2: Run `pnpm test` — RED**

Expected: `rehomePersona is not a function` / `unknown command: persona`.

- [ ] **Step 3: Implement**

`rehomePersona` verifies both records exist and share `projectId`, then writes the persona store and audits `persona_rehome`. CLI `persona list` prints role/name/home/state; `persona rehome <persona> <worktree>` resolves ids by exact id or unique role/path and calls the core function.

- [ ] **Step 4: GREEN + commit**

Run `pnpm test`, then commit `feat(cli): persona list and project-scoped rehome`.

---

### Task 8: `artinarey run <vendor>`

**Files:**
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/connect.test.ts`

**Interfaces:**
- Consumes: `resolveIdentity`, `claimPersona`, `releasePersona`, `reconcileWorktrees`, `listGitWorktrees`, `registry.sessions.append`.
- Produces: CLI command only: `artinarey run opencode [--persona P] [--confirm-move] [--rehome] [--yes]`.

- [ ] **Step 1: RED tests**

With a stubbed vendor command (env var `ARTINAREY_TEST_VENDOR` naming a script that prints a marker and exits), assert `run` binds the persona, appends a session with start and end times, execs the vendor in the marker directory, releases the binding on normal exit and on non-zero exit. Assert a home mismatch without flags prints the warning and binds nothing; with `--confirm-move` it binds. Assert an unknown vendor returns 2.

- [ ] **Step 2: Run `pnpm test` — RED**

Expected: `unknown command: run`.

- [ ] **Step 3: Implement**

Resolve identity from `cwd`; reconcile and refuse `WORKTREE_UNMANAGED`; claim the requested persona (or require `--persona` — no silent default). On `NEEDS_CONFIRMATION`, print the warning and accept `--confirm-move`/`--rehome`; when stdin is a TTY and no flag was given, prompt `y/N`. Use `spawn` with `stdio: 'inherit'`, `cwd: identity.markerDir`; append the session before spawn, set `endedAt` in `finally`, release in `finally`, and return the child's exit code.

- [ ] **Step 4: GREEN + commit**

Run `pnpm test`, then commit `feat(cli): run a vendor with bind and release`.

---

### Task 9: Final verification and docs

**Files:** Modify `plan.md`, `README.md`.

- [ ] **Step 1: Run all gates**

`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` — all green.

- [ ] **Step 2: Real CLI smoke check**

In a temp git repo: `init` → `worktree list` → `worktree new smoke --yes` → `worktree list` → `worktree remove smoke` → `worktree list`. Record results in the local, untracked notes.

- [ ] **Step 3: Update docs**

Tick the eight M3 boxes in `plan.md` §15, set status ✅, fill notes with test/gate/smoke results; set README progress to 4 of 9 with M3 ✅.

- [ ] **Step 4: Commit**

`docs: mark M3 complete`.

---

## Stop rules

- No M4+ code, even as stubs: no leases, hooks, plugin, GUI, or adapter.
- Do not commit generated `opencode.json`, `.env` copies, or local notes.
- Do not edit the tracked `.gitignore`, global config or global ignore file.
- Do not change a settled decision in `plan.md` §17; record any implementation deviation in the local notes and in §15.
