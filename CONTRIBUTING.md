# Contributing to Outpost

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: it explains the
principles every change should keep (one connection path, machine-owned persistent sessions,
Outpost as the hub, modes that differ only in identity, one installed machine executable).

Outpost is unreleased. Keep one current implementation and schema: remove
obsolete paths when replacing a feature instead of adding migration readers,
aliases or compatibility modes. Version checks reject stale inputs; update the
shared contracts and callers together. Supported OS/browser/terminal-engine handling is
part of the current platform contract.

## Local setup

Use Node.js 24+, npm 11+, an OpenSSH client, and Python 3 with
[ruff](https://docs.astral.sh/ruff/) (`pipx install ruff` or `uv tool install ruff`)
for the test fixtures that stand in for coding tools.

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run build:terminal
npm run dev
```

Open http://127.0.0.1:5173. Vite forwards `/api` to the API on
`127.0.0.1:3000`, which restarts on changes to `backend/`. Changes to `machine/`
take effect after `npm run build:terminal` and installing the build on a target. Use `OUTPOST_DATA_DIR` for a separate development store, and a
different one for hosted work (`OUTPOST_MODE=hosted` in `.env`). Without mail
credentials, hosted development shows verification links in the UI.

## Layout

| Directory | Language | Runs on |
| --- | --- | --- |
| `backend/` | TypeScript | Outpost server |
| `frontend/` | React + SCSS | Browser |
| `shared/` | TypeScript | Server, frontend and desktop contracts |
| `machine/` | TypeScript + bundled Bun | Linux targets, installed executable (Outpost Terminal) |
| `desktop/` | Rust + GPUI, TypeScript session helper | Your computer (macOS, Windows) |

Code in `machine/` runs in Bun on targets and in Node in its tests: use Node's
APIs (Bun implements them), except in the terminal service's PTY handling.

Formatting is automatic: `npm run format` runs Prettier on TypeScript, SCSS and
JSON and ruff on the Python test fixtures; `npm run lint` and
`npm run lint:python` check it. Contracts between the server and the machine
are tested in `tests/unit/contracts.test.ts`; extend it when you add one.

## Checks

```sh
npm run check             # lint (incl. ruff), typecheck, build, unit and machine tests
npm run build:terminal -- --fixtures  # isolated machine binary for integration and browser tests
npm run test:integration  # persistent PTYs; the SSH test also needs Docker
npx playwright install chromium
npm run test:ui           # browser tests against a real local backend
```

Integration and browser tests use disposable homes with fixture coding tools
(`tests/fixtures/coding-tool-fixture.py`); they never use your real home,
SSH known hosts or provider credentials. Existing browser assertions inspect
xterm DOM text, so Playwright disables WebGL to exercise the fallback renderer.
Native GPU behavior and OS integration require checks on the supported systems.

## Desktop development and previews

Use Node 24, a stable Rust toolchain and the native build tools for your platform.
Run these commands from the repository root.

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

`npm run test:desktop` exercises V3 session restore and reconnect against a
loopback fixture and runs the Rust tests. `npm --prefix desktop run test:ui`
opens a headless GPUI workspace, runs a real local shell and moves a live pane
to a second window. Set `OUTPOST_DESKTOP_DATA_DIR` to use a separate profile.
Set `OUTPOST_TEST_SCREENSHOTS` to an existing directory to save UI test frames.

`npm --prefix desktop run package` builds an installer for the host platform
and architecture in `desktop/release`. Use an official Node distribution so its
runtime and license can be packaged together. macOS uses the system packaging
tools. Windows uses NSIS (`MAKENSIS` may point to its executable).
The desktop workflow builds Apple silicon, Intel Mac and Windows x64 on
separate runners. Bump the desktop package and Cargo versions together before
publishing a new release.

## Outpost Terminal

For a self-hosted release, `OUTPOST_TERMINAL_RELEASE_BASE` can point to an HTTPS directory containing the four version-matched Linux executables and their `SHA256SUMS`. The installer checks the downloaded binary’s checksum and protocol version. For a bundled Apple silicon installer, set `VITE_OUTPOST_MAC_ARM64_INSTALLER` at web build time to its public download path.

Build the machine binary with `npm run build:terminal`. Integration and browser tests use
`npm run build:terminal -- --fixtures` so each simulated machine has its own installation directory. Use
`npm run build:terminal -- arm64-glibc` (or `x64-musl`, `arm64-musl`) for other
targets. The build pins Bun; the resulting executable embeds its runtime.

The **Outpost Terminal** workflow is manual and builds all four assets. Enable
**publish** to create `terminal-v<version>` with checksums. Bump the version in
`shared/terminalService.ts` for every release; never overwrite an existing
release. The **CI** dispatcher also runs it (`suite=terminal`,
`publish_preview=true`) from branches where GitHub has not registered it. This
release is separate from desktop installers.

`shared/terminalState.ts` defines checkpoint wire types, while
`shared/terminalCheckpoint.ts` is the sole adapter to xterm internals. Keep the
headless and browser buffer layouts aligned, and bump its schema/protocol when
they change. Checkpoint restoration transfers cells and modes without replaying
escape sequences. Any upgrade must preserve scrollback, wrapping, wide/combined
characters, alternate buffers, saved cursors, links, margins, palettes and input
modes, and keep live output ordered after the snapshot.

## Pull requests

Keep changes focused and describe the user-visible behavior, how you validated
it, and any limitations. Add a regression test when changing machine behavior,
the terminal or node protocol, or a security boundary. Use synthetic data in
screenshots (`npm run docs:capture`) and fixtures.

Report bugs through GitHub issues with reproduction steps, the commit, your
operating system and terminal app, and the coding tool version. Remove private
paths and credentials from logs first.
