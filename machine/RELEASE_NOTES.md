# Outpost Terminal 2.0.0

Outpost Terminal is now everything Outpost runs on a machine. Terminal service
protocol 5, chat host protocol 3, node protocol 1.

- `outpost-terminal node`: the machine end of the one connection Outpost keeps
  to each machine an account uses. It answers session, file, search and history
  operations, carries terminal and chat attachments and file transfers as
  streams, and forwards agents' calls to Outpost's tools to the server.
- The session registry, harness adapters, activity tracking, session files and
  native history readers moved into the executable. Targets no longer need
  Python.
- `outpost-terminal mcp` and `outpost-terminal hook` are Outpost's MCP server and
  the coding tools' activity hook. `publish`, `open` and `signal` replace the
  separate helpers.
- Sessions keep a timeline of their native conversations and a revisioned
  configuration (environment, arguments, chat instructions).
- Terminal sessions take messages from other sessions, channels and schedules:
  the terminal service types them in when the agent is idle and nobody is
  typing or drafting, or holds them for Deliver now.
- Every session gets the same Outpost tools: `list_machines`, `list_sessions`,
  `message_session`, `post_to_channel` and `fetch_file` join `publish_file` and
  the history tools.

The registry format changed: an earlier `~/.outpost/registry.json` is reported
as invalid and left untouched; remove it to start over. Terminate sessions
started by an earlier version, install this binary, then deploy the matching
server.

# Outpost Terminal 1.4.0

Chat attachments. Terminal sessions are unchanged (protocol 4); the chat host
protocol is now 2.

- A prompt carries session file IDs instead of image data. The chat host sends
  each file to the agent as an ACP resource link to the stored file, and images
  up to 5 MB also inline when the agent accepts images.
- When the agent supports additional directories, the session's file store is
  added to its session so its own tools can read attachments.

Install the matching binary before deploying the server. Running chat hosts
must be restarted (Terminate, then open the chat) to use the new protocol.

# Outpost Terminal 1.3.0

Adds chat mode's target side. Terminal sessions are unchanged (protocol 4).

- `outpost-terminal chat-serve`: the persistent Agent Client Protocol client of
  one chat session, serving viewers on `~/.outpost/chats/<session>.sock`
  (chat host protocol 1). It keeps the prompt queue and journal while viewers
  come and go, holds an agent's Outpost tool calls while the server reconnects,
  records files the agent publishes, and stops after ten minutes with no
  viewer and nothing to do. See docs/CHAT.md.
- `outpost-terminal agent codex`: the bundled Codex ACP adapter
  (`@agentclientprotocol/codex-acp` 2.6.0), run with the target's own `codex`.

Install the matching binary before deploying a server with chat mode. Running
terminal sessions keep their process; no restart is needed for them.

# Outpost Terminal 1.2.0

Persistent Linux PTY service for Outpost web and desktop terminals.

This revision adds shared clear-screen behavior, process-exit recovery and connection hardening.

- The service observes the coding process directly, independently of PTY stream closure.
- Final output gets a bounded drain before shutdown; background descendants cannot
  keep a dead coding session marked as running forever.
- Viewers restoring history receive the queued output and exit message before EOF.
- The matching server immediately offers Reconnect after receiving the exit message,
  without waiting for relay or SSH cleanup. Reconnect resumes the same conversation.
- Clear screen removes the active buffer's screen and scrollback, keeping the
  current cursor line. All viewers clear at the same point in the output stream;
  reconnect checkpoints retain the cleared state.
- Clearing sends no keys or commands to the coding tool and does not resize it.
- Clear also works when a fullscreen application leaves its cursor on row zero;
  retained hyperlinks stay valid and discarded markers are released.
- Health probes reach the terminal service without sending input to the coding
  tool. Attachments have deadlines and rapid disconnects retain their retry budget.
- Browser/SSH input queues are bounded and stalled writes fail explicitly.
- Image bytes upload separately from terminal input; the attached terminal
  pastes the saved reference using the application’s bracketed-paste mode.
- Checkpoint compression runs in yielded streaming slices; captured rows are
  released after encoding, and concurrent restorations are limited to two.
- Terminal service protocol is now 4; client protocol is 12. Checkpoint schema remains 2.

## Terminal behavior

- Independent session lifetime; clients and the Outpost server can reconnect.
- Normal terminal screen semantics and 10,000 lines of in-memory scrollback.
- Ordered reconnect checkpoints, without replaying bells or clipboard actions.
- x86_64 (baseline CPU) and ARM64 executables for glibc and musl Linux.
- No Node.js or Bun installation required on the target.
- On musl Linux, the installer also supplies the system `libstdc++` package.

Install through **Required Software → Outpost Terminal → Install**. Outpost
selects the architecture/libc, verifies SHA-256 and atomically installs the
executable into `~/.outpost/bin/outpost-terminal`. No public service port is opened.

Updating the executable does not terminate running processes. Existing services
continue running the old build. After installing, save ongoing work and use
**Terminate → Connect** on existing sessions to start protocol 4 and resume
their conversations. Older service protocols cannot accept the current clear and health-check contract.
