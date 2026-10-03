# Contributing to Outpost

## Local setup

Use Node.js 24+, npm 11+, Git, and Python 3.9+ for the runtime tests. Install an
OpenSSH client when working with SSH targets. The application needs no database.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`; Vite forwards API requests to
`http://127.0.0.1:3000`. The API uses `tsx watch`, including changes to the Python
runtime files. `npm run ts:debug -- backend/server.ts` starts a watcher with the
inspector on loopback port 9229; the VS Code attach configuration reconnects
after restarts.

Use `OUTPOST_DATA_DIR` for a separate development store. Keep API and frontend
listeners on loopback. See [SECURITY.md](SECURITY.md) for private vulnerability
reporting and the supported security boundaries.

## Validation

```sh
npm run check
npx playwright install chromium
npm run test:ui
```

`check` runs lint, type checks, a production build, and unit tests. Browser tests
mock the API. Platform and transport tests have additional prerequisites:

| Command | Prerequisites |
| --- | --- |
| `npm run test:integration` | Docker; optionally `OUTPOST_PWSH=pwsh` for PowerShell coverage |
| `npm run test:local` | Linux/macOS, Python, tmux, dtach; `lsof` on macOS |
| `npm run test:desktop` | Linux, Xvfb, xauth, and XTerm |
| `npm run test:coding` | Native Codex, Claude Code, and Kimi Code binaries, Python, tmux |

The native coding-tool tests use temporary homes and a loopback model fixture.
They need no provider credentials. Set `OUTPOST_REQUIRE_CODING_TOOLS=1` to fail
when a tool is missing. `OUTPOST_CODEX_BINARY`, `OUTPOST_CLAUDE_BINARY`, and
`OUTPOST_KIMI_BINARY` can select specific executables. CI installs the pinned
versions documented in [README.md](README.md) and requires all three tests.

## Changes and pull requests

Keep changes focused and explain the user-visible behavior, relevant validation,
and any limitations in the pull request. Include a regression test when changing
runtime behavior or security boundaries. Use synthetic data in screenshots and
fixtures, and preserve target-side conversation storage.

Report ordinary bugs through GitHub issues with reproduction steps, the commit
or version, operating system, backend, and coding-tool version. Remove private
paths and credentials from logs before sharing them.

## Documentation and media

Run `npm run docs:capture` to refresh the README banner and screenshots using the
local application with mock services. Run `npm run promo:capture` to refresh
promo screenshots. See [promo-v2/README.md](promo-v2/README.md) for the film source.

Generated audio and video stay outside Git. Confirm redistribution rights before
publishing media through release assets or another host. Preserve bundled font
licenses and dependency notices described in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
