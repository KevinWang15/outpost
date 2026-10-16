# Outpost Terminal 1.1.1

Persistent Linux PTY service for Outpost web and desktop terminals.

This revision makes the checkpoint adapter's engine contract explicit.

- Typed xterm internals replace unchecked access in the shared checkpoint adapter.
- Runtime checks reject an unsupported engine layout before reading or restoring state.
- Terminal service protocol 2 and checkpoint schema 2 are unchanged.
- The matching Outpost server reports permanent setup failures directly and runs
  dependency installation without interactive shell job-control warnings.

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
continue running, and newly started services use the installed build. No protocol
restart is required for this patch.
