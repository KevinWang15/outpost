---
title: Machine CLI
section: Tools & Workflows
order: 50
summary: Install and use the `outpost` CLI on Linux machines to create, list, and auto-open sessions from any shell.
---

# Machine CLI

The **Machine CLI** (`outpost`) is built directly into the `outpost-terminal` executable installed on every Outpost machine. It lets you spin up new sessions from whatever directory you are currently working in — using either an **interactive terminal UI** or **non-interactive flags** — and automatically open them in Outpost Desktop or the Web terminal.

## Installing the CLI

Every enrolled Outpost machine already has the CLI wrapper at `~/.outpost/bin/outpost`. To put `outpost` directly on your shell `PATH`:

```bash
~/.outpost/bin/outpost-terminal install-cli
```

By default this installs an executable wrapper to:

- `~/.local/bin/outpost` for regular users
- `/usr/local/bin/outpost` when run as `root`

You can also choose a custom directory:

```bash
~/.outpost/bin/outpost-terminal install-cli --dir ~/bin
```

If the install directory is not yet in your `PATH`, `install-cli` prints the exact `export PATH=...` line to add to your `~/.bashrc` or `~/.zshrc`.

> [!NOTE]
> On a machine running Outpost in local mode as `root` (for example under systemd in WSL), sessions live in `/root/.outpost`. Run `outpost` as that same execution user so it shares the server's session registry.

## Creating a session interactively (`outpost new`)

`cd` into any project directory and run:

```bash
outpost new
```

When run in an interactive TTY (without `--yes` or `--json`), `outpost new` opens a full-screen terminal UI with the same fields as **New session** in the Outpost app, pre-filled with sensible defaults:

- **Directory** — pre-filled with your current working directory (`$PWD`), with a live `exists` / `new` badge.
- **Session name** — pre-filled with a unique basename derived from the directory (and stays synced as you edit the directory until you customize it).
- **Coding tool** — defaults to your most recently used installed tool (or the first installed terminal-capable tool) and highlights which tools are available on the machine.
- **Create directory** — automatically checked when the chosen path does not exist yet.
- **Copy settings from** — optionally pick an existing session on this machine to inherit its tool, instructions, model, mode, arguments, environment, and MCP servers.
- **Instructions** — optional extra instructions for the agent.
- **Advanced section** (collapsible) — **Model**, **Agent mode**, **Arguments**, **Environment variables** (`KEY=VALUE`, space/comma/newline separated), and **MCP servers** (inline JSON or `@path/to/mcp.json`).

### Interactive TUI keyboard shortcuts

| Key | Action |
| --- | --- |
| `Tab` / `Shift+Tab` or `↑` / `↓` | Move between fields |
| `←` / `→` | Cycle coding tool or **Copy settings from** selection |
| `Space` | Toggle **Create directory** or expand/collapse **Advanced** |
| `Ctrl+S` | Submit and create the session from any field |
| `Enter` | Move to the next field, or submit when on the **Create & open in Outpost** button |
| `Ctrl+A` / `Ctrl+E` | Jump to start / end of the current text input |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W` | Clear to start / clear to end / delete previous word |
| `Esc` or `Ctrl+C` | Cancel without creating a session |

## Non-interactive usage and scripting

Pass `-y` (`--yes`) or `--json` to skip the TUI and create a session immediately with flags. Any flag you pass also pre-fills the TUI when `-y` is omitted!

```bash
# Quick session in the current directory with default tool and directory basename
outpost new -y

# Create a session in a new folder with custom tool, model, instructions, and env vars
outpost new ~/dev/my-app -y \
  --create-dir \
  --name "My App" \
  --tool claude \
  --model opus \
  --instructions "Keep changes small and add unit tests" \
  -e NODE_ENV=development \
  -e DEBUG=app:*

# Clone launch settings from an existing session and override one env var
outpost new -y --copy-from "My App" -e NODE_ENV=staging

# Machine-readable JSON output for scripts (suppresses interactive TUI)
outpost new -y --json --no-open
```

### All `outpost new` flags

| Flag | Description |
| --- | --- |
| `[DIR]` or `-d, --dir <PATH>` | Project directory (defaults to current working directory) |
| `-n, --name <NAME>` | Session name (defaults to unique directory basename) |
| `-t, --tool <TOOL>` | Coding tool: `claude`, `codex`, `kimi`, `deepseek`, or `antigravity` |
| `--create-dir` / `--no-create-dir` | Create the target directory if it does not exist |
| `--copy-from <SESSION>` | Copy launch settings from an existing session (name or ID prefix) |
| `-i, --instructions <TEXT>` | Session instructions |
| `-m, --model <MODEL>` | Model override |
| `--mode <MODE>` | Agent mode for Outpost Chat |
| `-a, --args <ARGS>` | Extra CLI arguments (Bash syntax) |
| `-e, --env <KEY=VALUE>` | Environment variable (repeatable) |
| `--mcp <JSON\|@FILE>` | MCP servers JSON object or `@path/to/file.json` |
| `-y, --yes` | Create non-interactively without launching the TUI |
| `--no-open` | Do not send the auto-open escape sequence to the terminal |
| `--json` | Output the created session record as JSON |
| `-h, --help` | Show command help |

## Listing and attaching to existing sessions

```bash
# List all sessions on this machine
outpost ls

# JSON output for scripting
outpost ls --json

# Open an existing session in Outpost by name (case-insensitive) or ID prefix
outpost attach my-app
```

## Auto-open in Outpost

When you submit `outpost new` (without `--no-open`) or run `outpost attach <session>`, the CLI writes a private **OSC 7770** terminal escape sequence directly to `/dev/tty`:

```text
ESC ] 7770 ; outpost;open-session;<base64url-json> BEL
```

- **Inside Outpost Desktop** — works from **both** remote Outpost panes and local shell panes (for example, when you `ssh` into a Linux server or run `wsl` inside a local Outpost tab). Outpost Desktop detects the OSC 7770 sequence, shows a brief toast, matches the session across your signed-in Outpost servers, and opens (or focuses) the session tab automatically.
- **Inside the Web terminal** — Outpost's browser terminal detects the same sequence and opens the session in a new same-origin browser tab (or offers a direct link if pop-ups are blocked).
- **Inside `tmux` or GNU `screen`** — the CLI automatically wraps the sequence in DCS passthrough (`\x1bPtmux;...\x1b\\` or `\x1bP...\x1b\\`). In `tmux` 3.3+, make sure passthrough is enabled in `~/.tmux.conf`:
  ```tmux
  set -g allow-passthrough on
  ```
- **Outside Outpost** (such as Terminal.app, Windows Terminal, or iTerm2) — standard terminals silently ignore unknown OSC numbers, and `outpost new` prints the session ID (plus direct Web and App URLs on outbound-enrolled machines).

> [!TIP]
> For security, Outpost Desktop only opens sessions belonging to **already signed-in** servers and never initiates a connection or login prompt to an untrusted origin from terminal output.

## Troubleshooting

- **Auto-open didn't open a tab**:
  - Make sure you ran `outpost new` / `outpost attach` inside an **Outpost Desktop** or **Outpost Web** terminal pane.
  - Ensure you are signed in to the Outpost server that owns the machine (if not, Outpost Desktop shows a toast explaining why the session couldn't be found).
  - If you are inside `tmux`, check that `set -g allow-passthrough on` is set in your tmux config.
- **Command not found: `outpost`**:
  - Run `~/.outpost/bin/outpost-terminal install-cli` and open a new shell (or add `~/.local/bin` to your `PATH`).
- **Session created, but not visible in Outpost**:
  - Confirm you ran `outpost` as the same Linux user that Outpost connects to (check `whoami` vs. your machine's SSH user or systemd `User=`).
