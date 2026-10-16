# Outpost Terminal 1.1.2

Persistent Linux PTY service for Outpost web and desktop terminals.

This revision restores detection and recovery when the coding tool exits.

- The service observes the coding process directly, independently of PTY stream closure.
- Final output gets a bounded drain before shutdown; background descendants cannot
  keep a dead coding session marked as running forever.
- Viewers restoring history receive the queued output and exit message before EOF.
- The matching server immediately offers Reconnect after receiving the exit message,
  without waiting for relay or SSH cleanup. Reconnect resumes the same conversation.
- Terminal service protocol 2 and checkpoint schema 2 are unchanged.

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
continue running the old build. After installing, use **Terminate → Connect** on
an affected session to start the corrected service and resume its conversation.
The protocol is unchanged; healthy sessions can keep running until you choose
to restart them.
