# Conversation tracking

A session reopens the conversation the user was last working in. This page states
the behaviour every change to sessions, drivers, hooks or harness adapters must keep.
Tests check it (see [Tests](#tests)).

## The rule

A session's current conversation is the one its coding tool is in, whether the tool
runs in the session's terminal or in chat. When the tool moves to another
conversation, Outpost makes that one current in the session's timeline and records
the move in Logs. In a terminal, only the tool itself can report a move: reports from
any other program are ignored, even when they carry the session's identity.

The timeline is the session record in `~/.outpost/registry.json`. Restoring a session
means starting its coding tool on the current conversation. Keeping a process alive
is a separate mechanism, and restoring does not rely on it.

## What the user sees

| The user | Result |
| --- | --- |
| Closes the tab, loses the connection, or switches devices | The tool keeps running. Reconnecting shows the same screen. |
| Starts a new conversation in the tool (`/new`, `/clear`) | The new conversation becomes current. Codex and Antigravity CLI report a new conversation at its first prompt; until then the previous one stays current. |
| Resumes any conversation in the tool (`/resume`), including one started outside Outpost or in another session | It becomes current. If another session held it, it moves to this one. |
| Branches into a copy (`/branch` in Claude Code, `/fork` in Antigravity CLI) | The branch becomes current. |
| Compacts, by hand or automatically | Nothing changes: the tools keep the same conversation. |
| Makes a copy without switching to it (`/fork` in Claude Code or Kimi Code), or runs subagents | Nothing changes. |
| Chooses **New conversation** in chat | The new conversation becomes current. |
| Picks another conversation in **Conversations** in the app | The app's choice becomes current. |
| Comes back after the tool exits, after **Restart now**, or after a reboot | The tool starts on the current conversation. |

### Claude Code's agent view

Sessions listed in Claude Code's agent view run in Claude Code's own background
service, outside the session's terminal. Opening one from agent view does not change
the Outpost session's conversation, and the copies the background service makes are
not the terminal's. When the tool next starts, the session reopens the terminal's own
conversation; what was typed in a session opened from agent view stays in that
session. Every conversation stays in the coding tool's history, and
**Find a conversation** can open any of them as its own session.

Codex's agent view switches conversations inside the terminal's own process, so
Outpost follows it like `/resume`.

## How Outpost decides

In a terminal, each launch installs the tool's session-start hook, which runs
`outpost-terminal hook`. The hook passes on only conversation identity fields, and
`TerminalActivity.sessionEvent` applies them. Turn activity never comes from these
hooks.

The coding tool runs under `setsid` with the session's PTY as its controlling
terminal, so it leads a process session of its own. Tools run hook commands through
a shell, so the program that ran a hook is its nearest ancestor that is not a shell
(`runnerSession` in `machine/processes.ts`). The hook reports that program's process
session, and the terminal service accepts the report only when it is the
terminal's. Background services that a tool starts, such as Claude Code's
agent-view service and the sessions it hosts, run in process sessions of their own,
so their hooks are ignored. The rule names no tool and no hook event; harness
adapters only translate each tool's payload (`hookPayload`).

In chat, the chat host starts and loads conversations itself over ACP, so it knows
each move without hooks; the tools' hooks do nothing there.

Both drivers apply a move with `followConversation` (`machine/registry.ts`). It
records a `conversation` event in the machine's event log, which Logs shows as
"*session* moved to conversation *ID* in a terminal" or "… in chat". Moves the app
makes, from **Conversations** or with **New conversation** on a stopped session,
are logged by the server instead.

A program the agent runs, such as a nested `claude -p`, does not run Outpost's hook.
The hook is configured on the command line Outpost launches, not in the tool's
settings files.

## Known gaps

- Kimi Code's `/fork` reports the copy as if it were resumed, so the copy is current
  until the next prompt switches back. The copy holds the same history.

## Tests

- `tests/machine/activity.test.ts`: which hook reports change the conversation, and
  that each change is recorded once.
- `tests/integration/node-chat.test.ts`: the conversation a chat host starts becomes
  current and is recorded.
- `tests/integration/conversation-hooks.test.ts`: through the server, the machine
  service and a real terminal service, the tool's own hook moves the session and
  reaches Logs, a background service's hook does not, and the tool starts again on
  the tracked conversation.
- `tests/machine/native.test.ts` (opt-in, `OUTPOST_TEST_NATIVE_ACTIVITY=1`): the
  installed coding tools report their conversations through these hooks.

Changes to this behaviour should also be checked by hand with the installed tools:
`/new` or `/clear`, `/resume`, `/branch`, `/fork`, Claude Code's agent view, and a
restart. On 28 November 2026 this was done with Claude Code 2.1.325, Codex 0.172.0,
Kimi Code 2.7.2 and Antigravity CLI 1.5.19, and each matched the table above.
