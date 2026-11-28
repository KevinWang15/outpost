---
title: Sessions & Conversations
section: Core Concepts
order: 30
summary: Create, edit, monitor, fork, and recover sessions and conversations across coding tools.
---

# Sessions & Conversations

A **session** binds a friendly name, a project directory, a coding tool, and reusable launch settings on one machine. Sessions keep running in the background when you disconnect, and remember their conversation timeline across restarts.

## Creating a session

You can create sessions from three places:

1. **Web UI**: Select a machine in [Machines](/) and click **New session**.
2. **Outpost Desktop**: Press `Ctrl+Shift+O` (or `Cmd+Shift+O` on macOS) to open the session picker and click **+ New session**.
3. **Machine CLI**: Run `outpost new` right inside your project directory on the Linux machine — see [Machine CLI](05-machine-cli.md).

### Launch settings

Every session supports the same configuration:

- **Copy settings from** — pre-fill tool, instructions, model, agent mode, arguments, environment variables, and MCP servers from an existing session on that machine.
- **Instructions** — extra system/developer instructions appended to the coding tool.
- **Model & Agent mode** — override the model name (used in terminals and Chat) and agent mode (used in Chat).
- **Arguments** — extra CLI flags parsed with Bash syntax (e.g., `--verbose`). Flags that hijack conversation selection (like `--resume`) are reserved for Outpost.
- **Environment variables** — `KEY=VALUE` pairs passed to both terminal and Chat drivers.
- **MCP servers** — standard `mcpServers` JSON objects (`stdio` command or `http` URL) merged alongside Outpost's built-in `outpost` MCP server.

## Editing a session

Open **Edit session** from a session's **…** menu to update any session parameter after creation:

- **Name** and **Message delivery** take effect immediately.
- **Coding harness** — switch the session to another installed coding tool on the same machine. Remembered conversation IDs from earlier harnesses are preserved on the session.
- **Project directory** — point the session at a different directory (with live path autocomplete).
- **Resume conversation ID** — choose a remembered conversation, enter a native ID directly, or click **Start fresh** to clear it so the next start begins a new conversation.
- **Launch settings & Edit source** — update instructions, model, mode, arguments, environment variables, or MCP servers in the form or as a single JSON document via **Edit source**, with a live **Start command** preview.

> [!TIP]
> When you change a running session's harness, directory, conversation ID, or launch settings, Outpost prompts right after saving to **Close and restart now** or apply the changes **Later** on the next start.

## Session order and live status

- **Most recently used order**: Sessions across **Machines**, **Chat**, and **Outpost Desktop** are sorted by most recently used so active work stays near the top.
- **Live agent status (OSC 7501)**: Running sessions report live **Working** (including optional progress and detail text), **Waiting** (blocked on approval or input), and **Turn finished** badges via the OSC 7501 Program Status Protocol. Unread **Turn finished** badges stay latched until you return to the pane or click the badge to mark it checked.

## Forking into a Git worktree

Open a session's **…** menu and choose **Fork** to create a brand-new Git worktree on a new branch alongside a new session that inherits the source session's tool and launch settings with a fresh conversation.

## Managing and recovering conversations

Each session follows the conversation its coding tool is in: when you start a new one (`/new`, `/clear`), resume one (`/resume`) or branch one (`/branch`) in the session's terminal, Outpost makes it current and records the move in [Logs](/logs). When the coding tool starts again, after it exits, after **Restart now** or after a reboot, it reopens that conversation. Copies that run in the background, such as Claude Code's `/fork` copies and the sessions in its agent view, don't change the session's conversation. Open **Conversations** from a session's **…** menu to:

- **Resume** an earlier conversation in that session.
- **Move back** a conversation that was resumed in another stopped session.
- **New conversation** to allocate a brand-new conversation on a stopped session (useful when you want a clean slate or when a session's previous conversation moved elsewhere).

> [!NOTE]
> A conversation can belong to at most one active session at a time. If you delete a session that held a moved conversation, Outpost automatically restores ownership to its previous session.

## Finding existing conversations

Click **Find a conversation** on any machine page to search transcripts across all installed coding tools — including conversations you started outside Outpost — and link them directly into an Outpost session.
