# Security policy

## Report a vulnerability

Email [me@ke.wang](mailto:me@ke.wang) with a description, the affected commit,
reproduction steps and expected impact. Use synthetic targets and temporary
data; keep credentials, private keys and conversation contents out of the
report. If GitHub private vulnerability reporting is enabled, you can also use
**Security → Report a vulnerability**.

Security fixes target the latest release branch.

## Security boundaries

**Deployment modes.** `OUTPOST_MODE=local` (default) is a personal tool without
accounts that accepts only loopback peers with a loopback `Host` header, also
when reached through an SSH tunnel. `OUTPOST_MODE=hosted` is a multi-user
service; production requires an HTTPS `PUBLIC_APP_URL` and verification email.
Host and Origin must match the configured address, writes require the
`X-Outpost-Request` header, and forwarding headers are trusted only from
`OUTPOST_TRUST_PROXY`.

**Accounts.** Passwords use salted scrypt. Login cookies are HttpOnly,
SameSite=Lax, Secure over HTTPS, and last 30 days; only token hashes are
stored. Verification links last 24 hours and reset links one hour, both single
use. Password changes and resets revoke every login; logout revokes its own.

**SSH.** Hosted SSH uses only the account's Ed25519 key and known-hosts file
(`-F none`, no agent, no passwords), and rejects changed host keys. Local mode
uses your OpenSSH configuration and agent. SSH targets run commands as root;
authorize an account key only on servers that account's owner should control.
Connection-sharing sockets are kept under the data directory and scoped per
owner and identity, so a connection opened with one credential is never reused
by another.

**Terminals.** A terminal connection starts with a launch token: HMAC-signed,
bound to one owner, login, target and session, valid for five minutes and
usable once. The first message returns a resume token (30 days) that only
travels inside the WebSocket; both are checked against the live login, so
signing out closes open terminals within seconds and invalidates their tokens.
Input rate, message size, unacknowledged output and terminals per account are
bounded. Closing a terminal never stops the tmux session.

**Outpost Desktop.** The Electron app confirms trust before loading a server's
terminal UI. Origins must use HTTPS, except localhost HTTP. Remote windows have
no Node access, use sandboxing and context isolation, and expose only the
versioned terminal bridge. IPC checks the exact window, main frame, origin and
path; navigation, popups, webviews and downloads are restricted. Local app home
has a separate preload. Trusting a server permits its UI to notify you, copy
text and open validated HTTP(S) links. Do not trust servers you do not control.

Clipboard reads use native paste events. The paste bridge checks transient user
activation in its isolated preload; web clipboard permissions are denied.
Clipboard text is bounded to 1 MiB; OSC 52 queries are never answered. Links
open via Electron's shell API, without interpolating commands. The app stores
only trusted origins on disk; per-server Chromium sessions are nonpersistent.
Launch links can briefly be visible to local processes. The fragment is erased
before rendering, and resume tickets remain in window-scoped session storage.
Removing server trust closes its windows; signing out revokes the underlying
grants. These first installers are unsigned previews with manual updates.

**Signals.** Programs in a session can ask the attached client to open a link
(`outpost-browser`). The helper talks to the relay over a Unix socket in a
0700 directory; the broker validates each request, limits it to 120 per minute
per connection, and delivers it at most once.

**Targets.** Nothing runs on a target between operations. Installation scripts
run only as reviewed and submitted. Conversation search returns bounded
metadata and excerpts; history files are never copied to the server. Pasted
images are kept under `~/.outpost/clipboard/` (newest 20 per session).

**State.** The data directory (`~/.outpost` by default) holds the signing
secret, workspaces, and in hosted mode the account database and SSH keys.
Protect and back it up like credentials, and run one server per directory.
