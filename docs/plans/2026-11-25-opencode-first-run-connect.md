# First-run OpenCode MCP auto-connect (released app)

## Context

`artinarey connect opencode` already adds the Artinarey MCP server to a project's
`opencode.json`, but a released app user has to discover and run that command by
hand. The release workflow ships Tauri bundles (deb/rpm/AppImage, dmg/app,
msi/nsis) with no installer hook, so "at installation" cannot be implemented
once for every platform. The cross-platform hook available in this repo is the
first launch of the bundled daemon.

## Decision

On launch of a **bundled** Artinarey daemon, if OpenCode is installed on
the machine, merge the Artinarey MCP server and its allow rules into OpenCode's
**global** `opencode.json`. Never overwrite unrelated config; never fail daemon
startup. Retry until the merge succeeds, and re-run it on version upgrade so
the server command points at the current bundle.

## Design

1. `packages/core/src/opencode.ts` owns the shared config shape, tool list,
   idempotent merge, OpenCode detection (PATH binary or config dir), global
   config path resolution, and the atomic read/merge/write helper.
2. `packages/cli/src/index.ts` reuses that helper for the existing project-local
   `connect opencode` command, so both paths stay in sync.
3. `packages/daemon/src/opencode-autoconnect.ts` adds the release-only hook:
   marker under the Artinarey config dir, bundled shim command, global target,
   and a typed status result. The marker stores the app version.
4. `packages/daemon/src/sidecar.ts` calls the hook only when a `manifest.json`
   sits beside the bundled daemon entry (release layout), before starting the
   daemon, and ignores hook errors.
5. `.github/scripts/build-daemon-sidecar.cjs` also bundles the shim as
   `shim.mjs`, and its manifest records the shim entry.
6. `.github/workflows/release.yml` and `ci.yml` need no change; the existing
   sidecar bundling step picks up the new artifact.

## Paths

- Global config: `$XDG_CONFIG_HOME/opencode/opencode.json`, falling back to
  `$HOME/.config/opencode/opencode.json`, then the OS home directory (which
  honours `USERPROFILE` on Windows), on every platform; OpenCode does not read
  `%APPDATA%`. A legacy `~/.opencode.json` is reused if it is the only file
  present. Existing file modes are preserved; new configs use `0600`.
- Project config (existing command): `<cwd>/opencode.json`.
- Marker: `<artinarey configDir>/opencode-autoconnect.json`.

## Tests

- Core merge: preserves unknown keys and other servers/rules, is idempotent,
  replaces only Artinarey-owned rules.
- Detection/config path: temp HOME/XDG/PATH; absent binary and absent config
  dir means no write.
- Autoconnect hook: first run writes, second run does not, version bump rewrites,
  malformed existing config does not crash.
- Sidecar build test asserts `shim.mjs` is emitted and listed in the manifest.

## Out of scope

- Per-platform installer custom actions.
- Adding the MCP server to already-running OpenCode sessions (config is read
  on next launch).
- JSONC comment preservation; only `opencode.json` is written.
