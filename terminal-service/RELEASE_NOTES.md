# Outpost Terminal 1.2.0

Persistent Linux PTY service for Outpost web and desktop terminals.

This revision adds a shared clear-screen operation and includes process-exit recovery.

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
- Terminal service protocol is now 3. Checkpoint schema remains 2.

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
**Terminate → Connect** on existing sessions to start protocol 3 and resume
their conversations. Older service protocols cannot accept the new clear operation.
