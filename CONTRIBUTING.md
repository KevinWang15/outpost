# Contributing to Outpost

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first: it explains the
principles every change should keep (one connection path, tmux as the only
terminal state, modes that differ only in identity, agentless targets).

## Local setup

Use Node.js 24+, npm 11+, Python 3.9+, tmux 3.2+, an OpenSSH client and
[ruff](https://docs.astral.sh/ruff/) (`pipx install ruff` or `uv tool install ruff`).

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173. Vite forwards `/api` and `/connector` to the API on
`127.0.0.1:3000`, which restarts on changes to `backend/`, `runtime/` and
`connector/`. Use `OUTPOST_DATA_DIR` for a separate development store, and a
different one for hosted work (`OUTPOST_MODE=hosted` in `.env`). Without mail
credentials, hosted development shows verification links in the UI.

## Layout

| Directory | Language | Runs on |
| --- | --- | --- |
| `backend/` | TypeScript | Outpost server |
| `frontend/` | React + SCSS | Browser |
| `shared/` | TypeScript | Both; includes the harness and connector-launcher registries |
| `runtime/` | Python 3.9 | Targets, sent with each operation |
| `connector/` | Python 3.9 | Your computer (macOS, WSL) |

Python code must stay compatible with Python 3.9 (macOS Command Line Tools) and
use only the standard library.

Formatting is automatic: `npm run format` runs Prettier on TypeScript, SCSS and
JSON and ruff on Python; `npm run lint` and `npm run lint:python` check it.
Contracts shared by TypeScript and Python are tested in
`tests/unit/contracts.test.ts`; extend it when you add one.

## Checks

```sh
npm run check             # lint (incl. ruff), typecheck, build, Node unit tests, Python tests
npm run test:integration  # real tmux; the SSH test also needs Docker
npx playwright install chromium
npm run test:ui           # browser tests against a real local backend
```

Integration and browser tests use disposable homes with fixture coding tools
(`tests/fixtures/coding-tool-fixture.py`); they never use your real home,
SSH known hosts or provider credentials. The connector runs with
`OUTPOST_CONNECTOR_FAKE=<dir>`, which replaces the OS clipboard and browser
with files. Native terminal integrations (iTerm2 profiles, the Windows
registry) are checked as generated artifacts; please test those changes by hand
on a Mac or on Windows and describe what you tried.

## Pull requests

Keep changes focused and describe the user-visible behavior, how you validated
it, and any limitations. Add a regression test when changing runtime behavior,
the terminal or relay protocol, or a security boundary. Use synthetic data in
screenshots (`npm run docs:capture`) and fixtures.

Report bugs through GitHub issues with reproduction steps, the commit, your
operating system and terminal app, and the coding tool version. Remove private
paths and credentials from logs first.
