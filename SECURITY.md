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

Hosted mode requires verified accounts for target and account APIs. Targets,
private Ed25519 SSH keys, and known-host files belong to individual accounts.
Manager SSH connections disable shared configuration and agents and use only
that account's key. Hosted users cannot execute commands on the manager through
local targets or desktop launching. Authorize account keys only on servers the
account owner should control: SSH currently runs as root. Users granted access
to the same remote root account share that server's sessions and conversation
history according to its SSH permissions.

Production requires an HTTPS `PUBLIC_APP_URL` and configured verification email
delivery. Run the built app behind an HTTPS reverse proxy. Host and Origin must
match the configured address; writes require a custom header. Trust forwarding
headers only from explicitly configured proxy addresses. Development email
simulation, local mode, Vite, and preview remain loopback-only.

Passwords use salted scrypt. Login cookies are HttpOnly, SameSite=Lax, Secure
over HTTPS, and expire after 30 days. Only token hashes are stored. Verification
links expire after 24 hours, reset links after one hour; both are single use.
Password changes and resets revoke every login session and connection ticket.
Logout revokes its session and its tickets. Rate limits bound account attempts.

Web terminals are explicitly launched from the session menu. Uploaded private
keys are scoped to an account and target, normalized after bounded parsing in a
worker, and encrypted with AES-256-GCM authenticated against that ownership.
Upload passphrases are discarded after decryption. Files are mode 0600 in a
0700 directory; metadata APIs never return key material. Production requires a
32-byte base64 `OUTPOST_TERMINAL_ENCRYPTION_KEY` held separately from the data
directory. Protect and back up both. A trusted backend operator can access keys
in memory; encryption does not protect against a compromised running server.

SSH host keys are checked against account management known-host records and
pinned for web connections on first use. Changed keys fail closed. WebSocket
upgrades require the permitted browser Origin and a verified login; terminal
IDs are scoped to the originating login and are not bearer credentials. Login
revocation is checked on input and every second. Key replacement/removal and
target deletion close corresponding terminals. Terminal output is held only
in bounded memory; reconnect restores a screen snapshot, not an unbounded log.
Input, output backpressure, uploads and concurrent terminal counts are bounded.
Disconnected attachments expire after 10 minutes. Closing an attachment does
not terminate the remote tmux/dtach session.

`OUTPOST_MODE=local` preserves the personal workflow without accounts. Its API
requires a loopback peer, including when accessed through an SSH localhost
tunnel. A localhost Host header does not authorize a remote peer.

Commands run as the manager's account for local targets and as root for SSH
targets. Reviewed installation scripts deliberately execute shell commands.
Coding tools retain their own authentication, approval, and sandbox settings.

Account data, target settings, SSH keys, and connection-signing keys are stored
in `~/.outpost` on the manager. Protect and back up this directory as credentials;
run one manager process per directory. Session registries and activity checkpoints stay on the execution
host. Conversation search returns bounded metadata and excerpts to the open
dialog; it does not copy entire history files to the manager.

Keep manager state, SSH credentials, and session environment values out of
commits and public issues. `OUTPOST_DATA_DIR` can select a temporary state
directory for development and tests.
