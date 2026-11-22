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

**SSH.** Hosted SSH uses only the account's Ed25519 key
and known-hosts file (`-F none`, no agent, no passwords), and rejects changed
host keys. Local Outpost uses the workstation's OpenSSH configuration and
agent. Commands run as the Linux execution account. Authorize an Outpost key
only for an account its owner should control.
Connection-sharing sockets are kept under the data directory and scoped per
owner and identity, so a connection opened with one credential is never reused
by another.

**Terminals.** A terminal connection starts with a launch token: HMAC-signed,
bound to one owner, login, target and session, valid for five minutes and
usable once. The first message returns a resume token (30 days) that only
travels inside the WebSocket; both are checked against the live login, so
signing out closes open terminals within seconds and invalidates their tokens.
Input rate, message size, unacknowledged output and terminals per account are
bounded. Closing a terminal never stops its target-side PTY service. The service listens
only on an owner-only Unix socket. Checkpoints transfer terminal state without replaying
clipboard writes, bells or browser requests. Target binaries are installed
from a fixed release after checksum and version validation.

**Outpost Desktop.** The native workspace confirms first-use server trust and
opens authorization in the system browser. A bundled Node process owns PKCE
state, saved account credentials and scoped terminal grants. It checks server
and account identity before opening a managed session. Credential-bearing HTTP
requests disable redirects. The GPUI process exchanges messages with this
helper over its inherited pipes. The profile's single-instance lock and a
random per-run secret protect local protocol handoffs.

Local shells run with the signed-in user's privileges. Managed session output
feeds Alacritty in the native process. Only HTTP and HTTPS links are eligible to
open in the browser. Remote files are saved to a user-selected destination.


**Logs and webhooks.** The activity log is served by an embedded log viewer
under `/log-viewer`, behind the same admission checks as the rest of Outpost.
Each account can read only its own log; nothing outside Outpost can write to
it, open files through it, or create the viewer's own outbound rules. Webhooks
send events, with header values that stay on the server, only to the URL the
account configured, without following redirects. A hosted server resolves the
address before each request and sends only to public addresses, connecting to
the address it checked.

**Signals.** Programs in a session can ask the attached client to open a link
(`outpost-browser`). The helper talks to the session's terminal service over an
owner-only Unix socket; the broker validates each request, limits it to 120 per
minute per connection, and delivers it at most once.

**Machines.** The machine’s Linux execution account is the trust boundary.
Session terminal services and chat hosts keep running between connections.
Their files and Unix sockets are owner-only under `~/.outpost`. An agent’s Outpost tools
act only as its own session. Owners choose the tools to provision. Built-in installers and administrator-approved packages run as the execution account. Find a conversation returns bounded metadata and excerpts. The
cross-machine history index keeps message text and embeddings on the Outpost
server, in each account's own index; native history files are only read, never
changed. Pasted images are kept under `~/.outpost/clipboard/` (newest 20 per
session).

**State.** The data directory (`~/.outpost` by default) holds the signing
secret, workspaces, and in hosted mode the account database and SSH keys.
Protect and back it up like credentials, and run one server per directory.

## Remote machine enrollment in v3

See the [accepted connectivity
design](docs/V3.md) and the [setup and cleanup procedures](README.md#machine-setup-and-removal).

- **Connect over SSH.** The local or hosted Outpost instance authenticates to the
  execution account, including through any approved bastion. It supplies the machine
  service and release checksum over SSH. After verification and installation it runs
  the node with `ssh -T`. The machine opens no connection back to Outpost, including
  after a failed SSH attempt.
- **Run setup on the machine.** An operator runs the one-time command to permit persistent
  outbound access to the chosen Outpost server. The installer exchanges a short-lived,
  single-use code bound to the owner and machine for a separate machine credential.
  The authenticated, encrypted connection authorizes only that machine’s Outpost operations.
  Revocation closes the active connection and rejects future use of the credential.
- **Ownership and transfer.** Each remote machine has one server, workspace owner,
  execution account and connection method. Outpost authorizes each attachment for its
  owner, machine and session. Removing the machine from its workspace revokes Outpost
  access. Transferring it also requires releasing its local enrollment. Administrators
  manage SSH access to the Linux account separately. [Installation and removal](docs/ARCHITECTURE.md#installing-and-removing-a-machine)
