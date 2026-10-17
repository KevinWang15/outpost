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
