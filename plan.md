# Project-Artinarey: Plan

> **Next action:** run **M0, the spike** (section 15, M0). About 2 hours. It checks the identity assumption against real tools.
> **Status:** design settled, implementation unverified. Nothing is built. Plan date: 2026-11-23. All 15 design questions, the 3 open questions and the 14 unverified assumptions were resolved on 2026-11-23; several answers changed the design (section 17).
> **Estimates** are my guesses, not measurements. Treat them as ±50%.
> **Evidence** for every checked assumption is in section 17. Where evidence contradicted the design, the decision log (section 2) records what replaced it.

---

## Progress board

Legend: ⬜ not started · 🟨 in progress · ✅ done · 🟥 blocked

**Overall:** `█░░░░░░░░░░░░░░░░░` 1 of 9 milestones done · **Slice 1 (M0–M6):** 1 of 7 done

| M | Goal | Estimate | Status | Part of |
|---|---|---|---|---|
| M0 | Spike: does the shim see the agent's folder? | 2 h | ✅ | Slice 1 |
| M1 | Store, mail files, registry, daemon skeleton | 1–1.5 d | ⬜ | Slice 1 |
| M2 | MCP shim, tools, identity by folder | 1 d | ⬜ | Slice 1 |
| M3 | Worktree manager, home-worktree warnings, `run` | 1 d | ⬜ | Slice 1 |
| M4 | Leases, git hook, pre-merge check | 1 d | ⬜ | Slice 1 |
| M5 | OpenCode adapter, spawn cap, role cards | 2 d | ⬜ | Slice 1 |
| M6 | Read-only desktop window | 1.5 d | ⬜ | Slice 1 |
| M7 | Full window: chat, dialogs, approvals, **Move** | 4–5 d | ⬜ | Slice 2 |
| M8 | Model API adapter (other vendors postponed) | 2 d | ⬜ | Slice 2 |

How to use this board: when you finish a task inside a milestone (section 15), tick its box there. When all boxes are ticked, change the milestone's status here and in its own section, and add a line to the progress log (section 19).

### Decision tracker
- **Made:** 15 of 15 questions (section 2), plus the 3 open questions and the follow-up decisions below, all on 2026-11-23.
- **Open questions resolved:** cap = 3 running sessions **per project** (soft; over-cap needs your approval); marker = `.artinarey.json`; senior dev spawns under the cap without asking, and may also assign work directly to an idle persona on the same branch.
- **Follow-up decisions:** containment is worktree-only with user-approved exceptions; the auto-approve toggle is user-only, per worktree, OFF by default, enforced in Artinarey's shim; blocked sessions wait indefinitely with desktop notifications at 0/5/15 minutes; approval happens in the GUI or CLI depending on how the agent was launched; the native Tauri shell proxies daemon calls; pidfd replaces parent-pid liveness; OpenCode is the only vendor for now, with a separate model-API adapter using a configurable base URL.

### Verification tracker
Each row flips to ✅ verified, or 🟥 failed (then the fallback in the last column applies). Details in section 17.

| ID | What must be true | Needed by | Status | Result / design change |
|---|---|---|---|---|
| U1 | Vendor launches the shim in the agent's folder | M0 | ✅ | OpenCode: cwd defaults to the workspace/project folder; config is discovered from cwd upward. |
| U2 | Subagents inherit parent's MCP and folder | M0 | 🟥 | Not documented; custom subagents use their own permissions. Moot: the senior dev spawns independent sessions, not subagents (section 9). |
| U3 | OpenCode plugin can abort an edit call | M4 | ✅ | `ctx.permission.hook("evaluate")` can set `effect = "deny"`. `execute.before` cannot abort. |
| U4 | `opencode serve` auth and per-worktree permissions | M5 | 🟥 | Auth is localhost plus password/Basic (fixed username `opencode`). OpenCode has no per-worktree config; worktree config loads from the canonical checkout. The toggle moves into the shim. |
| U5 | Antigravity stdio and project config | M8 | 🟥 | Paths verified, but headless needs cached credentials and soft-denies approvals with exit 0. Adapter postponed. |
| U6 | Codex project config: folder option and headers | M8 | 🟥 | `cwd` and static `http_headers` verified; the project layer loads only in trusted projects. Adapter postponed. |
| U7 | Claude Code project MCP config location | M8 | 🟥 | `.mcp.json` verified; "A cloned repository can't approve its own servers". Adapter postponed. |
| U8 | `info/exclude` and hooks shared across worktrees | M0 | ✅ | Shared via `$GIT_COMMON_DIR`; `core.hooksPath` can override it. |
| U9 | Free-plan limits and regional access | M5 | 🟥 | No official 200/day figure; official pricing uses requests per 5 hours and monthly limits. Free-tier models work only inside OpenCode (403 elsewhere). |
| U10 | Tauri webview origin and daemon access | M6 | 🟥 | Origin varies by platform and can be `null`; Tauri says never handle secrets in the frontend. Native shell proxy with a per-platform allowlist (section 12). |
| U11 | Which MCP clients use the 2026-07-28 revision | M2 | ✅ | OpenCode probes or opts in; Claude Code needs the v2 runtime; Codex unconfirmed. The stateless shim supports both revisions. |
| U12 | Name "Artinarey" is free | before publishing | ✅ | No footprint in npm, PyPI, crates.io, GitHub or `.com` RDAP on 2026-11-23. Negative evidence, not proof. |
| U13 | OS is Linux | M1 | ✅ | User confirmed on 2026-11-23: Linux for now. |
| U14 | Parent-pid liveness as release signal | M2 | 🟥 | `ppid` changes on reparenting and PIDs are reused. Use pidfd (section 6). |

### Spike results (fill in during M0)

| Check | OpenCode | Notes |
|---|---|---|
| Shim `cwd` in main dir | ✅ `/mnt/shareddata/projects/Project-Artinarey` | `opencode run --standalone --auto`, tool returned cwd; MCP config was local and gitignored, with an explicit `artinarey_m0_whoami` allow rule (2026-11-23) |
| Shim `cwd` in a worktree | ✅ `/mnt/shareddata/projects/Project-Artinarey-m0-wt` | Same tool call from the linked worktree; local `opencode.json` copied there; first `mcp list` was transiently empty, retry connected (2026-11-23) |
| `info/exclude` covers marker in a worktree | ✅ shared common file applies | `git check-ignore -v` in the worktree reported `.git/info/exclude:7:.artinarey.json`; `git status --short` stayed clean (2026-11-23) |
| Shared hook fires from a worktree commit | ✅ worktree `pwd` in log | `core.hooksPath` set to an absolute path in common config; log line showed `/mnt/shareddata/projects/Project-Artinarey-m0-wt` (2026-11-23) |
| `opencode serve` session in a worktree loads MCP config | ✅ cwd = worktree, canonical = main | `POST /api/session` with `location.directory` worked; `GET /api/location?location[directory]=…` returned `project.canonical = /mnt/shareddata/projects/Project-Artinarey` (2026-11-23) |

---

## 0. How to read this

1. Progress board (above): where we are.
2. Sections 1–3: what we are building and every decision.
3. Sections 4–12: the design (architecture, data, identity, worktrees, leases, sessions, tools, CLI, window).
4. Sections 13–14: security and storage move.
5. Sections 15–19: milestones as checklists, tests, verification results, errors, progress log.

---

## 1. What and why

**Project-Artinarey** is a local app that lets AI coding agents work **in parallel on one project** without overwriting each other, and talk to each other in a controlled way. OpenCode is supported first; a separate adapter can call a model API through a configurable base URL.

Why it exists:
- One agent at a time is slow.
- Parallel agents in one folder overwrite each other.
- Agents from different tools cannot talk to each other.
- The incident that motivated the controls: in July 2026 about 1,200 agents on an unsanctioned shared message board coordinated, and about 700 went on to attack Hugging Face. Lesson: coordination must be addressed, capped, logged, and approved. It must never be open broadcast.
- Containment is a hard requirement: an agent stays inside its assigned worktree. Anything that reaches outside it needs your approval.

### Goals
1. Parallel work: one worktree and one branch per working persona.
2. Controlled mail: addressed messages only, delivered through an MCP server.
3. One senior dev per project allocates work; code validates the allocation.
4. A desktop window showing every project, persona, worktree, mail thread, and where the records are stored.
5. Storage the user chooses, with a Move button.
6. Works with OpenCode first, plus a separate adapter that calls a model API through a configurable base URL.
7. Everything local for mail, storage and routing; only the separate API adapter calls a model API.
8. Work outside the assigned worktree is detected and needs your approval.

### Non-goals (v1)
- No automatic merging or PR creation (B4 c: the user merges by hand).
- No cloud sync, accounts, or telemetry.
- No OS sandbox for agents in v1 (accepted risk, section 13). Containment is enforced by Artinarey's shim, not by the kernel, and detection can be bypassed.
- No Windows or macOS support (Linux confirmed 2026-11-23).
- No LLM inside the daemon. All routing and validation is plain code. The model-API adapter is a separate process.

---

## 2. Decision log

| ID | Question | Decision |
|---|---|---|
| A1 | How an MCP call knows the caller | **c: the working directory is the identity.** |
| A2 | Vendor session IDs | **a: capture for daemon-launched sessions only**, stored as an optional field. |
| A3 | Resume | **a: default is a fresh session that reads the persona's handoff note.** "Resume exact session" is optional when the vendor ID is known and the adapter supports it. |
| A4 | Hand-launched sessions | **default (a):** `artinarey run <vendor>` wrapper binds and warns; plain launch still works through `check_in`. |
| B1 | Home-worktree rule | **a: soft.** Warn and confirm in CLI and GUI, log it. The senior dev roams. |
| B2 | Truth for worktrees | **default (a):** daemon registry keyed by path and branch, reconciled against `git worktree list --porcelain`. |
| B3 | Worktree location | **a: `<repo>/.worktrees/`**, ignored through `.git/info/exclude`. Global ignore is checked and reported, never edited. |
| B4 | Merging | **c: the user merges everything by hand.** |
| C1 | Unattended permissions | **superseded:** worktree-confined commands proceed; calls that reach outside the assigned worktree ask the user. A user-only toggle is per worktree and defaults to OFF. Residual detection risk accepted, section 13. |
| C2 | Spawn cap | **a: 3 running sessions per project.** Above that, show a warning phrased around token consumption; you may proceed, the senior dev needs your approval. Artinarey does not measure tokens. |
| C3 | Build order | **superseded:** OpenCode only for now. Claude Code, Codex and Antigravity are postponed. A separate adapter process calls a model API through a configurable base URL. |
| C4 | Ports and env | **a: per-worktree port offsets plus copying env files, with a warning shown first.** |
| D1 | Language | **a: TypeScript** for daemon, shim, plugin, GUI frontend. |
| D2 | GUI shell | **b: Tauri from day one.** |
| D3 | First slice | **a: daemon, MCP, OpenCode adapter, CLI, read-only GUI list.** |
| Storage | Store format | **B: mail as immutable files; tasks and events as append-only journals; SQLite is only a rebuildable local index.** |
| Name | Project name | **Project-Artinarey** (CLI: `artinarey`). No clash found in checked public registries on 2026-11-23. |
| Net | Network | Local only for mail, storage and routing. The separate API adapter is the only component that calls a model API. Whatever an agent reads goes to its model provider (accepted). |
| Contain | Boundary | The agent's assigned worktree only. Network access, other worktrees, and global git operations such as `git push` and `git tag` need your approval. Local commands, including a Python script that only writes inside the worktree, proceed. Detection is heuristic and bypassable (section 13). |
| Toggle | Auto-approve | User-only, per worktree, OFF by default, with a very obvious button in the worktree view. When ON, risky worktree-confined calls are auto-approved; out-of-worktree calls still ask. Enforced in Artinarey's shim and permission hook, not in OpenCode config. |
| Approve | Blocking | A risky call blocks the agent indefinitely until approved. OS desktop notification immediately, again at 5 minutes, again at 15 minutes, then silence. Approval in the GUI or CLI, depending on how the agent was launched. |
| Persona | Assignment | The senior dev may spawn new independent sessions or assign work to an idle persona on the same branch (priority). It must be active to assign, or you assign directly. Direct assignments still get lease checks. The senior dev cannot delete personas. |
| API | Model access | OpenCode only for now. A separate adapter process calls a model API through a configurable base URL; the daemon still has no LLM and no outbound calls. |
| GUI | Daemon auth | The webview holds no secret. The native Tauri shell proxies daemon calls, and the daemon checks a per-platform Origin allowlist. |
| Liveness | Session release | A pidfd-based process handle, not the parent PID. Manual force-release stays. |

### Interactions between decisions (read these)
1. **A1 c + one persona per directory.** Directory identity means two personas cannot share a directory. The daemon enforces one active persona per directory. A second session there is refused (`DIRECTORY_BUSY`) unless the user takes over.
2. **Senior dev sessions, not subagents.** The senior dev spawns completely new independent sessions that keep running when it is idle. It never creates subagents. Subagent permission inheritance is not documented and is not relied on.
3. **A1 c depends on the shim's working directory equalling the agent's.** OpenCode docs say the MCP `cwd` defaults to the workspace/project folder; M0 confirms it with real worktrees.
4. **B4 c + leases.** Because nothing merges itself, the real checkpoint is the pre-merge check (section 8), not the commit hook.
5. **Containment + leases.** Leases limit edits; the shim's permission hook additionally gates calls that reach outside the assigned worktree. Detection is best-effort, not a sandbox. See section 13.
6. **Toggle + shim.** OpenCode loads config from the canonical checkout, so per-worktree toggle state lives in Artinarey's registry and is enforced by the shim.
7. **API adapter + local-only.** The adapter is the only outbound caller; mail, routing and validation stay inside the daemon.

---

## 3. Glossary

| Term | Meaning |
|---|---|
| **Project** | One git repository (identified by its common git dir) registered with Artinarey. |
| **Worktree** | A git worktree of the project: the main directory plus any under `.worktrees/` or elsewhere. |
| **Persona** | A durable identity: role, mailbox, journal, home worktree. Outlives sessions. |
| **Session** | One running agent process or conversation for a persona. Temporary. |
| **Senior dev** | The one persona per project that assigns work and requests sessions. |
| **Lease** | The set of paths a task owns while it is in progress. |
| **Store** | A project's records on disk (mail, journals). Movable. |
| **Marker** | `.artinarey.json` in a directory; says which project and worktree it is. |
| **Shim** | `artinarey-mcp`, the stdio MCP server each vendor launches; forwards to the daemon and enforces the per-worktree approval rule. |
| **Risky call** | A command that reaches outside the assigned worktree: network access, another worktree, or a global git operation such as `git push` or `git tag`. |
| **Auto-approve toggle** | A user-only switch per worktree, OFF by default, that allows risky calls confined to the worktree. |
| **Approval** | Your decision to let one blocked call proceed; also the GUI card and CLI prompt that ask for it. |
| **API adapter** | A separate process that talks to a model API through a configurable base URL. |
| **Daemon** | `artinareyd`, the only writer of the store. |

---

## 4. Architecture

### Processes
| Process | Role | Lifetime |
|---|---|---|
| `artinareyd` | Single writer. Registry, store, mail, tasks, leases, sessions, adapters, API. | Runs independently of the GUI. Started on demand by the shim, CLI, or GUI. |
| `artinarey-mcp` (shim) | stdio MCP server. One per agent session. Stateless. Adds `cwd` and `pid`, forwards to the daemon. | Lives and dies with the vendor session. |
| `artinarey` (CLI) | Human commands. | Per command. |
| Artinarey window | Tauri v2 app, React + TypeScript frontend. | Optional. Agents work with it closed. |
| `opencode serve` | Managed by the OpenCode adapter. | Started by the daemon when needed. |
| API adapter | Calls a model API through a configurable base URL. The only process allowed to make that outbound call. | Started by the daemon when needed. |

### Why this shape
- stdio MCP servers start once per session. State cannot live there, or parallel agents corrupt the store. So: thin shim, one daemon.
- The MCP design is **stateless**: no server-side protocol session. The 2026-07-28 MCP revision removed protocol sessions and deprecated roots. OpenCode probes or opts in, Claude Code needs its v2 runtime, and Codex is unconfirmed, so the shim works with both revisions. Identity comes from the directory, never from the protocol session.

### Transport
- Shim and CLI to daemon: **unix socket** at `$XDG_RUNTIME_DIR/artinarey/daemon.sock` (mode 0600).
- GUI to daemon: the webview calls only Tauri commands; the native shell makes HTTP requests to `127.0.0.1:<ephemeral port>` with a bearer token it holds (mode 0600 file). No secret is stored in the webview. The daemon rejects requests whose `Host` is not loopback and checks `Origin` against an allowlist: `tauri://localhost` on Linux/macOS, `http(s)://tauri.localhost` on Windows/Android; `null` is rejected. Port is written to `~/.config/artinarey/daemon.json`.
- The daemon makes no outbound network calls except to localhost (the managed `opencode serve`). The separate API adapter is the only process that calls a model API.

### Language and tooling
TypeScript, Node LTS for the daemon (match OpenCode's plugin runtime), pnpm workspaces, the official MCP TypeScript SDK, `better-sqlite3` for the index, Tauri v2 with React + Vite for the window.

### Repo layout
```text
project-artinarey/
  packages/
    core/            types, ids, store, mail, leases, worktree, overlap
    daemon/          artinareyd
    shim/            artinarey-mcp
    cli/             artinarey
    adapters/
      opencode/      M5
      api/           M8  model API via configurable base URL
    opencode-plugin/ lease guard (M4/M5)
  apps/gui/          Tauri + React
  assets/roles/      role cards (senior-dev, developer, researcher, tester)
  docs/
  README.md  plan.md  logo.py
```

---

## 5. Data model and storage (approach B)

### Locations (Linux/XDG; changeable)
| What | Default path | Notes |
|---|---|---|
| Config | `~/.config/artinarey/config.json` | data root, spawn cap, UI prefs |
| Registry | `~/.config/artinarey/registry.sqlite` | projects, store paths, worktrees, bindings, sessions, moves, per-worktree auto-approve toggle and pending approvals. Always local. Never moved. |
| Token | `~/.config/artinarey/token` | 0600 |
| Socket | `$XDG_RUNTIME_DIR/artinarey/daemon.sock` | 0600 |
| Data root | `~/.local/share/artinarey/` | **the user picks this**; put it on the big drive. Per-project override allowed. |
| Index cache | `~/.cache/artinarey/<project-id>/index.sqlite` | rebuildable; local even if the store is on a slow drive |

### Project store (the moved unit)
```text
<data-root>/<project-id>/
  project.json                 id, name, repo common dir, created, schema_version
  manifest.json                sha256 per file (written by Move)
  personas/<persona-id>/
    persona.json               role, name, home_worktree_id, state, vendor, last_vendor_session_id
    status.md                  overwritten by `report`
    handoff.md                 latest handoff; older ones in handoffs/<utc>.md
  mail/<yyyy>/<mm>/<mail-id>.md   IMMUTABLE (mode 0444)
  events/
    tasks.jsonl                append-only
    leases.jsonl               append-only
    sessions.jsonl             append-only
    audit.jsonl                append-only
```
- `persona.json`, `status.md`, `handoff.md` are the only mutable files. The daemon rewrites them atomically (temp file, fsync, rename).
- The daemon is the **sole writer**. No agent ever opens a store path. Agents do not know where it is.
- The SQLite index is derived from the files and can be rebuilt with `artinarey reindex <project>`.
- Source of truth is the files. If index and files disagree, files win.

### IDs and ordering
- All IDs are ULIDs assigned by the daemon (sortable, unique across concurrent callers).
- Ordering is by ULID, not wall-clock.

### Mail file format
Markdown with YAML frontmatter.
```markdown
---
id: 01JD...            # ULID
thread: 01JD...        # first mail's id
in_reply_to: 01JD...   # optional
from: dev-auth         # persona id
to: [senior-dev]
cc: []
subject: Login endpoint done
kind: status           # task | question | status | decision | blocker | receipt | note
action: Review branch artinarey/auth-api, 2 min
eta: 2 min             # optional
worktree: auth-api
created_at: 2026-11-23T10:15:00Z
---
ACTION: Review branch `artinarey/auth-api`.

1. Run `git diff main...artinarey/auth-api --stat`  (1 min)
2. Reply `done` or list problems  (1 min)

Done: endpoint, tests (12 pass). Not done: rate limiting.
```
Rules the daemon enforces (`MAIL_REJECTED` with the reason):
1. `subject`, `kind`, `action` required; body not empty.
2. Body max 8 KB. Longer content goes in a file the sender links to by path.
3. Secret-pattern tripwire (keys, tokens, `.env` lines). A tripwire, not a scanner.
4. Recipients must exist and the sender must be allowed to mail them (section 10).
5. No pasted source over 40 lines; link to the path instead.
Style (shared with chatter): ACTION first, numbered steps, time estimates, no preamble.

### Write protocol (crash safety)
1. Daemon takes the project write lock (in-process; one daemon).
2. Mail: write temp file in the target folder, fsync, `chmod 0444`, rename into place, fsync directory, then append an audit line, then update the index.
3. Journals: append one JSON line per event with fsync.
4. If the process dies mid-way, startup scans for temp files and journals with a torn last line, discards the torn line, and rebuilds the index for that project.

---

## 6. Identity and personas (A1 c, A2 a, A3 a, A4)

### The marker
`.artinarey.json` in the main directory and in every managed worktree:
```json
{ "schema": 1, "project_id": "01JD...", "worktree_id": "01JD..." }
```
- It holds **IDs only**. No store path (agents stay ignorant of storage) and no persona (identity is resolved by directory).
- Listed in `.git/info/exclude`. Written by `artinarey init` (main) and by worktree create/adopt.
- Naming note: you first called this `persona.json`. The per-persona file with that name now lives in the store. The marker keeps a different name so the two are never confused. Renaming it is a one-line change if you prefer.

### Resolving "who is calling" (every MCP call)
1. Shim reads `process.cwd()` and opens a stable process handle (pidfd) for liveness. OpenCode docs say the MCP `cwd` defaults to the workspace/project folder; M0 confirms it with real worktrees.
2. Shim walks up from `cwd` to find `.artinarey.json`. None: `NO_PROJECT`.
3. Daemon looks up `worktree_id`. It checks that the marker directory's realpath equals the registered path and the branch matches. Else `WORKTREE_UNMANAGED`.
4. Daemon finds the persona bound to that worktree. None: the caller must `check_in` and `claim_persona`.
5. Every later call resolves the same way. No tokens, no session IDs.

### Persona lifecycle
`new` → `idle` ⇄ `active (bound to one directory)` → `retired`.
- **One active persona per directory.** A second claim returns `DIRECTORY_BUSY`.
- **Release** happens when: the shim disconnects and a pidfd reports the process is gone, the `artinarey run` wrapper exits, the GUI session ends, or the user force-releases in GUI or CLI. Parent PID is not used: it changes on reparenting and can be reused.
- **Take over** (user only): GUI or `artinarey release <worktree> --force`.

### First session in a project
The agent calls `check_in`. With no personas, it is told to ask the user which role to start as (developer, researcher, tester, senior dev). Then `claim_persona(new_role=...)`.

### Later sessions (your flow)
1. `check_in` returns the **roster**: each persona's name, role, state, home worktree, and a one-line "last task" summary.
2. The agent shows the roster to the user. The user picks one of: resume a persona, give it something new, or start a new persona.
3. `claim_persona(...)` binds it to this directory.

### Home-worktree warning (B1 a)
- Every persona has `home_worktree_id` (set at first bind).
- Claiming a persona in a different worktree returns `NEEDS_CONFIRMATION` with the warning. The agent relays it; the caller must repeat the claim with `confirm_move=true`. The user can also choose `rehome=true` to make this the new home.
- Same warning appears in `artinarey run` (terminal prompt) and in the GUI (dialog).
- **Senior dev is exempt** and may bind anywhere.
- Every mismatch, confirmed or refused, is written to `audit.jsonl`.
- The GUI can **edit a persona's home worktree**, limited to worktrees of the **same project** (checked by comparing `git rev-parse --git-common-dir`).

### Vendor session IDs (A2 a)
Captured only when the daemon launches the session, from the adapter's output. Only OpenCode applies in v1; the others are listed for when those adapters are revisited:
- OpenCode: from the session object the server returns when creating a session.
- Claude Code: `session_id` in headless JSON output.
- Codex: `thread_id` in `--json` events.
- Antigravity: not launched by Artinarey in v1.

Stored as `persona.json.last_vendor_session_id` plus a line in `sessions.jsonl`. Mail never binds to it.

### Resume (A3 a)
- **Default:** new session, role card plus the persona's `handoff.md` plus open tasks. Cheap on a quota-limited plan.
- **Resume exact session:** GUI button, shown only when an ID is known and the adapter supports it. Costs more because the old context reloads, and can fail if the vendor pruned it.

### Hand-launched sessions (A4 default)
- `artinarey run <vendor> [--persona P]` in a directory: checks marker, reconciles worktrees, applies the home-worktree warning, binds the persona to the directory, execs the vendor CLI, and releases on exit.
- Plain launch (`opencode` typed by hand) still works if the vendor's MCP config points at the shim: the agent calls `check_in`.
- `artinarey connect <tool>` writes the vendor MCP entry. Config locations differ per vendor (section 17).

---

## 7. Worktrees (B1–B3, C4)

### Location and ignoring (B3 a)
- Worktrees live in `<repo>/.worktrees/<name>`.
- `artinarey` adds a managed block to **`.git/info/exclude`** (verified shared across worktrees via `$GIT_COMMON_DIR`): `.worktrees/`, `.artinarey.json`, `.env.artinarey`.
- It then checks whether the **global ignore** also covers `.worktrees/` (`git config --global --get core.excludesFile`, `git check-ignore -v`) and **reports** the result. It never edits global config or the global ignore file, and never edits the project's tracked `.gitignore`.
- Known downside: tools such as pytest, tsc, and eslint scan into `.worktrees/` unless configured to skip it. ripgrep respects ignore files.
- OpenCode has no per-worktree config: worktree creation and refresh load config from the project's saved canonical checkout. Per-worktree state (port offsets, auto-approve toggle) lives in Artinarey's registry and shim, not in an OpenCode config file inside the worktree.

### Create (GUI "New worktree" and `artinarey worktree new`)
Preflight, all must pass (nothing is changed before the user confirms):
1. Repo root and common git dir resolved.
2. `.worktrees/<name>` does not exist.
3. Branch `artinarey/<name>` does not exist (`git show-ref`); git itself refuses a branch already checked out elsewhere.
4. Base ref exists (default: current branch of the main directory).
5. `info/exclude` block present or will be added.
6. **C4 warning dialog** lists exactly what Artinarey will auto-generate or copy, for example:
   - create `.artinarey.json`
   - create `.env.artinarey` with `ARTINAREY_PORT_OFFSET=<n×10>`
   - copy `.env`, `.env.local` (from the project's include list)
   The user must confirm. CLI needs `--yes`. Copying `.env` duplicates secrets onto disk; that is why it is listed explicitly.
7. Run `git worktree add .worktrees/<name> -b artinarey/<name> <base>`.
8. Write the marker, register in the registry.

### Adopt
GUI "Adopt" or `artinarey worktree adopt <path>` for worktrees created elsewhere (vendors create their own). Writes the marker and registry entry after the same warning dialog.

### Reconcile (B2)
`git worktree list --porcelain` is parsed (blocks with `worktree`, `HEAD`, `branch`, `detached`, `locked`, `prunable`, `bare`). Runs on: daemon start, before every spawn or bind, GUI refresh (debounced 2 s), and `worktree list`.
- In git, not in registry: **unmanaged** (shown with an Adopt button).
- In registry, not in git: **missing/prunable** (shown; never auto-deleted).
- Moved path or changed branch: flagged, binding paused until the user confirms.

### Lock
While a persona is bound, the daemon runs `git worktree lock --reason "artinarey: <persona> active"` and unlocks on release. Prevents accidental `worktree remove` or prune.

### Remove
GUI or CLI refuses if a persona is bound. Uses `git worktree remove` without `--force`. **Never deletes a branch.**

### Ports and env (C4 a)
- Offset = (worktree index) × 10, stored in the registry, exposed as `ARTINAREY_PORT_OFFSET` in `.env.artinarey`.
- Agents are told in their role card to add the offset to any port they bind.
- Not solved here: shared databases and external services (documented limitation).

---

## 8. Leases and enforcement

### Task and scope
A task has `scope`: a list of repo-relative paths, directory prefixes, or globs.

### Overlap check (deterministic)
- On `assign_task` or `request_scope`, the daemon compares the new scope to every in-progress lease.
- Overlap is true if either path is a prefix of the other after normalising wildcards. If the daemon cannot decide (complex globs), it **treats it as overlap**.
- Overlap returns `LEASE_OVERLAP` with the conflicting task. The senior dev must re-scope.

### Hot shared files
Project config `shared_files` (lockfiles, `package.json`, migrations directory, CI config). These cannot be in two leases. Access is serialised: one task at a time holds the file lock (`claim_shared`).

### Who may assign
The senior dev assigns tasks, and so can you by talking to a persona directly. Both paths carry a scope and pass the same overlap check. The senior dev must be active to assign; when it is idle, either start it or assign the work yourself. An idle persona on the same branch has priority over spawning a new session. The senior dev cannot delete personas.

### Chained work
The senior dev may stack steps on an agent: do a step, ask you to approve, then do the next. Each approval gate uses the same blocking and notification rules as section 9. If a call never gets approved, the rest of the chain waits with it.

### Three checkpoints
| # | Where | Covers | Bypass |
|---|---|---|---|
| 1 | OpenCode plugin `permission.evaluate` before an action runs | can set `effect = "deny"`; also gates calls that reach outside the worktree | other tools; a pre-configured `deny` skips the hook |
| 2 | Pre-commit hook in the common hooks dir: `artinarey lease-check --staged` | every vendor | `git commit --no-verify` |
| 3 | **Pre-merge check:** `artinarey verify <branch>` and a GUI panel compare `merge-base..branch` changed files to the lease | catches bypasses of 1 and 2 | none (it is what you read before merging) |

- Hooks are installed in the shared hooks directory. If `core.hooksPath` is already set, Artinarey **does not override it**; it prints the one line to add.
- Checkpoints 1–2 are prevention only for OpenCode; elsewhere they are detection. Checkpoint 3 is the real gate because you merge by hand (B4 c).

---

## 9. Sessions and adapters

### Spawn flow
1. An **active** senior dev calls `request_session(role, task_id, vendor?, worktree_id?)`, or you assign work directly to a persona. Direct assignments get the same checks; the senior dev does not have to be involved.
2. Daemon validates: task exists and has a lease, target worktree exists, persona free. If an idle persona on the **same branch** can take the work, it gets priority over a new session.
3. Under the cap: spawn immediately. At or over the cap: show a warning phrased around token consumption; you may proceed, but a senior-dev request creates a **pending approval** and waits for you (`CAP_REACHED` with the approval ID). Artinarey does not measure tokens.
4. Spawn: bind persona to the directory, lock the worktree, launch via the adapter, record the session. The new session is completely independent and keeps running when the senior dev is idle. The senior dev never creates subagents and cannot delete personas.
5. The agent receives its first prompt: role card, task, scope, "call `check_in` first". Chained steps are stored with the task; each waits at its own approval gate.

**Cap (C2 a):** 3 running sessions **per project**, soft. Configurable; over-cap needs your approval when the senior dev asks.
**Agents never launch processes.** Only the daemon does.

### Approval flow
- A call that reaches outside the assigned worktree is **risky**: network access, another worktree, or a global git operation such as `git push` or `git tag`. Local commands, including a Python script that only writes inside the worktree, proceed.
- With the auto-approve toggle OFF, risky calls create a pending approval and **block the agent indefinitely** until you decide. There is no timeout auto-fail. A blocked session still counts toward the cap.
- OS desktop notification immediately, again at 5 minutes, again at 15 minutes, then silence.
- Approve in the GUI (approval card) or in the CLI (`artinarey approvals`, `artinarey approve <id>`), depending on how the agent was launched. Both write the same audit entry.
- The **auto-approve toggle** is user-only, per worktree, OFF by default, and has a prominent button in the worktree view. When ON it auto-approves risky calls that are still confined to the worktree; out-of-worktree calls always ask. It lives in the shim, not in OpenCode config.

### OpenCode adapter (first)
- Manage one `opencode serve` on 127.0.0.1 (random port). Auth is localhost-only plus a fixed username `opencode` and a configurable password.
- Create a session scoped to the worktree directory. The server accepts the directory per request (header or query parameter), so one server handles many worktrees. OpenCode has had worktree session-scoping bugs, so the **registry**, not OpenCode's session list, is the truth.
- Send the initial prompt, subscribe to events for status, abort via the API.
- OpenCode loads config from the canonical checkout, so there is **no per-worktree OpenCode config**. The shim's permission hook enforces the per-worktree toggle and the risky-call rule.
- Model: from `config.json`. Free-tier models work only inside OpenCode; other harnesses get HTTP 403 even with a key.

### Model API adapter (M8)
- A **separate process**, started by the daemon, that calls a model API through a **configurable base URL**. No provider is hardcoded.
- It is the only component allowed to make an outbound model-API call. The daemon still has no LLM and no outbound network calls except to localhost.
- The daemon passes prompts and results over the local socket; API keys stay with the adapter process.

### Postponed vendors
Claude Code, Codex and Antigravity are postponed, not cancelled. Verified blockers:
- Claude Code: `.mcp.json` works, but "a cloned repository can't approve its own servers"; needs v2 runtime for the 2026-07-28 revision.
- Codex: `cwd` and static `http_headers` exist, but project config loads only in trusted projects; 2026-07-28 support is unconfirmed.
- Antigravity: stdio config paths verified, but headless needs cached credentials and **soft-denies** approval-requiring tools with exit 0.
Revisit after M8 with explicit trust and credential provisioning.

### Supervision
- The daemon records a pidfd-based process handle, start time, vendor, worktree, persona for each session in `sessions.jsonl` and the registry. Parent PID is not used: reparenting changes it and PIDs are reused.
- Spawned processes are detached so a daemon restart does not kill them; on startup the daemon re-adopts live handles and marks dead ones `failed`. Manual force-release stays.
- Full session logs go under `~/.cache/artinarey/logs/` (large, disposable, not part of the moved store). Only summaries go in the store.

### Quota awareness
v1 counts requests per vendor per day (best effort) and shows them in the GUI. No hard enforcement, no token measurement, no cost figure. The over-cap warning uses token wording because users may be on free models; a cost estimate would be misleading. Free-tier models are OpenCode-only, so parallel agents on one plan share its request limits.

---

## 10. MCP tools

Rules: every reply is short, ends with `unread: N` and `next: <one action>`. Errors say **stop** or **retry after**, never leave the agent guessing. No tool takes a path into the store.

| # | Tool | Who | Does |
|---|---|---|---|
| 1 | `check_in()` | all | Returns project, worktree, bound persona or the roster, unread count, next action. |
| 2 | `claim_persona(persona_id \| new_role, name?, confirm_move?, rehome?)` | all | Binds a persona to this directory. May return `NEEDS_CONFIRMATION`. |
| 3 | `inbox(limit=5, include_read=false)` | all | Lists mail for the bound persona. |
| 4 | `read_mail(id)` | all | One mail. Own mail only. |
| 5 | `send_mail(to[], cc[], subject, kind, action, eta?, body, in_reply_to?)` | all | Role rules below. |
| 6 | `mark_done(id, note)` | all | Marks done in own state; mails the sender a receipt. |
| 7 | `report(now, done, next, blocked)` | all | Overwrites own `status.md`; shown live in the GUI. |
| 8 | `task_update(task_id, status, note)` | assignee | `in_progress`, `blocked`, `ready_for_review`. |
| 9 | `request_scope(task_id, paths[], reason)` | assignee | Mails the senior dev, raises a GUI approval, checks overlap. |
| 10 | `handoff(title, body)` | all | Writes `handoff.md`; sets persona idle. |
| 11 | `assign_task(persona_id, title, scope[], body)` | senior dev | Creates the task, checks overlap, mails the assignee. |
| 12 | `request_session(role, task_id, vendor?, worktree_id?)` | senior dev | Section 9. |
| 13 | `worktrees()` | all | Read-only list with branches and home personas. |

### Who may mail whom
- Everyone may mail the senior dev and the user.
- The senior dev may mail anyone.
- Other personas may mail each other only on a task both are assigned to, or when copied by the senior dev.
- No broadcast, no wildcard recipients.
- **User to persona messages** (from the GUI) are rank-1 and are automatically copied to the senior dev unless the target is the senior dev.

### Checking mail without polling
Agents only see mail when they call a tool. To avoid paid polling turns: every reply carries `unread: N`, the first prompt makes `check_in` mandatory, and role cards say to call `inbox` at task start and task end only.

---

## 11. CLI reference (planned)

```text
artinarey init                               register repo, write marker, install hooks, exclude block
artinarey storage set <path> [--project P]   choose data root
artinarey storage show                       where each project lives, size, free space, online/offline
artinarey move <project> <dest>              section 14
artinarey reindex <project>
artinarey worktree new <name> [--base REF] [--yes]
artinarey worktree list | adopt <path> | remove <name>
artinarey persona list | new <role> [name] | rehome <persona> <worktree>
artinarey run <vendor> [--persona P]         bind, warn, exec vendor CLI, release on exit
artinarey release <worktree> [--force]
artinarey status                             who is where, doing what, unread counts
artinarey approvals                          list pending risky-call and over-cap approvals
artinarey approve <id>                       approve one blocked call (user only)
artinarey auto-approve <worktree> on|off     per-worktree toggle (user only, default off)
artinarey connect <tool>                     write the vendor's MCP entry
artinarey lease-check [--staged]             used by the git hook
artinarey verify <branch>                    pre-merge check
artinarey daemon start|stop|status
artinarey doctor                             checks: daemon, hooks, exclude block, global ignore, worktrees, store online
```

---

## 12. Window (Tauri v2, D2 b)

Style: minimal, dark. Background `#0d1117`, text `#e6edf3`, accent green `#2ea043`, secondary accent Claude orange `#d97757`. (Approximations of GitHub and Claude colours, not official palettes.)

### Screens
1. **Projects:** list with store path, size, free space on that drive, status chip (active, paused, moving, offline). Button: Open, Move.
2. **Project view** (tabs):
   - **Personas:** role, state, home worktree (editable within the project), last task, unread count, Start / Resume / Release.
   - **Worktrees:** managed, unmanaged (Adopt), missing. Branch, ahead/behind, lease status. New worktree (with the C4 warning dialog). Prominent **auto-approve toggle** (user-only, per worktree, OFF by default).
   - **Mail:** threads by persona, newest first, filter by kind.
   - **Tasks & leases:** table with scope, owner, status, overlap warnings.
   - **Sessions:** running and past; PID, vendor, worktree; Stop.
   - **Pre-merge:** per branch, changed files vs lease, red flags. No merge button (B4 c).
   - **Audit:** append-only log view.
3. **Chat:** one persona at a time. Live session: message delivered through the adapter. No live session: queued as mail, with a "start a session?" prompt.
4. **Approvals tray:** risky calls, spawn over cap, scope requests, persona takeover. Shows which agent is blocked and how long it has waited.
5. **Settings:** data root, spawn cap, shared files, env include list, port offset step.

### v1 scope (D3 a)
Slice 1 has a read-only window: Projects, Personas, Worktrees, Mail list. Chat, worktree creation, approvals, and Move arrive in M7.

---

## 13. Security and accepted risks

### Controls
1. Local only: unix socket for agents; the webview holds no token and calls only Tauri commands, so the native shell makes daemon requests over loopback. The daemon checks Host and an Origin allowlist (`tauri://localhost` on Linux/macOS, `http(s)://tauri.localhost` on Windows/Android; `null` rejected).
2. Directories 0700, files 0600, mail 0444.
3. Secret-pattern tripwire on mail.
4. Append-only audit of mail, spawns, approvals, toggle flips, takeovers, mismatches, and moves.
5. Shim permission hook (`permission.evaluate` can `deny`) gates edit calls and calls that reach outside the assigned worktree. The per-worktree toggle is user-only and defaults to OFF.
6. Spawn cap, role-based tool permissions, deterministic overlap check, pidfd-based liveness.
7. No network client in the daemon except to localhost (enforced by a lint rule and review); the separate API adapter is the only outbound caller.

### Accepted risks (you chose these)
1. **Containment is detection, not a sandbox.** The shim detects out-of-worktree intent with command and path heuristics and asks you, but detection can be bypassed: `curl` launched from inside the worktree reaches the network, and `python -c "open('/etc/passwd')"` contains no outside path. You accepted this residual risk on 2026-11-23. There is no dedicated OS user, container, or egress limit in v1; reopen only if you change your mind. Public docs must say out-of-worktree use is **detected and approval-gated**, never "impossible".
2. **"Local only" is partial.** Anything an agent reads reaches its model provider, and the separate API adapter calls a model API. Keep secrets out of mail. Free-plan data policies are not checked.
3. **Hooks can be skipped** (`--no-verify`). Checkpoint 3 (pre-merge check) is the backstop.
4. **Directory identity can be spoofed** by an agent that `cd`s into another worktree and calls the tools. This also weakens containment detection. Mitigations: the daemon logs the directory on every call, takes over only through the user, and flags a persona that calls from a directory that is not its binding.
5. **A blocked agent waits forever** if you never answer. Notifications stop after 15 minutes and the session keeps its cap slot. By design: no auto-fail, no timeout release.

---

## 14. Storage relocation (Move)

### Preflight (nothing changes)
1. Destination exists, is writable, and has free space of at least 1.2 × project size.
2. Project has no running sessions (or the user chooses to stop them).
3. Destination is not inside the repo.
4. Show the preview: size, file count, destination free space.

### Procedure
Journalled in the registry (`moves` table) so a crash can resume or roll back.
1. **Pause:** project state `paused`. Agents get `PROJECT_PAUSED` with "stop, do not retry for N minutes" so they do not burn quota in retry loops.
2. **Copy** the project folder to `<dest>/<project-id>.incoming/` (never into the live location).
3. **Verify:** compute sha256 for every file, compare with the source, write `manifest.json`.
4. **Switch:** in one registry transaction, set the project's store path to the destination and state to `moving-confirm`.
5. **Rebuild** the index from the new location.
6. **Resume:** project `active`; agents work against the new store.
7. **Keep the old copy** untouched until the user presses "Delete old copy" (an explicit second confirmation). Until then "Undo move" switches the pointer back (only valid if no mail was written since; otherwise the GUI offers to copy new files back first).

### Offline destinations
If the drive is unplugged: project status `offline`, agents get `STORE_OFFLINE` ("stop; tell the user"), and the daemon **never creates an empty replacement store**. When the path returns, the user presses Reconnect and the daemon verifies `project.json` ids match.

### Not supported
SQLite or the index on a network share. The store is plain files so it is safe on any mounted drive; the index stays local.

---

## 15. Milestones (progress tracking)

Tick boxes as tasks finish. Estimates are guesses. Slice 1 (M0–M6) ≈ 8–9 working days. Everything ≈ 3.5–4.5 weeks full-time; part-time, double it.

### M0 · Spike
**Status:** ✅ · **Estimate:** 2 h · **Depends on:** nothing · **Confirms:** U1, U8 in practice

Goal: confirm the working-directory identity (A1 c) with real tools before writing code. Documentation research already answered these questions; this is a hands-on check, not open research. One permanent item is included by request: Dependabot plus CI automatic checks (task 6); unlike the rest of M0, those files are kept.

- [x] 1. Write a tiny stdio MCP server (TypeScript) with one tool returning `process.cwd()`, `argv`, and the environment variable names
- [x] 2. Register it in OpenCode's project MCP config; call the tool in the main directory and again inside a git worktree; record both `cwd` values
- [x] 3. Create a worktree; run `git check-ignore -v .artinarey.json` with the entry only in `.git/info/exclude`; commit in the worktree and confirm a hook in the shared hooks directory fires
- [x] 4. Start `opencode serve`; create a session scoped to a worktree; confirm the shim's `cwd` is that worktree and that config comes from the canonical checkout
- [x] 5. Fill in the Spike results table
- [x] 6. Add Dependabot and CI automatic checks (`.github/dependabot.yml`, `.github/workflows/ci.yml`) — repository infrastructure, retained after the spike

**Done when:** every check has a recorded result.
**Exit rule:** if the shim's `cwd` is not the worktree, fall back to a static header or environment value supplied per session by the daemon (identity still tied to the directory record). Subagents and Codex are out of scope; both were settled in section 17.
**Notes / blockers:**

### M1 · Store, mail, registry, daemon skeleton
**Status:** ⬜ · **Estimate:** 1–1.5 d · **Depends on:** M0 · **Checks:** U13

- [ ] pnpm monorepo scaffold (TypeScript config, lint, test runner)
- [ ] `core`: ULID ids, XDG path helpers, config loader
- [ ] Store writer: atomic write (temp, fsync, rename), mail mode 0444, append-only journals, torn-line recovery
- [ ] Mail schema and validation (required fields, 8 KB cap, secret tripwire, recipient rules)
- [ ] Registry (SQLite): projects, worktrees, personas, bindings, sessions, moves
- [ ] Index builder and `artinarey reindex`
- [ ] Daemon skeleton: unix socket API, start/stop/status, single-instance lock
- [ ] Test: 50 parallel `send_mail` give unique ids and none lost
- [ ] Test: `kill -9` mid-write recovers cleanly

**Done when:** the two tests above pass.
**Notes / blockers:**

### M2 · MCP shim, tools, identity by folder
**Status:** ⬜ · **Estimate:** 1 d · **Depends on:** M1 · **Checks:** U11, U14

- [ ] Shim: stdio MCP server using the official SDK; forwards `cwd` and a pidfd-based liveness handle to the daemon
- [ ] Marker finder and the resolver: folder to worktree to persona
- [ ] Tools 1–7 and 13 (`check_in`, `claim_persona`, `inbox`, `read_mail`, `send_mail`, `mark_done`, `report`, `worktrees`)
- [ ] Reply format (`unread`, `next`) and error texts that say stop or retry-after
- [ ] Roster, `DIRECTORY_BUSY`, release rules, force release
- [ ] `artinarey connect opencode`
- [ ] Test: two directories, two personas, mail both ways through real OpenCode

**Done when:** the real-OpenCode mail test passes.
**Notes / blockers:**

### M3 · Worktree manager and home-worktree rule
**Status:** ⬜ · **Estimate:** 1 d · **Depends on:** M2

- [ ] Parser for `git worktree list --porcelain` with captured fixtures (detached, locked, prunable, bare)
- [ ] Reconcile: managed, unmanaged, missing
- [ ] `artinarey init`: marker, exclude block, registry entry, report of global ignore coverage (read-only)
- [ ] `worktree new`: preflight, C4 warning, port offset, env copy
- [ ] `worktree adopt` and `remove`; lock and unlock while bound
- [ ] Home-worktree rule: warning, confirm, `rehome`, audit line; senior dev exempt
- [ ] `artinarey run <vendor>`: bind, warn, exec, release on exit
- [ ] `persona rehome` (same project only)

**Done when:** create, adopt, list, remove all work, and the warning fires on a mismatch.
**Notes / blockers:**

### M4 · Leases and enforcement
**Status:** ⬜ · **Estimate:** 1 d · **Depends on:** M3 · **Checks:** U3

- [ ] Task journal; tools 8, 9, 11 (`task_update`, `request_scope`, `assign_task`)
- [ ] Overlap checker, including undecidable globs treated as overlap, with tests
- [ ] `shared_files` serialisation
- [ ] Pre-commit hook in the shared hooks directory; `core.hooksPath` detection; `artinarey lease-check`
- [ ] `artinarey verify <branch>`
- [ ] OpenCode plugin lease guard using `permission.evaluate` (U3 confirmed)

**Done when:** overlap is rejected and a `--no-verify` commit is caught by `verify`.
**Notes / blockers:**

### M5 · OpenCode adapter and spawning
**Status:** ⬜ · **Estimate:** 2 d · **Depends on:** M4 · **Checks:** U4, U9

- [ ] Manage one `opencode serve` instance
- [ ] Create a session scoped to a worktree directory; capture the session id (A2 a)
- [ ] First prompt built from role card, handoff note, task, scope
- [ ] Shim permission hook: risky-call detection, per-worktree toggle, pending approvals
- [ ] Tool 12 `request_session`; cap 3 per project; over-cap warning and CLI approval path
- [ ] CLI approval commands (`approvals`, `approve`) and OS desktop notifications at 0/5/15 minutes
- [ ] Supervision: pidfd handles, re-adopt after daemon restart, logs under the cache folder
- [ ] Role cards: senior dev, developer, researcher, tester
- [ ] **Record the accepted risk:** section 13 containment limits documented in the README; an OS sandbox stays out of scope unless you reopen it

**Done when:** a senior dev spawns a developer in a worktree and the cap holds.
**Notes / blockers:**

### M6 · Read-only window (Slice 1 complete)
**Status:** ⬜ · **Estimate:** 1.5 d · **Depends on:** M5 · **Checks:** U10

- [ ] Tauri v2 scaffold with React and Vite
- [ ] Native Tauri command proxy; no token in the webview; daemon Host and Origin allowlist checks
- [ ] Projects screen: store path, size, free space, status chip
- [ ] Personas, Worktrees, Mail list (read-only)
- [ ] Theme (GitHub-dark plus Claude orange) and the logo
- [ ] Slice 1 acceptance run: senior dev and two developers on one project, seen in the window

**Done when:** the acceptance run works end to end.
**Notes / blockers:**

### M7 · Full window and Move
**Status:** ⬜ · **Estimate:** 4–5 d · **Depends on:** M6

- [ ] Chat: live through the adapter; queued as mail when no session; copy to senior dev
- [ ] New worktree and Adopt dialogs with the C4 warning
- [ ] Edit a persona's home worktree (same project only)
- [ ] Approvals tray: risky calls, spawn over cap, scope requests, takeover; per-worktree auto-approve button
- [ ] Tabs: Tasks and leases, Sessions, Pre-merge, Audit
- [ ] Storage settings: data root, per-project override, `storage set`
- [ ] Move wizard: preflight, pause, copy, verify, switch, rebuild, resume, undo, delete-old confirmation
- [ ] Offline store handling (`STORE_OFFLINE`, Reconnect)
- [ ] Tests: `kill -9` during Move; unplugged drive

**Done when:** Move survives a crash and an offline drive.
**Notes / blockers:**

### M8 · Model API adapter (other vendors postponed)
**Status:** ⬜ · **Estimate:** 2 d · **Depends on:** M7 · **Checks:** U5, U6, U7

Goal: let Artinarey reach a model directly without putting an LLM in the daemon.

- [ ] Separate adapter process, started and stopped by the daemon
- [ ] Configurable base URL; no hardcoded provider; API key held by the adapter only
- [ ] Local socket protocol for prompts and results; the daemon stays localhost-only
- [ ] Tests: the daemon makes no outbound call; the adapter is the only outbound caller
- [ ] Document why Claude Code, Codex and Antigravity are postponed (section 9)

**Done when:** a task can run through the API adapter and the daemon still makes no outbound call.
**Notes / blockers:**

---

## 16. Test plan

| Layer | What |
|---|---|
| Unit | ULID ordering; mail validation; overlap check (including undecidable globs); `worktree list --porcelain` parser using real captured output (detached, locked, prunable, bare); atomic write; torn-journal recovery |
| Integration | Temp repo with 4 worktrees; fake agents calling the shim; 50 concurrent `send_mail`; role-permission matrix; `DIRECTORY_BUSY`; home-worktree warning path; spawn cap and approval |
| Failure | `kill -9` during mail write and during Move; unplug-drive simulation; stale binding; moved or deleted worktree directory; `core.hooksPath` set |
| Security | Wrong Host header, wrong Origin (including `null`), missing token; spoofed directory; secret in mail; out-of-worktree command prompts; toggle stays user-only and OFF by default; blocked agent waits; notification cadence; every flip audited |
| End to end | Real OpenCode: senior dev assigns two non-overlapping tasks, two developers work in two worktrees, one edits outside its lease and `verify` flags it; one risky call blocks and is approved from the CLI or GUI |

---

## 17. Verification results and resolved questions

All 14 assumptions and all 3 open questions were resolved on **2026-11-23** against official docs where available. Section 0 is the compact view; this section keeps the evidence. Where evidence contradicted the design, section 2 records what replaced it.

### Verified assumptions
1. **U1 — VERIFIED.** OpenCode MCP `cwd` defaults to the workspace/project folder and config is discovered from cwd upward. Caveat: docs say "workspace", not literally "agent cwd"; M0 confirms with real worktrees. Evidence: `opencode.ai/docs/mcp-servers`, `opencode.ai/docs/config`.
2. **U2 — CONTRADICTED / MOOT.** No official doc says subagents inherit MCP servers and cwd; custom subagents use their own permissions. Moot: the senior dev spawns independent sessions, never subagents (section 9). Evidence: `opencode.ai/docs/agents`, `opencode.ai/docs/permissions`.
3. **U3 — VERIFIED.** `ctx.permission.hook("evaluate")` can set `effect = "deny"` before an action runs; `ctx.tool.hook("execute.before")` only inspects/replaces input. V1 and V2 hook APIs differ. Evidence: `opencode.ai/docs/build/plugins/server`.
4. **U4 — CONTRADICTED.** `opencode serve` is localhost-only with a fixed username `opencode` and a configurable password (Basic auth). There is no per-worktree config: worktree config loads from the canonical checkout. The toggle moved into the shim. Evidence: `opencode.ai/docs/cli/web`, `opencode.ai/docs/config`.
5. **U5 — VERIFIED WITH CAVEATS / POSTPONED.** Paths `~/.gemini/config/mcp_config.json` and `<workspace>/.agents/mcp_config.json` plus stdio `command`/`args`/`env`/`cwd` are documented. Headless needs cached credentials and soft-denies approval-requiring tools with exit 0. Evidence: `antigravity.google/docs/mcp`, `antigravity.google/docs/cli/headless`.
6. **U6 — VERIFIED WITH CAVEAT / POSTPONED.** `cwd` and static `http_headers` exist in `config.toml`, but the project layer loads only in trusted projects. Evidence: `developers.openai.com/codex/mcp`, `/codex/config-file/config-basic.md`.
7. **U7 — VERIFIED WITH CAVEAT / POSTPONED.** Project MCP lives in `.mcp.json` at the project root and can be committed, but "a cloned repository can't approve its own servers". Evidence: `docs.claude.com/en/docs/claude-code/mcp`.
8. **U8 — VERIFIED.** `.git/info/exclude` and the default hooks directory resolve through `$GIT_COMMON_DIR` and are shared across linked worktrees; `core.hooksPath` can override. Evidence: `git-scm.com/docs/gitrepository-layout`, `/docs/githooks`, `/docs/worktree`.
9. **U9 — CONTRADICTED.** No official 200 requests/day figure; official pricing uses requests per 5 hours and monthly limits. IP is used for regional/request limiting. Free-tier models return HTTP 403 outside OpenCode. Evidence: `opencode.ai/docs/zen`, `/docs/console/models`, `/docs/console/harnesses`, `/legal/privacy-policy`.
10. **U10 — CONTRADICTED.** The webview Origin varies (`tauri://localhost` on Linux/macOS, `http(s)://tauri.localhost` on Windows/Android, `null` for data URLs) and Tauri says never handle secrets in the frontend. The native shell now proxies daemon calls and the daemon checks an allowlist. Evidence: Tauri `protocol/mod.rs`, `manager/webview.rs`, `v2.tauri.app/concept/process-model`.
11. **U11 — VERIFIED.** OpenCode probes or opts into the 2026-07-28 revision; Claude Code needs the v2 runtime; Codex is unconfirmed. Roots are deprecated, not removed. The stateless shim supports both revisions. Evidence: `modelcontextprotocol.io/specification/2026-07-28/changelog`, `opencode.ai/docs/mcp-servers`, `code.claude.com/docs/en/mcp`, `developers.openai.com/codex/mcp`.
12. **U12 — NO FOOTPRINT FOUND.** 0 npm, PyPI, crates.io and GitHub results and no `.com` RDAP record on 2026-11-23. Negative evidence, not proof of global nonexistence.
13. **U13 — VERIFIED.** User confirmed Linux for now; XDG paths and a unix socket are valid. Revisit for macOS/Windows.
14. **U14 — CONTRADICTED.** On reparenting, `ppid` changes to init or a subreaper, and PIDs are reused. Use a pidfd-based handle; manual force-release stays. Evidence: `man7.org/linux/man-pages/man2/getppid.2.html`, `PR_SET_CHILD_SUBREAPER.2const.html`, `pidfd_send_signal.2.html`.

### Resolved open questions
1. **Spawn cap:** 3 running sessions **per project**, soft. Over the cap, show a warning phrased around token consumption (not measured); you may proceed, the senior dev waits for your approval.
2. **Marker name:** `.artinarey.json` stays; the per-persona `persona.json` file in the store is distinct.
3. **Senior dev spawning:** yes, under the cap without asking, and it may assign work directly to an idle persona on the same branch (priority). It cannot delete personas. Sessions are independent, not subagents.

### Containment decisions made during verification
- Boundary is the agent's **assigned worktree only**; another worktree of the same project is outside it.
- Calls that reach outside are detected and need your approval; detection is heuristic and bypassable (section 13).
- The auto-approve toggle is user-only, per worktree, OFF by default, and enforced in the shim.
- Blocked agents wait indefinitely; OS desktop notifications at 0/5/15 minutes, then silence; approval in GUI or CLI.
- Direct user assignments get the same lease checks as senior-dev assignments.

---

## 18. Error codes

| Code | Meaning | Agent is told |
|---|---|---|
| `NO_PROJECT` | No marker found | Stop. Tell the user to run `artinarey init`. |
| `WORKTREE_UNMANAGED` | Marker does not match the registry | Stop. Tell the user to adopt this worktree. |
| `DIRECTORY_BUSY` | Another persona is bound here | Stop. Tell the user. |
| `NEEDS_CONFIRMATION` | Home-worktree mismatch | Ask the user, then repeat with `confirm_move=true`. |
| `FORBIDDEN_ROLE` | Tool not allowed for this role | Do not retry. |
| `LEASE_OVERLAP` | Scope collides with another lease | Senior dev: re-scope. Others: ask the senior dev. |
| `CAP_REACHED` | Spawn cap hit; approval ID given | Wait for the user. Do not retry. |
| `PROJECT_PAUSED` | Move in progress | Stop. Do not retry before `retry_after`. |
| `STORE_OFFLINE` | Store drive unavailable | Stop. Tell the user. |
| `MAIL_REJECTED` | Validation failed (reason given) | Fix and resend once. |
| `NOT_FOUND` | Unknown id | Do not guess; call `inbox`. |

---

## 19. Progress log

Add one line per working session: date, what moved, what is next.

| Date | What moved | Next |
|---|---|---|
| 2026-11-23 | Design finished: 15 of 15 questions answered (C3 a). `README.md`, `plan.md`, `logo.py` and the logo files created. | Run M0, the spike |
| 2026-11-23 | Grilled the plan end to end; verified all 14 assumptions and closed all 3 open questions against official docs. Rewrote containment, approvals, toggle, liveness, vendor order and the API adapter. Added GPL-3.0 `LICENSE`. | Rewrite `README.md`; then run M0 |
