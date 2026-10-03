# Security policy

## Report a vulnerability

Email [me@ke.wang](mailto:me@ke.wang) with a description, affected version or
commit, reproduction steps, and expected impact. Use synthetic targets and
temporary data when preparing a reproduction. Keep credentials, private keys,
and conversation contents out of the report.

When this repository has GitHub private vulnerability reporting enabled, you
can also use **Security → Report a vulnerability**. Please report exploitable
issues privately so a fix can be prepared before disclosure.

## Supported versions

Security fixes currently target the `main` branch. Supported release versions
will be listed here when tagged releases are published.

## Security boundaries

Outpost is a personal manager accessed through loopback or an SSH localhost
tunnel. The API, development server, and preview server reject public listener
addresses. API requests must come from a loopback peer; a localhost Host header
does not authorize a remote peer. Network hosting and shared-user deployments
are outside the supported configuration.

Commands run as the manager's account for local targets and as root for SSH
targets. Reviewed installation scripts deliberately execute shell commands.
Coding tools retain their own authentication, approval, and sandbox settings.

Target settings and connection-signing keys are stored in `~/.outpost` on the
manager. Session registries and activity checkpoints stay on the execution
host. Conversation search returns bounded metadata and excerpts to the open
dialog; it does not copy entire history files to the manager.

Keep manager state, SSH credentials, and session environment values out of
commits and public issues. `OUTPOST_DATA_DIR` can select a temporary state
directory for development and tests.
