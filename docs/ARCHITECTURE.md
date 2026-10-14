# Outpost v2 architecture

Outpost keeps AI coding sessions (Claude Code, Codex, Kimi Code) running in tmux
on Linux machines, and lets you return to them from a browser or from your own
terminal app as if the session were running on your computer.

This document is the source of truth for how Outpost behaves and why. Code
comments refer back to the principles below by name.

## Principles

1. **tmux is the only terminal state.** A coding session is a dedicated tmux
   server on its target. Every connection is disposable: connecting means
   attaching, reconnecting means attaching again, and tmux redraws the screen.
   Outpost never holds PTYs, screen snapshots or replay buffers.
2. **One connection path.** Every terminal — web, browser app or native —
   uses the same chain:

   ```text
   client ⇄ WebSocket ⇄ Outpost broker ⇄ transport (SSH or local shell) ⇄ relay ⇄ tmux
   ```

   There is no second way to connect, no copied shell command, and no desktop
   launcher on the server. Hosted and local installations run the same code.
3. **Modes differ only in identity.** A *deployment* answers four questions:
   who owns this request, where is their workspace stored, which SSH identity
   do they use, and may they use this computer as a target. Everything else —
   sessions, software, terminals, the UI — is mode-agnostic.
4. **Agentless targets.** The target runtime is a Python program sent with each
   operation. Nothing is installed or left running on a target except tmux
   itself and Outpost's state files in `~/.outpost`.
5. **The client shims the platform.** Making a remote session feel native
   (paste an image with the usual shortcut, Shift+Enter for a newline, copying
   to your clipboard, opening links on your computer) is the client's job.
   Knowledge about a particular terminal app lives in one launcher adapter.
   OS URL handlers are shared by all launchers on that OS.
6. **Explicit gestures only.** The local clipboard is read only on a paste
   gesture, never polled. Remote programs can copy to your clipboard (OSC 52)
   and ask to open `http(s)` links, but can never read your clipboard.
7. **Extensible at the edges, small in the middle.** Native terminals, coding
   harnesses, signal types and transports are registries or interfaces. The
   data path between them stays a dumb, well-specified pipe.

## Components

```text
                 ┌──────────── your computer ────────────┐
  Browser UI ────┤ web / Terminal app (same xterm.js)     │
                 │ native connector (Python) in iTerm2 / │
                 │   Windows Terminal + WSL              │
                 └───────────────┬───────────────────────┘
                                 │ HTTPS + WebSocket (terminal protocol)
                 ┌───────────────┴───────────────────────┐
                 │ Outpost server (Node, Fastify)        │
                 │  deployment · workspace · sessions    │
                 │  software · terminal broker           │
                 └───────────────┬───────────────────────┘
                                 │ OpenSSH or local bash (relay protocol)
                 ┌───────────────┴───────────────────────┐
                 │ Linux target                          │
                 │  runtime (per operation) · relay      │
                 │  tmux server per session · harness    │
                 └───────────────────────────────────────┘
```

| Directory | Runs on | Role |
| --- | --- | --- |
| `frontend/` | Browser | Workspace UI, Connect dialog, web terminal client |
| `backend/` | Outpost server | HTTP API, deployments, transports, terminal broker |
| `runtime/` | Targets | Session registry, tmux control, relay, harness adapters |
| `connector/` | Your computer | Native terminal client, installer, OS link handlers and client launchers |
| `shared/` | Browser + server | Types, harness and connector-launcher registries, protocol |

**One definition per contract.** Request and stored-record shapes are TypeBox
schemas in `shared/schemas.ts`; the server validates with them and the types in
`shared/model.ts` are derived from them. Contracts that also exist in Python —
the harness and terminal registries, the terminal protocol's version, message
types, close reasons and signals, and the relay framing — are checked against
each other by `tests/unit/contracts.test.ts`.

## Supported platforms

| Role | Supported |
| --- | --- |
| Targets (where sessions run) | Linux with Bash, Python 3.9+ and tmux 3.2+. SSH as root, or the Outpost computer itself when the server runs on Linux (including WSL). |
| Outpost server | Node.js 24+ with OpenSSH, on Linux (including WSL) or macOS. Hosted deployments run on Linux. |
| Native terminals | macOS: iTerm2. Windows: Windows Terminal with a WSL distribution (Bash, Python 3). |
| Web terminal | Any current browser, including phones. |
| Terminal app | Chrome or Edge on macOS / Windows. Connector runs on macOS (Python 3.9+) or WSL (Bash, Python 3). Windows Terminal is optional. |

The web terminal pins a built package from the `outpost-6.0` branch of
[KevinWang15/xterm.js](https://github.com/KevinWang15/xterm.js/tree/outpost-6.0).
It backports upstream's Ctrl+/ fix to xterm.js 6.0.0; the release URL and package
integrity are locked in `package-lock.json`. Return to the upstream package when
upgrading to a release containing [#5515](https://github.com/xtermjs/xterm.js/pull/5515).

## Deployment modes

`OUTPOST_MODE=local` (default) or `hosted`. Both register the same routes,
except that hosted adds account routes.

| | Local tool | Hosted service |
| --- | --- | --- |
| Owner | The single local user | A verified account and login session |
| Workspace | `DATA/workspace.json` | `DATA/users/<id>/workspace.json` |
| SSH identity | Your OpenSSH config, agent and keys | A per-account Ed25519 key and known-hosts file |
| Local targets | Yes, when the server runs on Linux | No |
| Network | Loopback only | Behind an HTTPS reverse proxy |

`backend/deployment.ts` defines the interface; `backend/hosted/` implements the
account side. Routes receive an owner and a resolved target context; they never
branch on the mode.

## Terminal data path

### Connect flow

1. The UI calls `POST /api/targets/:t/sessions/:s/connect` with the chosen
   terminal (`web`, `terminal-app`, `iterm2`, `windows-terminal`). The server checks the
   session exists and returns a **launch token** (HMAC-signed, 5 minutes,
   single use) bound to owner, target and session.
2. **Web terminal:** the browser opens `wss://…/api/terminal?token=…`.
   **Connector choices:** the browser navigates to `outpost://connect/<payload>`.
   The OS handler calls `outpost-connector open <url>`, validates server trust,
   then dispatches through the launcher registry. Native launchers run
   `outpost-connector attach <url>` in a terminal tab. Terminal app opens
   `/terminal/app#token=<launch>` in a Chrome/Edge app window; the page removes
   the fragment and opens the same WebSocket with the existing web client.
3. The first message from the server is `hello` with a **resume token**
   (30 days, validated against the live login on every use, revoked on sign-out).
   Reconnects send it in the WebSocket upgrade query. It never appears in
   launcher links, page URLs or process arguments. Proxies must not log
   `/api/terminal` query strings. Outpost disables request logging.
4. For connector choices the UI polls `GET /api/connections/:id` to confirm
   the client attached, or offers setup help. Retrying requests a fresh launch
   ticket, so installation delays and previously consumed links are recoverable.

### Client choices and shared responsibilities

| Choice | Launcher | Client that owns the WebSocket | Initial authorization |
| --- | --- | --- | --- |
| Web terminal | `ConnectDialog` opens `/terminal?target=…&session=…` | `TerminalView` → `TerminalSocket` | `AuthGate` and `TerminalPage` request a grant using the browser login |
| Terminal app | Connector → `terminal_app` → OS browser app window | The same `TerminalView` → `TerminalSocket` | `appTicket` consumes the launch fragment; broker validates the grant |
| iTerm2 | Connector → `iterm2` → native tab | Python `Session` | The same launch grant in `outpost://` |
| Windows Terminal | Connector → `windows_terminal` → WSL tab | Python `Session` | The same launch grant in `outpost://` |

`frontend/Root.tsx` routes only `/terminal/app` outside `AuthGate`. Serving this
page does not authorize a connection or grant account API access. The broker
checks the same signed grant, session ownership and original login liveness
for every client. Opening Terminal app from a different browser/profile needs
no copied login cookie, second account token or connector HTTP service.

`appTicket.ts` removes the launch fragment before React renders, stores it in
window-scoped `sessionStorage`, and replaces it with the resume token on
`hello`. This survives reloads and automatic reconnects while keeping separate
windows independent. Explicit Close or an expired/revoked grant clears it.
If storage is unavailable, the socket still reconnects in memory; a reload
requires a fresh Connect. Resume grants never enter `localStorage`. Browser
session restoration may retain session storage; the originating login remains
the revocation boundary. Launch grants expire after five minutes, resume
grants after 30 days, and both are bound to the original login and one session.

Toolbar visibility is a UI preference in the shared `TerminalView`; resizing
uses its existing observer and never opens another connection. Keyboard,
clipboard, composer, links, bells and notifications have one web implementation.

The app has a `display: standalone` manifest with a credential-free start URL,
but the connector uses Chromium's `--app` launch mode, without installing a PWA
or creating a browser profile. Chrome is preferred on macOS, Edge on Windows.
A manually installed shortcut starts at the connection instructions; the
Connect dialog chooses sessions. There is no service worker, offline terminal
cache, browser-profile cookie dependence or extra relay. See
[Chrome's installation criteria](https://developer.chrome.com/blog/update-install-criteria)
for browser-menu installation without a service worker.

### Terminal protocol (client ⇄ broker, WebSocket)

Binary frames carry raw terminal bytes in both directions. Text frames carry
JSON control messages (`shared/protocol.ts`):

| Direction | Message | Meaning |
| --- | --- | --- |
| → server | `resize {cols, rows}` | Client geometry |
| → server | `ack {bytes}` | Output rendered; flow control |
| → server | `send {id, data}` | Input that must be confirmed (composer drafts) |
| → server | `paste-image {id, mediaType, data}` | Upload an image and paste its path |
| ← client | `hello {resume, session, target}` | Connection accepted |
| ← client | `ready` | Attached to tmux |
| ← client | `result {id, ok, message?, reference?}` | Outcome of `send` / `paste-image` |
| ← client | `signal {type, payload}` | A remote request, e.g. `browser.open` |
| ← client | `closed {reason, message}` | `detached`, `ended`, `expired`, `outdated`, `error` |

The server pauses the transport when more than 1 MiB is unacknowledged.

**Compatibility.** Connectors are installed on users' computers and lag behind
servers, so every client sends `?protocol=<version>` (`protocolVersion` in
`shared/protocol.ts`, `PROTOCOL` in the connector). The server accepts only its
own version and otherwise closes with `outdated`: connectors are shown the
install command, browsers are asked to reload. The check happens before the
launch token is redeemed. Additive changes that old clients ignore keep the
version; anything an old client would misread bumps it.

### Relay protocol (broker ⇄ relay, stdio)

The broker starts the relay through the target's transport exactly like any
other runtime operation (`ssh -T … "$SHELL -lic …"`, or the login shell
locally). Login shells may print first; the relay then prints a magic marker
and exchanges length-prefixed frames: one type byte, a 4-byte big-endian
length, and the payload. If the runtime fails before the marker (a missing
session, missing tmux), its `OUTPOST_RESULT` error becomes the client's
`closed` message.

| Type | Direction | Payload |
| --- | --- | --- |
| `I` | broker → relay | Input bytes for tmux |
| `O` | relay → broker | Output bytes from tmux |
| `C` | both | JSON control: `resize`, `paste-image`, `signal-result` / `ready`, `paste-result`, `signal`, `exit` |

Framing replaces in-band escape sequences, so typed or pasted bytes can never
be mistaken for control messages. The relay owns a PTY for `tmux attach`, so
SSH needs no PTY and window sizes travel as `resize` messages.

### tmux, configured to disappear

Each session is its own tmux server (`~/.outpost/sockets/<id>.sock`, no user
configuration) set up so it feels like the tool is running directly in your
terminal: no status bar, `escape-time 10`, mouse scrolling and selection with
copy on release, `set-clipboard on` (OSC 52 out), extended keys for
Shift+Enter, truecolor, focus events, 50,000 lines of history and `Ctrl+\` to
detach. Connecting starts a stopped session in the same conversation.

**Forking** is one target management operation under the registry lock. The
runtime creates a new branch from the source directory’s `HEAD` with
`git worktree add -b`, then allocates a fresh harness conversation and saves
its session. It inherits the source tool and launch settings. Git receives
the branch and path as argument values; its failures stop before conversation
allocation or registration. SSH and local targets use their existing
management transports. If harness allocation fails after Git succeeds, the
error identifies the created worktree so it can be reused or removed manually.

### Signals

Coding sessions run with `BROWSER=~/.outpost/bin/outpost-browser`. The helper
talks to the most recently attached relay over a Unix socket in
`~/.outpost/run/`. The relay forwards a `signal` control message; the broker
validates it (`browser.open` accepts only `http(s)` URLs without credentials)
and passes it to the client on that connection, which opens the link on your
computer. Delivery is at most once. With no attached terminal, the helper
fails with a clear message.

## Connector launchers and OS integration

`shared/terminals.ts` lists connector choices for the UI (id, name, supported
OSes, requirements and key hints). `connector/outpost_connector/terminals/`
holds one launcher per id, with `PLATFORMS`, `install`, `uninstall` and `open`.
The contract test checks names/platforms and the app entry path across Python,
TypeScript and the manifest. New launchers reuse the existing grant/protocol.

`connector/outpost_connector/desktop/` owns one URL handler per OS. macOS
installs a signed AppleScript app that invokes `connector open`. Windows
registers a hidden PowerShell handler that calls WSL `connector open`, with
the distro and launcher stored as UTF-8 JSON. Every launch is validated before
dispatch. The Windows handler does not require `wt.exe`; only its native
launcher does. Terminal adapters install optional profiles separately, so
the handler cannot be overwritten by whichever adapter installs last.

| Terminal | Integration installed by the connector | Native shortcuts |
| --- | --- | --- |
| Terminal app | No terminal profile; uses the shared OS handler to launch Chrome/Edge | Same as web terminal |
| iTerm2 | *Outpost* dynamic profile mapping ⌘V to Outpost paste, ⇧↩ to CSI u, Option as Meta | ⌘V pastes text and images, ⇧↩ newline |
| Windows Terminal | *Outpost* fragment profile running WSL (skipped if Windows Terminal is absent) | Ctrl+V text (native), Alt+V or Ctrl+V-with-image pastes images, Ctrl+Enter newline |

The Python native client handles, for iTerm2 and Windows Terminal:

- **Paste:** the private Outpost paste key (`ESC [9001~`, sent by profile key
  mappings) reads the clipboard and pastes an image or bracketed text; Ctrl+V
  and Alt+V paste an image when the clipboard holds one and otherwise pass
  through unchanged. Keystrokes typed after a paste gesture wait for the
  clipboard decision, so their order is kept. Images go to the target over the
  open connection and their path is pasted into tmux once. Gestures inside a
  bracketed paste or a terminal reply are never interpreted.
- **Copy:** OSC 52 from tmux or the coding tool is written to your clipboard
  and stripped from the stream, so no terminal permission prompt is needed.
- **Links:** `signal` messages open URLs with the OS (`open`, Windows shell).
- **Reconnect:** network drops reconnect automatically; detaching or the
  session ending shows a banner (Enter reconnects, Ctrl+C closes).

Native clipboard and remote link access are platform adapters (`platforms.py`),
separate from desktop launchers. Terminal app hands off to the web client and
does not start the Python `Session` or proxy the socket. Re-running the installer
upgrades the shared handlers and profiles; uninstall removes all of them and
all trusted servers. It does not remove browsers or manually installed PWAs.

## Coding harnesses

`shared/harnesses.ts` lists harnesses for the UI and validation (id, label,
command, installer, native ID pattern, storage variable).
`runtime/outpost_harness.py` defines the adapter contract; each harness has an
adapter (identity, launch arguments, activity files) and a store (discovery,
search text, allocation, turn markers). Session records pin the native
conversation ID and storage directory, so a session always resumes the same
conversation.

## Target state

| Data | Location |
| --- | --- |
| Session registry | `~/.outpost/registry.json` (v1 `sessions.json` tmux records are imported once) |
| tmux sockets | `~/.outpost/sockets/<session>.sock` |
| Activity checkpoints | `~/.outpost/activity/<session>.json` |
| Pasted images | `~/.outpost/clipboard/<session>/` (newest 20) |
| Signal helpers and sockets | `~/.outpost/bin/`, `~/.outpost/run/` |

Registry writes take `flock` and replace the file atomically. Records are
validated strictly; invalid data is reported, never rewritten.

## Security model

- Local mode accepts only loopback connections with loopback `Host` headers.
  Hosted mode requires HTTPS, verified accounts and same-origin requests.
- Mutating requests require `X-Outpost-Request: 1`; browser origins are
  checked; tokens are HMAC-signed with the installation secret.
- Hosted SSH uses only the account's key and known-hosts file (`-F none`, no
  agent). Connection multiplexing sockets are scoped per owner and identity.
- The connector only talks to Outpost servers you trusted when installing it;
  `outpost://` links for other servers are refused before any network access.
- Images are limited to 16 MB, signals to 32 KiB and 120 per minute per
  connection, clipboard text to 1 MiB.

## Extending Outpost

**Add a connector choice.** Add an entry to `shared/terminals.ts` and a launcher
in `connector/outpost_connector/terminals/` implementing `PLATFORMS`, `install`,
`uninstall` and `open`; register it in `terminals/__init__.py`. Reuse the OS
handler in `desktop/`. For a new OS, add its desktop handler and, if needed by
a native client, clipboard/URL adapters in `platforms.py`. Do not add another
backend connection route or broker for a new presentation of the same terminal.

**Add a coding harness.** Add an entry to `shared/harnesses.ts`, then
`runtime/outpost_<id>.py` (adapter) and `runtime/outpost_<id>_store.py`
(store), and register the adapter in `outpost_harness.py`.

**Add a signal type.** Define a validator in `shared/signals.ts`, allow it in
the broker, and handle it in both clients.

## Verification

| Layer | Tests |
| --- | --- |
| Runtime and relay | `tests/runtime/` — real tmux in a disposable home: lifecycle, framing, resize, image paste, signals, v1 import, activity semantics |
| Server | `tests/unit/` — tokens, workspace and import, API validation and network policy, hosted isolation and revocation, broker against a fake relay, TypeScript ⇄ Python contracts |
| Whole path | `tests/integration/` — local targets over WebSocket; the served connector in a PTY (paste, OSC 52, links, detach, automatic reconnect); SSH in Docker with tmux 3.2 in both modes; conversation discovery |
| Browser | `tests/browser/` — real backend: add target, create session, web terminal, native connect confirmed by a real connector, phone layout |
| Platforms | `tests/connector/` — shims and generated terminal integrations everywhere; real iTerm2 handler build and clipboards on macOS and Windows CI runners |
