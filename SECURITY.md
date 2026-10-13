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

**The connector.** It runs on your computer and only talks to Outpost servers
you trusted by running their installer. `outpost://` links for other servers
are refused before any network access. It reads your clipboard only on a paste
gesture (⌘V/Ctrl+V/Alt+V); remote programs can write to your clipboard through
OSC 52 but clipboard queries are never answered. It opens only `http(s)` links
without credentials, and never through a shell. A trusted server can open
terminals into its own sessions on your computer; only trust servers you would
let run your coding sessions. The launch token in an `outpost://` link is
visible to local processes for the few seconds before it is used.

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
