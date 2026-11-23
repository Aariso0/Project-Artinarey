# M0 Foundation Spike — Implementation Plan

**Branch:** `MO/foundation`
**Plan date:** 2026-11-23
**Timebox:** 2 hours. This is a cap, not a target — docs research already answered these questions, so 45–60 min is plausible. Hard stop at 3 h: write partial results and reassess.
**Source of truth:** `plan.md` §15 "M0 · Spike" (lines 606–619) and the Spike results table (lines 55–64). This plan adds no new design decisions.
**Author note:** written with the `writing-plans` skill for an engineer who has not seen this repo or the spec.

---

## 0. Purpose and definition of done

Confirm the **working-directory identity assumption** (A1 c) with real tools, before any product code is written. Documentation research already says "yes"; this is a hands-on confirmation pass, not open research.

Nothing built here is product code. The only durable outputs are:

1. All five rows of the **Spike results table** in `plan.md` filled with real recorded values.
2. A decision record with PASS/FAIL per check and an explicit statement on the exit rule.
3. A clean tree after throwaway artifacts are removed (raw evidence is copied into `chat/` first).

**Done when:** every check has a recorded result and the exit-rule decision is written. **Not done when:** code merely "works" — an unrecorded check is a failed check.

---

## 1. Scope

**In scope — the five checks from `plan.md`:**

| # | Check | Confirms |
|---|---|---|
| C1 | Shim `cwd` in main dir | U1 in practice |
| C2 | Shim `cwd` in a worktree | U1 / A1 c — the critical one |
| C3 | `info/exclude` covers marker in a worktree | U8 |
| C4 | Shared hook fires from a worktree commit | U8 |
| C5 | `opencode serve` session in a worktree loads MCP config | U1 + config discovery |

**Out of scope:** daemon, mail store, leases, GUI, pidfd liveness, storage Move, pre-merge checks, subagents, Claude Code / Codex / Antigravity, model API adapter. These were settled in `plan.md` §17 and must not be reopened here.

**One explicit addition by user request:** Task 11 adds Dependabot and CI automatic checks. This is retained repository infrastructure, not a throwaway spike artifact, and is the only item that survives the Task 10 cleanup.

---

## 2. Environment facts (verified 2026-11-23 — inputs, not assumptions)

| Item | Value | How verified |
|---|---|---|
| Canonical checkout | `/mnt/shareddata/projects/Project-Artinarey` | `git rev-parse --show-toplevel` |
| Node | v26.13.1 | `node --version` |
| npm / npx | 12.2.3 | `npm --version` |
| git | 2.56.1 | `git --version` |
| OpenCode | installed at `/usr/bin/opencode` | `command -v opencode` |
| MCP server package | `@modelcontextprotocol/server` 2.4.0 | `npm view` |
| MCP client package | `@modelcontextprotocol/client` 2.4.0 | `npm view` |
| tsx | 4.23.15 | `npm view` |
| zod | 4.6.7 — import as `zod/v4` | `npm view` |

**MCP SDK v2 API (confirmed in official docs):**

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'artinarey-m0', version: '0.0.0' });
server.registerTool(
  'whoami',
  { description: '...', inputSchema: z.object({}) },
  async () => ({ content: [{ type: 'text', text: '...' }] }),
);
await server.connect(new StdioServerTransport());
```

The deprecated variadic `server.tool(...)` is **removed** in v2. Use `registerTool` with a config object.

**OpenCode config v2 (confirmed at `opencode.ai/docs/mcp-servers`):** the key is `mcp.servers.<name>`, not names directly under `mcp`:

```jsonc
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "servers": { "name": { "type": "local", "command": ["..."] } } } }
```

A local MCP entry also accepts optional `cwd` and `environment`. **We deliberately set neither** — setting `cwd` would manufacture the answer we are trying to measure. If the fallback in §7 is needed, these are the exact fields the daemon would populate.

**OpenCode HTTP API (read from the installed instance's `openapi.json`):**

- `POST /api/session` body accepts `{"location": {"directory": "<absolute path>"}}` — a session scoped to that directory.
- `GET /api/location?location={"directory":"..."}` returns `{directory, project: {id, directory, canonical}}`. `project.canonical` is direct evidence of which checkout supplied the config.
- `jq` is installed, so API responses can be parsed in shell without Python.

**CLI flags (read from `opencode --help` on this machine):**

- `opencode run --standalone --auto "<prompt>"` — private server rooted at cwd; `--auto` approves the MCP tool call non-interactively.
- `opencode run --server <url> --session <id> --auto "<prompt>"`.
- `opencode mcp list`, `opencode serve --hostname <h> --port <p>`.

---

## 3. Layout and conventions

```
spike/m0/                              throwaway; removed in Task 10
  shim/
    package.json
    tsconfig.json
    src/report.ts                      pure function — unit-testable, no side effects
    src/index.ts                       MCP server wiring; imports report.ts
    src/report.test.ts                 contract test, written BEFORE report.ts
    test/stdio-client.ts               deterministic baseline check
  hooks/pre-commit                     probe hook; uses an ABSOLUTE log path
  evidence/                            raw outputs (hook.log, serve.log, *.json, *.txt)
  evidence.md                          pasted command/output pairs, verbatim
  README.md                            exact re-run commands
opencode.json                          committed at repo root so the worktree inherits it
docs/superpowers/plans/2026-11-23-m0-foundation-spike.md   this plan
```

Conventions:

- **One commit per task**, message `spike(m0): <short task name>`.
- Paste raw output into `spike/m0/evidence.md` immediately. Never paraphrase a result into the table without keeping the raw line.
- **Absolute paths** in `opencode.json` and `core.hooksPath`. A relative path moves with cwd and destroys the measurement.
- Do not set the MCP `cwd` or `environment` fields.
- Use a **sibling** worktree path, not a directory inside the main checkout: `/mnt/shareddata/projects/Project-Artinarey-m0-wt`. Linked worktrees contain the checked-out `opencode.json`, so config discovery still works from there.

---

## 4. Tasks

### Task 1 — Scaffold the spike and write the failing contract test

**Purpose:** establish the test-first baseline and install exact dependency versions.

```bash
cd /mnt/shareddata/projects/Project-Artinarey
mkdir -p spike/m0/shim/src spike/m0/shim/test spike/m0/hooks spike/m0/evidence
cd spike/m0/shim
npm init -y
npm pkg set type=module
npm pkg set scripts.test="node --import tsx --test src/*.test.ts"
npm pkg set scripts.start="tsx src/index.ts"
npm i @modelcontextprotocol/server@2.4.0 zod@4.6.7
npm i -D @modelcontextprotocol/client@2.4.0 tsx@4.23.15 typescript @types/node
```

Write `spike/m0/shim/src/report.test.ts` **before** any implementation:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from './report.ts';

test('whoami report carries cwd, argv and env names', () => {
  const report = buildReport();
  assert.match(report.cwd, /^\//, 'cwd must be an absolute path');
  assert.ok(report.argv.length >= 2, 'argv must be present');
  assert.ok(report.envNames.includes('PATH'), 'env var names must be collected');
});
```

`tsconfig.json` — minimal ESM/Bundler config:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "noEmit": true,
    "strict": true
  },
  "include": ["src", "test"]
}
```

**Test:** `npm test` must **fail** with "Cannot find module './report.ts'". Paste that failure into `spike/m0/evidence.md` — it proves the test is real.

**Commit:** `spike(m0): scaffold shim and add failing contract test`

---

### Task 2 — Implement the shim (make the test pass)

**Purpose:** a stdio MCP server with exactly one no-argument tool. Splitting the pure function from the server wiring avoids starting a stdio server during unit tests.

`spike/m0/shim/src/report.ts`:

```typescript
export function buildReport() {
  return {
    cwd: process.cwd(),
    argv: process.argv,
    envNames: Object.keys(process.env).sort(),
  };
}
```

`spike/m0/shim/src/index.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { buildReport } from './report.ts';

const server = new McpServer({ name: 'artinarey-m0', version: '0.0.0' });

server.registerTool(
  'whoami',
  {
    description: 'Report the shim process cwd, argv and environment variable names',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: 'text', text: JSON.stringify(buildReport(), null, 2) }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Test:** `npm test` passes (1 test). Then run `npm start` with stdin closed — it must exit without an uncaught error (a stdio server with no client is fine).

**Commit:** `spike(m0): implement whoami MCP tool`

---

### Task 3 — Direct stdio client smoke test (deterministic baseline)

**Purpose:** prove the shim reports whatever cwd it is spawned with, *before* OpenCode is involved. If this fails, later failures are the shim's fault, not OpenCode's.

`spike/m0/shim/test/stdio-client.ts`:

```typescript
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cwd = process.argv[2];
if (!cwd) throw new Error('usage: stdio-client <absolute-cwd>');

const client = new Client({ name: 'm0-smoke', version: '0.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    '/mnt/shareddata/projects/Project-Artinarey/spike/m0/shim/node_modules/.bin/tsx',
    '/mnt/shareddata/projects/Project-Artinarey/spike/m0/shim/src/index.ts',
  ],
  cwd,
});

await client.connect(transport);
console.log('tools:', (await client.listTools()).tools.map(t => t.name));
const result = await client.callTool({ name: 'whoami', arguments: {} });
console.log(JSON.stringify(result.content, null, 2));
await client.close();
```

**Test (run from the main checkout):**

```bash
cd /mnt/shareddata/projects/Project-Artinarey/spike/m0/shim
node --import tsx test/stdio-client.ts /mnt/shareddata/projects/Project-Artinarey \
  | tee ../evidence/stdio-main.txt
node --import tsx test/stdio-client.ts /tmp \
  | tee ../evidence/stdio-tmp.txt
```

Expected: `tools: [ 'whoami' ]` and each JSON payload's `cwd` equals the cwd passed on the command line. Paste both outputs into `evidence.md`.

**Commit:** `spike(m0): add stdio client baseline check`

---

### Task 4 — Register the shim in OpenCode project config

**Purpose:** make both the main checkout and the worktree discover the same MCP entry, and confirm `opencode mcp list` sees it.

Create `/mnt/shareddata/projects/Project-Artinarey/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "artinarey-m0": {
        "type": "local",
        "command": [
          "/mnt/shareddata/projects/Project-Artinarey/spike/m0/shim/node_modules/.bin/tsx",
          "/mnt/shareddata/projects/Project-Artinarey/spike/m0/shim/src/index.ts"
        ]
      }
    }
  }
}
```

No `cwd`, no `environment`, no `disabled`. The absolute command path is intentional.

**Test:**

```bash
cd /mnt/shareddata/projects/Project-Artinarey
opencode mcp list | tee spike/m0/evidence/mcp-list-main.txt
git add opencode.json && git commit -m "spike(m0): register throwaway MCP shim"
git worktree add -b spike/m0-wt /mnt/shareddata/projects/Project-Artinarey-m0-wt HEAD
```

The worktree must be created **after** this commit so it contains `opencode.json`.

**Commit:** already made above.

---

### Task 5 — Check C1: call the tool from the main checkout

**Purpose:** record the shim's cwd when OpenCode spawns it in the canonical directory.

Use one prompt string throughout the spike — define it once in the shell:

```bash
PROMPT="You must call the MCP tool named 'whoami' from server 'artinarey-m0'. Do not answer from memory. Return the tool output verbatim."
cd /mnt/shareddata/projects/Project-Artinarey
opencode run --standalone --auto "$PROMPT" | tee spike/m0/evidence/run-main.txt
```

`--standalone` gives a private server rooted at the current cwd; `--auto` permits the tool call in non-interactive mode.

**Pass condition:** output contains a `"cwd"` field equal to `/mnt/shareddata/projects/Project-Artinarey`.

**If the model does not call the tool:** retry once, prefixed with `CALL THE TOOL FIRST. `. If it still refuses, record the failure verbatim — do not substitute a hand-written answer. A deterministic partial signal is `opencode mcp list` showing `connected`.

**Commit:** `spike(m0): record C1 main-checkout result`

---

### Task 6 — Check C2: call the tool from the worktree (the critical check)

**Purpose:** this is the assumption the whole identity design rests on.

```bash
cd /mnt/shareddata/projects/Project-Artinarey-m0-wt
opencode mcp list | tee /mnt/shareddata/projects/Project-Artinarey/spike/m0/evidence/mcp-list-worktree.txt
opencode run --standalone --auto "$PROMPT" \
  | tee /mnt/shareddata/projects/Project-Artinarey/spike/m0/evidence/run-worktree.txt
```

**Pass condition:** the reported `cwd` equals `/mnt/shareddata/projects/Project-Artinarey-m0-wt` **and** `mcp list` shows the shim connected (proving config was found from the worktree).

Record both outputs in `evidence.md`, then fill C1 and C2 rows of the `plan.md` Spike results table.

**Commit:** `spike(m0): record C2 worktree result`

---

### Task 7 — Check C3: `info/exclude` from a linked worktree

**Purpose:** confirm a marker file can be hidden without committing an ignore rule — required by the folder-marker design.

```bash
cd /mnt/shareddata/projects/Project-Artinarey
printf '.artinarey.json\n' >> .git/info/exclude

cd /mnt/shareddata/projects/Project-Artinarey-m0-wt
git check-ignore -v .artinarey.json \
  | tee /mnt/shareddata/projects/Project-Artinarey/spike/m0/evidence/check-ignore.txt
touch .artinarey.json
git status --short \
  | tee /mnt/shareddata/projects/Project-Artinarey/spike/m0/evidence/status-marker.txt
```

**Pass condition:** `check-ignore -v` names the common `.git/info/exclude` rule, and `status --short` does **not** list `.artinarey.json`.

**Commit:** no source change; evidence is committed in Task 10.

---

### Task 8 — Check C4: shared hook fires from a worktree commit

**Purpose:** confirm `core.hooksPath` set in the common config applies to linked worktrees, so the lease guard can be a shared hook.

Set the hook in the **main checkout** (common config) with an **absolute** path — a relative `core.hooksPath` resolves against each worktree's cwd and would not be shared:

```bash
cd /mnt/shareddata/projects/Project-Artinarey
git config core.hooksPath /mnt/shareddata/projects/Project-Artinarey/spike/m0/hooks
cat > spike/m0/hooks/pre-commit <<'EOF'
#!/bin/sh
echo "m0 hook fired in $(pwd) at $(date -Iseconds)" >> /mnt/shareddata/projects/Project-Artinarey/spike/m0/evidence/hook.log
EOF
chmod +x spike/m0/hooks/pre-commit
git add spike/m0/hooks/pre-commit
git commit -m "spike(m0): add shared pre-commit probe"
```

Trigger it from the **worktree**:

```bash
cd /mnt/shareddata/projects/Project-Artinarey-m0-wt
echo probe >> probe.txt
git add probe.txt
git commit -m "spike(m0): trigger hook from worktree"
cat /mnt/shareddata/projects/Project-Artinarey/spike/m0/evidence/hook.log \
  | tee /mnt/shareddata/projects/Project-Artinarey/spike/m0/evidence/hook-result.txt
```

**Pass condition:** the log line contains `/mnt/shareddata/projects/Project-Artinarey-m0-wt` as `pwd` — i.e. the hook ran on a worktree commit.

**Commit:** both commits above.

---

### Task 9 — Check C5: `opencode serve` session scoped to a worktree

**Purpose:** prove the daemon's intended path works — one long-lived server, sessions addressed by directory — and that config is resolved from the canonical checkout.

```bash
cd /mnt/shareddata/projects/Project-Artinarey
opencode serve --hostname 127.0.0.1 --port 49375 \
  > spike/m0/evidence/serve.log 2>&1 &
echo $! > spike/m0/evidence/serve.pid
```

Confirm location resolution:

```bash
curl -sG 'http://127.0.0.1:49375/api/location' \
  --data-urlencode 'location={"directory":"/mnt/shareddata/projects/Project-Artinarey-m0-wt"}' \
  | tee spike/m0/evidence/location.json
```

**Pass condition for config origin:** `directory` is the worktree and `project.canonical` is `/mnt/shareddata/projects/Project-Artinarey`.

Create the session and drive it:

```bash
SID=$(curl -s -X POST 'http://127.0.0.1:49375/api/session' \
  -H 'content-type: application/json' \
  -d '{"title":"m0-worktree","location":{"directory":"/mnt/shareddata/projects/Project-Artinarey-m0-wt"}}' \
  | tee spike/m0/evidence/session.json | jq -r '.data.id')
echo "$SID"

opencode run --server http://127.0.0.1:49375 --session "$SID" --auto "$PROMPT" \
  | tee spike/m0/evidence/serve-run.txt

kill "$(cat spike/m0/evidence/serve.pid)"
```

**Pass condition:** the reported `cwd` is the worktree path.

**Fallback:** if the API returns 401/403, record the exact status, then use `opencode run --standalone` from the worktree (already done in Task 6) as the cwd evidence and note "API auth is out of M0 scope". Do not spend more than 20 min on auth.

**Commit:** `spike(m0): record C5 serve/session result`

---

### Task 10 — Record results, decide, clean up

**Purpose:** turn observations into durable evidence and leave a clean tree.

1. Fill `plan.md` lines 57–64 with the five real values and short notes (include the fact that MCP `cwd`/`environment` were deliberately unset).
2. Record the decision in local, untracked notes: C1..C5 PASS/FAIL with the exact observed cwd values; exit rule triggered or not triggered; if triggered, the daemon supplies identity via MCP environment or cwd field and identity stays tied to the directory record.
3. Copy raw evidence (all of `spike/m0/evidence/` plus `evidence.md`) into local, untracked notes. **Do this before deleting anything.**
4. Remove throwaway artifacts:

```bash
cd /mnt/shareddata/projects/Project-Artinarey
git config --unset core.hooksPath
# remove the .artinarey.json line from .git/info/exclude
rm -rf spike/m0 opencode.json
git worktree remove --force /mnt/shareddata/projects/Project-Artinarey-m0-wt
git branch -D spike/m0-wt
git add -A && git commit -m "spike(m0): record results and clean up"
```

5. Leave this plan document on the branch as the deliverable. Report to the user: each check's result, whether the exit rule fired, and the recommended next action.

**Commit:** as above.

---

### Task 11 — Dependabot and CI/CD automatic checks (permanent, retained)

**Purpose:** added by user request. Unlike Tasks 1–10, these files are repository infrastructure, not throwaway spikes: **do not delete them in Task 10**. Keep this task last so cleanup in Task 10 does not touch `.github/`.

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
```

The npm entry is inert until a root `package.json` exists; that is intentional — M1 will add one.

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main, "MO/**"]
  pull_request:
    branches: [main, "MO/**"]

jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Required docs and GPL license
        run: |
          test -f README.md
          test -f plan.md
          test -f LICENSE
          grep -q 'GPL-3.0' README.md
          grep -q 'GNU GENERAL PUBLIC LICENSE' LICENSE
      - name: Root doc relative links resolve
        run: |
          python3 - <<'PY'
          import pathlib, re, sys
          bad = []
          for name in ('README.md', 'plan.md'):
              md = pathlib.Path(name)
              for target in re.findall(r'\]\(([^)#]+)(?:#[^)]*)?\)', md.read_text(errors='ignore')):
                  if '://' in target or target.startswith('mailto:'):
                      continue
                  if not (md.parent / target).resolve().exists():
                      bad.append(f'{name}: {target}')
          if bad:
              print('\n'.join(bad))
              sys.exit(1)
          PY

  node:
    if: ${{ hashFiles('package.json') != '' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
```

**Test locally** (no GitHub runner needed):

```bash
cd /mnt/shareddata/projects/Project-Artinarey
python3 -c "import yaml,sys; [yaml.safe_load(open(f)) for f in ['.github/dependabot.yml','.github/workflows/ci.yml']]"
```

If PyYAML is missing, install it in `/tmp/opencode` or validate with `ruby -e "require 'yaml'; ..."` — do not add it as a project dependency.

**Commit:** `spike(m0): add dependabot and CI checks`

---

## 5. Verification matrix

| `plan.md` row | Produced by | Evidence file | Pass condition |
|---|---|---|---|
| Shim `cwd` in main dir | Task 5 | `evidence/run-main.txt` | `cwd` = canonical checkout |
| Shim `cwd` in a worktree | Task 6 | `evidence/run-worktree.txt` | `cwd` = worktree path |
| `info/exclude` covers marker | Task 7 | `evidence/check-ignore.txt`, `status-marker.txt` | rule reported; marker untracked-invisible |
| Shared hook fires | Task 8 | `evidence/hook.log`, `hook-result.txt` | log `pwd` = worktree |
| `serve` session loads MCP config | Task 9 | `evidence/location.json`, `session.json`, `serve-run.txt` | `project.canonical` = main; `cwd` = worktree |

Also verify before finishing:

```bash
jq -r '.directory, .project.canonical' spike/m0/evidence/location.json
grep -n 'cwd' spike/m0/evidence/run-main.txt spike/m0/evidence/run-worktree.txt
git worktree list
git status --short --branch
```

---

## 6. Stop rules

- **2 h timebox; 3 h hard stop.** At the hard stop, write partial results and reassess rather than pushing through.
- **Do not start M1.** No daemon, no product code, no dependency manifests outside `spike/m0/`.
- **Do not fix the product to make a check pass.** Record the observation; the exit rule is the allowed response to a failed C1/C2.
- **Do not treat model refusal as a design failure.** If the model won't call the tool, record that and rely on `mcp list` + the direct stdio baseline, clearly labeled as partial.
- Subagents, Codex, Claude Code and Antigravity are settled in `plan.md` §17 — do not revisit.

---

## 7. Exit rule (verbatim from `plan.md` §15)

> If the shim's `cwd` is not the worktree, fall back to a static header or environment value supplied per session by the daemon (identity still tied to the directory record). Subagents and Codex are out of scope; both were settled in section 17.

The fallback is concrete, not hypothetical: OpenCode's local MCP entry supports `environment` and `cwd` (§2). If C2 fails, Task 10 records that the daemon must inject identity via one of those fields on server startup, and `plan.md` §6/§8 must be amended in the next planning pass. **Do not make that amendment during the spike** — report it and wait for direction.

---

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Model refuses to call the MCP tool | Direct stdio baseline (Task 3) + `mcp list` give independent evidence; failure is recorded, not papered over. |
| Absolute paths are machine-specific | Expected — this is a throwaway spike; all paths are deleted in Task 10. |
| `core.hooksPath` leaks into later work | Explicitly unset in Task 10; verify with `git config --get core.hooksPath`. |
| `opencode serve` requires auth | 20-min cap, then fallback to `--standalone`; auth question is out of scope. |
| Nested worktree pollutes `git status` | Worktree lives in a sibling directory, not under the main checkout. |
| Evidence lost during cleanup | Copy raw evidence into local, untracked notes before deleting `spike/m0/`. |
