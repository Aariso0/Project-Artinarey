<div align="center">

<img src="assets/artinarey.svg" width="148" alt="Project-Artinarey logo: a green trunk with orange lanes branching off">

# Project-Artinarey

### Give every AI coding agent its own worktree, mailbox and task scope.

*Many agents. Many lanes. One project. You still do the merging.*

![status](https://img.shields.io/badge/status-M0--M8%20implemented-2ea043?labelColor=0d1117)
![local first](https://img.shields.io/badge/local--first-no%20cloud-2ea043?labelColor=0d1117)
![first](https://img.shields.io/badge/works%20with-OpenCode%20first-58a6ff?labelColor=0d1117)
![license](https://img.shields.io/badge/license-GPL--3.0-2ea043?labelColor=0d1117)

</div>

> **The short version:** Artinarey is a local traffic controller for AI coding agents. It gives each agent a real git worktree, a mailbox over MCP, and a written list of paths it may touch. Agents work in parallel; you approve the risky moves and merge the branches. The daemon never calls a model and never leaves your machine — an optional, separate adapter is the only piece that talks to an API.

---

## Contents

- [What is this, actually?](#what-is-this-actually)
- [The problem](#the-problem)
- [Before and after](#before-and-after)
- [How it works](#how-it-works)
- [A day with Artinarey](#a-day-with-artinarey)
- [The personas](#the-personas)
- [What's included](#whats-included)
- [Safety and control](#safety-and-control)
- [Running the app](#running-the-app)
- [Build the app yourself](#build-the-app-yourself)
- [Releases](#releases)
- [Supported tools](#supported-tools)
- [Progress](#progress)
- [FAQ](#faq)
- [License](#license)

---

## What is this, actually?

Artinarey is a small office for AI coding agents, and the metaphor is literal enough to be useful:

- a **desk** is a git worktree and a branch, private to one agent;
- a **mailbox** is an MCP server that delivers addressed Markdown messages between agents;
- a **floor manager** is the senior-dev persona, which splits work into tasks with non-overlapping file scopes;
- a **security desk** is the approval gate for anything that leaves an agent's assigned worktree;
- and **you** are the boss who reads the diffs and does every merge by hand.

Under the hood it is four local pieces, no cloud service required:

| Piece | What it does |
|---|---|
| **Daemon** | Owns projects, personas, mail, leases, sessions and the audit log. Talks to the window over loopback only. |
| **MCP shim** | Advertises mail and task tools to an agent and identifies it by the folder it runs in. |
| **CLI** | Registers projects, starts/stops the daemon, launches agents and handles approvals. |
| **Tauri window** | A desktop UI for projects, worktrees, chat, tasks, approvals, pre-merge, audit and storage. Holds the daemon token; the webview holds none. |

**What it is not:** a model host, an auto-merger, a sandbox, or a hosted service. It does not pick your model for you, it does not merge branches, out-of-worktree detection is heuristic rather than an OS boundary, and records stay on a drive you choose. The optional model adapter is a separate process that can call an OpenAI-compatible endpoint; it is the only outbound caller, and only it reads the API key.

M0–M8 are implemented and tested: two-agent mail exchange verified in OpenCode, the worktree lifecycle smoke-tested, the full desktop window shipped, Move is crash- and offline-safe, and the model adapter runs in an isolated process.

---

## The problem

You wanted parallel agents. What you got was parallel chaos:

- You asked an agent to build a feature, and now you are **watching it type**.
- You opened a second agent on the same repo. Now two agents edit the same file and one of them silently loses.
- You have one tool in one terminal and another in a second, and **neither knows the other exists**.
- You are the mail carrier: copy from agent A, paste into agent B, repeat.
- You come back from lunch with no idea who was doing what.

Artinarey is the office that fixes that. Each agent gets a private desk, an internal mailbox, and a floor manager who stops two of them from editing the same file. You remain the boss and you merge every branch yourself.

---

## Before and after

| | Today | With Artinarey |
|---|---|---|
| **Speed** | One agent at a time | Several agents, each in its own lane |
| **Collisions** | Two agents, one folder, lost work | One git worktree and one branch per agent, plus path leases |
| **Talking** | You copy and paste between tools | Agents mail each other through one local MCP server |
| **Planning** | You juggle it in your head | One senior dev splits the work; code checks that scopes don't overlap |
| **Overview** | A dozen terminal tabs | One calm window with every project, agent, branch and thread |
| **Storage** | Chat logs scattered everywhere | One folder per project, on the drive **you** choose, with a **Move** button |
| **Privacy** | Depends on the tool | Mail stays on your machine; only a separate API adapter calls a model API |

---

## How it works

```text
              you
               │  talk to the senior dev, or to any persona
               ▼
       ┌──────────────┐    launch / watch     ┌──────────────────────────┐
       │  Artinarey   │ ────────────────────▶ │  OpenCode agents         │
       │   daemon     │ ◀──────────────────── │  one per worktree        │
       └──────┬───────┘     MCP: mail, tasks  └──────────────────────────┘
              │
              ├──▶ mail files · task journal · leases · audit log
              │    (one folder per project, on the drive you pick)
              └──▶ API adapter ──▶ model API (configurable base URL)
                   the only outbound caller
```

1. **Add a project.** In the window use **Add project** to open an existing repository or clone one into a new folder. From the CLI use `artinarey project open <path>` or `artinarey project clone <url> <folder>` (`init` still registers the current directory). Worktrees stay under `.worktrees/`. Artinarey reads `git worktree list`, so worktrees made by other tools show up too.
2. **Start a persona.** Pick a worktree. If that persona last worked somewhere else, you get a warning first.
3. **The agent connects over MCP.** The folder it runs in tells Artinarey who it is.
4. **Work gets assigned.** The senior dev splits a task, or you assign it directly. Overlapping scopes are rejected by code, and an idle persona on the same branch gets priority over a new session.
5. **Risky calls ask you.** Anything that reaches outside the agent's worktree blocks until you approve it.
6. **Branches are ready. You merge.** Nothing merges itself.

---

## A day with Artinarey

> **09:00**  You tell the senior dev: *"Add login, rate limiting, and docs."*
> **09:02**  It splits the job into three tasks with three separate sets of paths. The daemon checks that none overlap.
> **09:03**  Developers start in their own worktrees. The senior dev wants one more than your cap allows, so a warning appears and the extra session waits for your approval.
> **09:40**  A tester mails a developer: *"Login returns 500 on empty password."* You didn't copy-paste anything.
> **10:05**  A developer runs `git push`. Its session stops and waits; your desktop notifies you immediately. You approve in the CLI or the window's Approvals tray.
> **10:15**  One developer touches a file outside its lease. The pre-merge panel lights up red.
> **10:30**  Three branches are ready. You read the diffs, merge them in the order you like, and go get lunch.

---

## The personas

A persona is a durable identity with a mailbox, a journal, and a home worktree. Sessions come and go; personas remember.

| Persona | What they do | What they can't do |
|---|---|---|
| **Senior dev** | Splits work, assigns tasks, requests new sessions, chains steps with approval gates. Exactly one per project. | Launch anything itself; the daemon validates every request. It never creates subagents and cannot delete personas. |
| **Developer** | Builds the task inside its own worktree. | Edit outside its lease. |
| **Researcher** | Finds libraries and options, mails a recommendation. | Write code. |
| **Tester** | Runs the app, hunts bugs, mails findings. | Fix code. |

New sessions are completely independent and keep running even when the senior dev is idle. If an idle persona can take the work on the same branch, it gets priority. Direct assignments from you get the same lease checks as senior-dev assignments.

---

## What's included

<table>
<tr>
<td width="50%" valign="top">

### Worktree-native
Every working agent gets its own worktree and branch under `.worktrees/`. Create and adopt worktrees in the CLI or the window; the window shows the current worktrees and which persona lives where.

### Home worktrees
Start a persona somewhere other than where it last worked and you get a warning in the CLI. You can also change a persona's home worktree in the window.

### Path leases
Each task owns its paths. Overlaps are rejected up front. A git hook and a pre-merge check flag edits outside the lease. Shared hot files are handed to one task at a time.

</td>
<td width="50%" valign="top">

### Controlled mail
Addressed messages only. No broadcast. Everything is logged. Mail is immutable plain Markdown you can read with any editor.

### Storage you control
Choose where records live. The **Move** wizard pauses, copies, verifies checksums, switches, and deletes the old copy only when you say so. It is safe across crashes and offline drives, and storage settings live in the window.

### The desktop window
The full window ships Projects, Personas, Worktrees, Mail, Chat, Tasks & leases, Sessions, Approvals, Pre-merge, Audit and Storage/Move. New/adopt worktree, home-worktree edits and blocker dialogs run in the app on a pitch-black UI. The webview holds no daemon token or port: every action goes through `invoke('daemon_call', ...)` in the Tauri shell. See [Running and testing Artinarey](docs/running-and-testing.md) for the daemon and window commands.

</td>
</tr>
</table>

---

## Safety and control

- **Your boundary is the agent's assigned worktree** — not the whole project, and not another worktree of the same project. Network access, other worktrees, and global git operations such as `git push` and `git tag` need your approval. Local commands, including a Python script that only writes inside the worktree, proceed.
- **An obvious auto-approve switch** is user-only, per worktree, and OFF by default. When ON, risky worktree-confined calls proceed automatically; out-of-worktree calls still ask. You can flip it in the CLI or the window's Tasks & leases tab.
- **Blocked agents wait indefinitely.** You get an OS desktop notification immediately, again at 5 minutes, again at 15 minutes, then silence. No timeout auto-fail. A blocked session still counts toward the cap. Approve in the CLI or the window's Approvals tray.
- **Spawn cap:** 3 running sessions per project, soft. Going over it shows a warning phrased around token consumption. Artinarey does not measure tokens or cost; a cost estimate would be misleading for people on free models. A senior-dev request over the cap waits for your approval.
- **Overlap checks are plain code**, not an LLM. An append-only audit log records mail, launches, approvals and every toggle flip.
- **You merge by hand.** A pre-merge check compares changed files with the task's lease and shows red flags.

**Known risk, accepted:** out-of-worktree detection uses command and path heuristics. It can be bypassed — for example, `curl` launched inside the worktree reaches the network, and a Python script can open a file outside the worktree without naming an outside path in the command. This is **not an OS sandbox**. Docs describe out-of-worktree use as *detected and approval-gated*, never impossible. See [`plan.md`](plan.md), section 13.

Operator-only daemon actions (shutdown, approvals, forced release) require a 0600 token held by the CLI. This prevents accidental or raw-socket agent escalation, but an agent running as the same OS user can still read user-owned files; a true user-versus-agent boundary needs an OS credential prompt.

---

## Running the app

<details>
<summary><b>30-second version</b></summary>

<br>

Artinarey is a small office for your AI agents. Each gets a private desk (a worktree), an internal mailbox (MCP), and a floor manager (the senior dev) who stops two people from editing the same file. You stay the boss and do all the merging.

</details>

<details>
<summary><b>Commands</b></summary>

<br>

The model adapter is optional and handles daemon-side prompts such as `run_task` against an OpenAI-compatible endpoint. Set these in the environment before you start the daemon:

```bash
export ARTINAREY_MODEL_BASE_URL="https://your-endpoint.example/v1"
export ARTINAREY_MODEL_MODEL="your-model"
export ARTINAREY_MODEL_KEY="your-key"   # omit when the endpoint needs no key
```

Window Chat is separate from the adapter: `gui.chat` sends a message to a running OpenCode session when one is available, and otherwise queues durable mail for the chosen persona (senior dev by default, also copied to senior dev when addressed elsewhere). These variables do not route Chat to the endpoint. `ARTINAREY_MODEL_KEY` stays in the adapter process and is not exposed to the `opencode serve` process it starts; the webview never receives it, and adapter status reports only whether a key is present.

Install dependencies from the Artinarey repository root:

```bash
pnpm install
```

Register your own project, using the absolute path to the CLI. Either open a repository you already have:

```bash
node /path/to/Project-Artinarey/packages/cli/bin/artinarey project open /path/to/your-project
```

or clone one into a new folder:

```bash
node /path/to/Project-Artinarey/packages/cli/bin/artinarey project clone https://example.com/team/repo.git /path/to/new-folder
```

`init` is still available from inside a repository and does the same registration as `project open .`. The compiled window offers both paths under **Add project**.

Start the daemon in its own terminal (it runs in the foreground and does not return):

```bash
node /path/to/Project-Artinarey/packages/cli/bin/artinarey daemon start
```

In a second terminal, start the webview from `apps/gui`:

```bash
cd /path/to/Project-Artinarey/apps/gui
pnpm exec vite
```

In a third terminal, also from `apps/gui`, start the native shell:

```bash
cd /path/to/Project-Artinarey/apps/gui
pnpm exec tauri dev
```

Check or stop the daemon from another terminal:

```bash
node /path/to/Project-Artinarey/packages/cli/bin/artinarey daemon status
node /path/to/Project-Artinarey/packages/cli/bin/artinarey daemon stop
```

`pnpm exec vite` alone serves only the webview. `invoke('daemon_call', ...)` needs the Tauri shell, so run `pnpm exec tauri dev` in the third terminal too.

</details>

<details>
<summary><b>The window</b></summary>

<br>

M7/M8 shipped the whole window. The native shell holds the daemon token; the webview receives only snapshots.

- **Projects, Personas, Worktrees and Mail:** records, roles, bindings, locks and mail threads.
- **Chat, Tasks & leases, Sessions, Approvals, Pre-merge and Audit:** talk to personas, check scopes, decide on blocked calls and review what changed.
- **Storage/Move:** set the data root and relocate a project's records with the pause/copy/verify/switch wizard.
- **Dialogs:** new and adopt worktree, home-worktree edits and the active-worktree blocker all open inside the app, on a pitch-black UI.

`invoke('daemon_call', ...)` is only available from the Tauri shell; the webview holds no token or port. See [Running and testing Artinarey](docs/running-and-testing.md) for the daemon and window commands.

</details>

---

## Build the app yourself

You need Node 26, pnpm 10.34.9, Rust (stable) and the Tauri 2 system dependencies for your platform. Check your machine first:

```bash
cd apps/gui
pnpm exec tauri info
```

On Linux you also need `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`, `libayatana-appindicator3-dev`, `libxdo-dev`, `gstreamer1.0-plugins-base` and `gstreamer1.0-plugins-good`. A headless machine needs a display, for example Xvfb.

The Linux AppImage bundles the GStreamer plugins that WebKitGTK needs (`bundleMediaFramework` is enabled in `tauri.conf.json`), so it does not depend on the host's plugin version. The `.deb` and `.rpm` packages use the host's GStreamer plugins instead.

**Step 1 — install and build the webview** (from the repository root):

```bash
pnpm install
pnpm run build:gui
```

`pnpm run build:gui` writes the frontend to `apps/gui/dist/`. It does **not** build the native app. To build only the webview without the Rust side, run `pnpm --filter artinarey-gui exec vite build`.

**Step 2 — build native bundles** from `apps/gui`:

| Platform | Command | Bundles |
|---|---|---|
| Linux | `pnpm exec tauri build --bundles deb rpm appimage` | `.deb`, `.rpm`, `.AppImage` |
| macOS | `pnpm exec tauri build --bundles app dmg --no-sign` | zipped `.app`, `.dmg` |
| Windows | `pnpm exec tauri build --bundles msi nsis --no-sign` | `.msi`, NSIS `.exe` |

Add `--ci` for a non-interactive build, which is what the Release workflow uses. For example, the exact Linux CI command is:

```bash
cd apps/gui
pnpm exec tauri build --bundles deb rpm appimage --ci
```

Finished bundles land under `apps/gui/src-tauri/target/release/bundle/`, split into `deb/`, `rpm/`, `appimage/`, `macos/`, `msi/` and `nsis/` directories. The plain executable is `apps/gui/src-tauri/target/release/artinarey-gui`.

For a quick debug binary instead of bundles:

```bash
pnpm run build:gui
cargo build --manifest-path apps/gui/src-tauri/Cargo.toml --features tauri/custom-protocol
./apps/gui/src-tauri/target/debug/artinarey-gui
```

**Run the full gate set before committing** (from the repository root):

```bash
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run test:ci
pnpm build
pnpm run test:gui
pnpm run build:gui
pnpm run audit
pnpm run version:check
git diff --check
```

`pnpm run test:gui` runs the Rust proxy tests; `pnpm run test:ci` adds the version-script tests to the TypeScript suite. See [Running and testing Artinarey](docs/running-and-testing.md) for focused commands and daemon details.

---

## Releases

The version in the root `package.json` is canonical and starts at `0.1.0`. It must agree with `apps/gui/package.json` and `apps/gui/src-tauri/Cargo.toml`. Push a new version to `main`: after all other CI checks pass, the Release workflow creates the `v<version>` tag and one GitHub Release built from that exact commit. Linux gets `deb`, `rpm` and `appimage` bundles; macOS gets an unsigned zipped `.app` and `dmg`; Windows gets unsigned `msi` and `nsis` bundles. A tag that already exists is skipped, so re-pushing the same version does not publish again. There is no npm publish; all packages stay private.

---

## Supported tools

| Tool | Status | What Artinarey can do |
|---|---|---|
| **OpenCode** | First | Launch sessions in a chosen worktree, approve from the CLI or the window, and watch status and chat in the window |
| **Model API adapter** | Implemented | A separate process that calls an OpenAI-compatible model API through a configurable base URL; the daemon passes prompts and results over a local socket, and only the adapter reads the key |
| **Claude Code** | Postponed | Project `.mcp.json` is verified, but a cloned repository can't approve its own servers |
| **Codex** | Postponed | `cwd` and static headers exist, but project config loads only in trusted projects |
| **Antigravity** | Postponed | Headless needs cached credentials and soft-denies approval-requiring tools with exit 0 |

Any tool you start by hand with `artinarey run` still gets mail and tasks, as long as it speaks MCP.

---

## Progress

`█████████` **9 of 9 milestones. M0–M8 implemented and tested; two-agent mail exchange verified in OpenCode, the worktree lifecycle smoke-tested, the full desktop window shipped, Move is crash- and offline-safe, and the model adapter runs in an isolated process.** M4 added leases and the pre-merge check, M5 added the OpenCode adapter, spawning and approvals, M6 added the first desktop window, M7 completed chat, dialogs, window approvals, Move and storage settings, and M8 added the isolated model adapter.

| | Milestone | Status |
|---|---|---|
| M0 | Spike: can the MCP shim see the agent's folder? | ✅ |
| M1 | Store, mail files, daemon | ✅ |
| M2 | MCP shim and identity by folder | ✅ |
| M3 | Worktree manager and home-worktree warnings | ✅ create/list/remove and `run` smoke-tested |
| M4 | Leases and pre-merge check | ✅ |
| M5 | OpenCode adapter, spawning and approvals | ✅ |
| M6 | Desktop window *(first usable slice)* | ✅ |
| M7 | Chat, dialogs, window approval controls, **Move** | ✅ |
| M8 | Model API adapter *(other vendors postponed)* | ✅ |

All 14 assumptions were checked and all 3 open decisions were closed on 2026-11-23. M0 then confirmed the worktree-identity and shared-git-metadata assumptions against real tools; results are in [`plan.md`](plan.md), section 0. Section 17 holds the research evidence — the source of truth for task checklists and estimates.

---

## FAQ

<details>
<summary><b>Is it really local?</b></summary>

<br>

Mail and records never leave your machine, and the daemon makes no outside network calls except to localhost. The separate API adapter is the only component that calls a model API. One honest caveat: anything an agent *reads* is sent to that agent's model provider, just like any text it reads. Keep secrets out of mail.

</details>

<details>
<summary><b>Will it merge my code?</b></summary>

<br>

No. You merge everything by hand. Artinarey shows you which branches are ready and which files each one touched outside its lease.

</details>

<details>
<summary><b>Will parallel agents be faster on a free plan?</b></summary>

<br>

Free-tier models work only inside OpenCode; other harnesses get HTTP 403 even with a key, so they need a paid model or subscription. Beyond that, request limits are shared. Artinarey keeps its own routing free of LLM calls and shows best-effort request counts, but it does not measure tokens or create quota.

</details>

<details>
<summary><b>Can an agent escape its worktree?</b></summary>

<br>

It can ask. Calls that reach outside the assigned worktree are detected and block until you approve. Detection is heuristic and bypassable, so this is not a sandbox. See [`plan.md`](plan.md), section 13.

</details>

<details>
<summary><b>What if two agents need the same file?</b></summary>

<br>

Overlapping task scopes are rejected up front. Shared hot files (lockfiles, `package.json`, migrations) are handed to one task at a time.

</details>

<details>
<summary><b>What if my drive fills up or goes missing?</b></summary>

<br>

Use **Move** to relocate a project's records. If a drive disappears, agents are told to stop and wait, and Artinarey never creates an empty replacement store.

</details>

---

## License

Artinarey is licensed under the **GNU General Public License, version 3 (GPL-3.0)**. The full text is in [`LICENSE`](LICENSE).

`SPDX-License-Identifier: GPL-3.0-only`

This is a strong copyleft license: if you distribute a derivative work, you must make its source available under the same terms. Dependencies are pinned in the workspace manifests, and the direct dependencies with their declared MIT or Apache-2.0 licenses are listed in [`NOTICE`](NOTICE). Security trackers and release cadence have not been audited — check before publishing.

---

<div align="center">

<img src="assets/artinarey.svg" width="56" alt="Project-Artinarey logo">

**Many agents. Many lanes. One project.**

</div>
