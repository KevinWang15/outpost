# Outpost Terminal 1.0.0

Persistent Linux PTY service for Outpost web and desktop terminals.

- Independent session lifetime; clients and the Outpost server can reconnect.
- Normal terminal screen semantics and 10,000 lines of in-memory scrollback.
- Ordered reconnect checkpoints, without replaying bells or clipboard actions.
- x86_64 (baseline CPU) and ARM64 executables for glibc and musl Linux.
- No Node.js or Bun installation required on the target.
- On musl Linux, the installer also supplies the system `libstdc++` package.

Install through **Required Software → Outpost Terminal → Install**. Outpost
selects the architecture/libc, verifies SHA-256 and atomically installs the
executable into `~/.outpost/bin/outpost-terminal`. No public service port is opened.

This replaces tmux for new sessions. Before updating an existing installation,
stop its running sessions using the previous Outpost version. A running process
cannot be moved from tmux into a new PTY. Conversation files remain available.
