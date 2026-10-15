# Contributing to Outpost

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: it explains the
principles every change should keep (one connection path, target-owned persistent terminal
state, modes that differ only in identity, one installed target executable).

Outpost is unreleased. Keep one current implementation and schema: remove
obsolete paths when replacing a feature instead of adding migration readers,
aliases or compatibility modes. Version checks reject stale inputs; update the
shared contracts and callers together. Supported OS/browser/terminal-engine handling is
part of the current platform contract.

## Local setup

Use Node.js 24+, npm 11+, Python 3.9+, an OpenSSH client and
[ruff](https://docs.astral.sh/ruff/) (`pipx install ruff` or `uv tool install ruff`).

```sh
npm ci
npm run build:terminal
npm run dev
```

Open http://127.0.0.1:5173. Vite forwards `/api` to the API on
`127.0.0.1:3000`, which restarts on changes to `backend/` and `runtime/`. Use `OUTPOST_DATA_DIR` for a separate development store, and a
different one for hosted work (`OUTPOST_MODE=hosted` in `.env`). Without mail
credentials, hosted development shows verification links in the UI.

## Layout

| Directory | Language | Runs on |
| --- | --- | --- |
| `backend/` | TypeScript | Outpost server |
| `frontend/` | React + SCSS | Browser and Electron renderer |
| `shared/` | TypeScript | Server, frontend and desktop contracts |
| `terminal-service/` | TypeScript + bundled Bun | Linux targets, installed executable |
| `runtime/` | Python 3.9 | Targets, sent with each operation |
| `desktop/` | TypeScript + Electron | Your computer (macOS, Windows) |

Python code must stay compatible with Python 3.9 on targets and
use only the standard library.

Formatting is automatic: `npm run format` runs Prettier on TypeScript, SCSS and
JSON and ruff on Python; `npm run lint` and `npm run lint:python` check it.
Contracts shared by TypeScript and Python are tested in
`tests/unit/contracts.test.ts`; extend it when you add one.

## Checks

```sh
npm run check             # lint (incl. ruff), typecheck, build, Node unit tests, Python tests
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

```sh
npm ci
npm --prefix desktop ci
npm --prefix desktop run typecheck
npm --prefix desktop run dev
# On macOS:
npm --prefix desktop run package -- --mac --arm64 --x64
# On Windows:
npm --prefix desktop run package -- --win --x64
```

Run the server separately. Open it from app home, then select a session in the
browser and use Connect → Outpost Desktop. macOS protocol handlers require a
packaged app installed in Applications. Development Windows runs register the
current Electron executable; reinstall the packaged app to restore its handler.

The shell bundles native integration and local workspace chrome. Each session
loads the shared terminal in an isolated `WebContentsView` from its trusted server.
`layout.ts` owns tab order and split geometry; `workspace.ts` owns window layout,
menus' actions and the local chrome bridge; `terminals.ts` owns terminal views
and validates their native IPC. Keep UI metadata separate from grants and
terminal contents. Never recreate a view to switch tabs or change a split.
Desktop dependencies and its lockfile
are isolated from the server package. `scripts/build-desktop.mjs` builds the
preloads and shell and wraps approved logo PNGs into ICNS/ICO containers.
`npm run logo:generate` derives these PNGs from the canonical SVG.

**Desktop previews** in GitHub Actions is manual. It builds both Mac architectures
and Windows x64; artifacts expire after 14 days. Select **publish** to create an
unsigned GitHub prerelease with checksums after both jobs succeed. Bump
`desktop/package.json` and its lockfile before publishing a new version, and
update `desktop/RELEASE_NOTES.md`. Existing releases are never overwritten.
No signing credentials or automatic updater are used for previews.

The existing **CI** workflow can also call this same packaging workflow with
`suite=desktop` and `publish_preview=true`; its full checks are skipped in that
mode. This entry works while `desktop.yml` exists only on the `v2` branch and
GitHub has not registered it on the default branch yet.

On each native platform, exercise cold/warm `outpost://` launches, tab switching
and reordering, title-bar dragging with a full tab strip, native window controls,
fullscreen entry/exit and display scaling, both split directions and divider
dragging, focus between panes,
hidden-tab output and bells, draft-close cancellation, multi-tab quit, trust
cancellation/removal, clipboard text and images, notification click-through,
reconnect/reload, GPU fallback and app identity before a stable release. Check
shortcuts with the message box focused as well as the terminal. Do not infer
OS behavior from a successful packaging job. The app and server must ship the
same `desktopBridgeVersion`; there are no bridge compatibility shims.

## Linux terminal dependency

Run `npm run build:terminal` before runtime/integration/browser tests. Use
`npm run build:terminal -- arm64-glibc` (or `x64-musl`, `arm64-musl`) for other
targets. The build pins Bun; the resulting executable embeds its runtime.

The **Linux terminal service** workflow is manual and builds all four assets.
Enable **publish** to create `terminal-v<version>` with checksums. Bump the
shared service version and its Python contract together; never overwrite an
existing release. The existing **CI** dispatcher also exposes `suite=terminal`
and `publish_preview=true`, so it works before GitHub registers the new workflow
on the default branch. This release is separate from desktop installers.

`shared/terminalCheckpoint.ts` is the sole adapter to xterm internals. Keep the
headless and browser buffer layouts aligned, and bump its schema/protocol when
they change. Checkpoint restoration transfers cells and modes without replaying
escape sequences. Any upgrade must preserve scrollback, wrapping, wide/combined
characters, alternate buffers, saved cursors, links, margins, palettes and input
modes, and keep live output ordered after the snapshot.

## Pull requests

Keep changes focused and describe the user-visible behavior, how you validated
it, and any limitations. Add a regression test when changing runtime behavior,
the terminal or relay protocol, or a security boundary. Use synthetic data in
screenshots (`npm run docs:capture`) and fixtures.

Report bugs through GitHub issues with reproduction steps, the commit, your
operating system and terminal app, and the coding tool version. Remove private
paths and credentials from logs first.
