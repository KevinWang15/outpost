---
title: Sessions & Conversations
section: Core Concepts
order: 30
summary: Create, configure, fork, and recover sessions and conversations across coding tools.
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

> [!TIP]
> Under **Edit session**, changing the session **name** or **message delivery** applies immediately. Launch setting changes take effect on the next start — a running session shows **Changes apply at the next start → Restart now**.

## Forking into a Git worktree

Open a session's **…** menu and choose **Fork** to create a brand-new Git worktree on a new branch alongside a new session that inherits the source session's tool and launch settings with a fresh conversation.

## Managing and recovering conversations

Each session tracks the conversations your coding tool creates (via `/new`, `/clear`, or `/resume`). Open **Conversations** from a session's **…** menu to:

- **Resume** an earlier conversation in that session.
- **Move back** a conversation that was resumed in another stopped session.
- **New conversation** to allocate a brand-new conversation on a stopped session (useful when you want a clean slate or when a session's previous conversation moved elsewhere).

> [!NOTE]
> A conversation can belong to at most one active session at a time. If you delete a session that held a moved conversation, Outpost automatically restores ownership to its previous session.

## Finding existing conversations

Click **Find a conversation** on any machine page to search transcripts across all installed coding tools — including conversations you started outside Outpost — and link them directly into an Outpost session.
