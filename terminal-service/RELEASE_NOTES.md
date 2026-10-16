# Outpost Terminal 1.1.0

Persistent Linux PTY service for Outpost web and desktop terminals.

This revision improves responsiveness during reconnection and fixes screen-size
ownership when several clients view the same session.

- The active viewer controls screen size; other viewers retain their preferred
  dimensions, which are restored when they take control.
- Reconnection captures an immutable checkpoint, then encodes and streams it in
  short batches while the PTY continues running.
- Repeated cells at the end of history rows are compacted without losing styles.
- Snapshot catch-up and live socket buffers are bounded; a stalled viewer is
  disconnected without stopping the session.
- Requires terminal service protocol 2 and the matching Outpost server/client.

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

Existing terminal services continue using their original protocol until restarted.
After saving or finishing their work, explicitly **Terminate** and **Connect**
those sessions. Updating the executable does not terminate running processes.
