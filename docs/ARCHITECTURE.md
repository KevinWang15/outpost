# Outpost architecture

Outpost keeps AI coding sessions (Claude Code, Codex, Kimi Code) running in tmux
on Linux machines, and lets you return to them from a browser or from Outpost Desktop as if the session were running on your computer.

This document is the source of truth for how Outpost behaves and why. Code
comments refer back to the principles below by name.

## Principles

1. **tmux is the only terminal state.** A coding session is a dedicated tmux
   server on its target. Every connection is disposable: connecting means
   attaching, reconnecting means attaching again, and tmux redraws the screen.
   Outpost never holds PTYs, screen snapshots or replay buffers.
2. **One connection path.** Every terminal — browser or Electron —
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
   Electron owns a narrow native capability bridge; renderer and connection
   code stay in the shared frontend.
6. **Explicit gestures only.** The local clipboard is read only on a paste
   gesture, never polled. Remote programs can copy to your clipboard (OSC 52)
   and ask to open `http(s)` links, but can never read your clipboard.
7. **Extensible at the edges, small in the middle.** Desktop capabilities, coding
   harnesses, signal types and transports are registries or interfaces. The
   data path between them stays a dumb, well-specified pipe.

## Components

```text
                 ┌──────────── your computer ────────────┐
  Browser UI ────┤ web / Outpost Desktop (same xterm.js)  │
                 │ Electron: OS links, clipboard, bells  │
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
| `desktop/` | Your computer | Electron shell, native capabilities, trusted servers and installers |
| `shared/` | Browser + desktop + server | Schemas, harness registry, terminal protocol, desktop bridge contract |

**One definition per contract.** Request and stored-record shapes are TypeBox
schemas in `shared/schemas.ts`; the server validates with them and the types in
`shared/model.ts` are derived from them. Contracts that also exist in Python —
the harness registry and relay framing — are checked against
each other by `tests/unit/contracts.test.ts`. Browser entry paths live in
`shared/pages.ts`, shared by navigation and the production SPA fallback. A new
browser page must be registered there so development and production agree.

## Supported platforms

| Role | Supported |
| --- | --- |
| Targets (where sessions run) | Linux with Bash, Python 3.9+ and tmux 3.2+. SSH as root, or the Outpost computer itself when the server runs on Linux (including WSL). |
| Outpost server | Node.js 24+ with OpenSSH, on Linux (including WSL) or macOS. Hosted deployments run on Linux. |
| Web terminal | Any current browser, including phones. |
| Outpost Desktop | Packaged Electron for macOS arm64/x64 and Windows x64. No Python, WSL or installed browser required. |

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

1. The UI chooses `web` or `desktop` (`shared/terminals.ts`). The authenticated
   `POST /api/targets/:t/sessions/:s/connect` route checks ownership and issues a
   signed, single-use launch ticket valid for five minutes.
2. Web opens `/terminal?target=…&session=…`, whose authenticated page requests
   its ticket. Desktop receives `outpost://connect/<base64url payload>` with
   `{v: 1, terminal: 'desktop', server, token, title}`. Electron validates the
   envelope and HTTPS/localhost origin, confirms server trust, and loads
   `/terminal/desktop#token=…` from that origin.
3. Both entry pages render `TerminalView` and use `TerminalSocket` to connect
   to `/api/terminal`. The broker returns a 30-day resume token in `hello`.
   Both grants remain bound to the originating login and one session; logout
   revokes them and closes live connections. Resume tokens never appear in
   OS links or page URLs. Proxies must not log WebSocket query strings.
4. The desktop Connect dialog polls `/api/connections/:id` until attached.
   Retrying issues a fresh ticket. Electron deduplicates repeated launches of
   the same ticket and limits windows and pending launches to 16 each.

### Client choices and shared responsibilities

| Choice | Entry | Authorization | Native integration |
| --- | --- | --- | --- |
| Web terminal | `TerminalPage`, `/terminal` | Browser login requests a grant | Browser permissions and clipboard APIs |
| Outpost Desktop | `DesktopTerminalPage`, `/terminal/desktop` | `desktopTicket` consumes the launch fragment | Versioned `DesktopBridge` through a sandboxed preload |

`/terminal/desktop` and `/desktop` (downloads) are public page shells. The terminal
broker authorizes each connection; these pages confer no account API access.
Desktop needs no copied login cookie or second authentication system.

`desktopTicket` erases the fragment before React renders, replaces the launch ticket
with the resume grant on `hello`, and clears it on explicit Close or expiry.
Window-scoped session storage permits reloads. Electron uses nonpersistent
partitions per server, so no browser login or terminal ticket is written to
its preferences. If session storage is unavailable, reconnect works in memory
but reload requires a fresh Connect.

Toolbar visibility is a UI preference in the shared `TerminalView`; resizing
uses its existing observer and never opens another connection. Keyboard,
clipboard, composer, links, bells and notifications have one web implementation.

`ScrollbackBar` displays tmux's history position, not xterm's local buffer:
tmux uses the alternate screen, so xterm's scrollbar cannot reach that history.
Shared terminal CSS suppresses the native scrollbar on xterm's empty legacy
`.xterm-viewport` layer; the active `.xterm-scrollable-element` keeps its normal
behavior. This prevents a stray Windows scrollbar arrow beside `ScrollbackBar`.
On `ready`, both clients subscribe with a `scrollback` control message over
the existing socket. History support is part of the current protocol. Only metadata
(line count, offset, rows and copy-mode availability) returns to the browser. The
target's `Scrollback` adapter uses tmux `copy-mode`, `goto-line` and `cancel`;
tmux redraws through the usual PTY stream. Seeking the bottom exits copy mode.
The target requires tmux 3.2+.

Metadata reads are triggered by input/output/resize, capped at two per second
and skipped when idle. Drag destinations are coalesced, capped at ten per
second in the relay, and executed by one background worker with command
timeouts. A bounded FIFO orders seeks, input, composer drafts and image pastes.
Metadata reads do not block typing; a seek holds subsequent input until tmux
confirms the mode change. Only adjacent seeks can coalesce, preserving input
between them. Each seek receives fresh metadata followed by a
`result`, including when its position did not change. Failed seeks reject queued
requests and discard buffered typing with a visible error, instead of sending
it into an uncertain pane mode. Drafts are confirmed only after their bytes are
written to the PTY. No queued input is replayed across reconnects. Copy-mode
history size is remembered on older tmux releases which do not expose the snapshot's
size; newer releases expose it directly. This stores no terminal content.
The scrollbar follows the pane's shared copy mode, including mouse-wheel
changes and changes made by other attached clients. The runtime also reports
`alternate_on`: an application's alternate-screen transcript is not tmux
history. Such screens do not display a draggable thumb or a made-up extent.

The Codex adapter defaults `tui.alternate_screen` to `never`, preserving output
in tmux's normal history. This is a per-launch CLI configuration override, not
a change to the user's Codex config; an explicit later `-c` can override it.
For full-screen Codex the runtime advertises the adapter's `history_navigation`
capability (label, help, and bindings for oldest/pageUp/pageDown/latest).
The broker validates this against
`shared/schemas.ts`; it contains no harness-specific dispatch. The shared
`TerminalHistory` controller uses those bindings for both the sidebar and
Shift+Page Up/Down. Codex supplies Page Up/Down and Ctrl+Home/End; additional
harnesses can supply their own bindings without changing the broker or views.
Copy mode still takes precedence when explicitly entered.
These controls expose no invented history length.

`useBellNotifications` manages browser permission requests, with an eight-second
busy timeout and permission refresh on focus. Desktop uses the bridge's native
notification capability; no browser permission prompt is involved. The shell
rechecks that the window is in the background, groups pending notifications,
and focuses the owning window when clicked. System Focus / Do Not Disturb
and notification settings still apply. Shared `bell.ts` owns attention state
and the chime; the native notification is silent to avoid duplicate sound.

Both clients load xterm's WebGL addon after opening the terminal. Initialization
failure or context loss disposes the addon and falls back to the DOM renderer.
Terminal parsing and broker flow control do not depend on the renderer. Output
acknowledgements are batched at 64 KiB or 20 ms, at most every 10 ms, after
xterm's write callback;
callbacks from an old connection cannot acknowledge a new socket's output.

### Terminal protocol (client ⇄ broker, WebSocket)

Binary frames carry raw terminal bytes in both directions. Text frames carry
JSON control messages (`shared/protocol.ts`):

| Direction | Message | Meaning |
| --- | --- | --- |
| → server | `resize {cols, rows}` | Client geometry |
| → server | `ack {bytes}` | Output rendered; flow control |
| → server | `send {id, data}` | Input that must be confirmed (composer drafts) |
| → server | `paste-image {id, mediaType, data}` | Upload an image and paste its path |
| → server | `scrollback {offset?, id?}` | Without fields, subscribe to history metadata; with both `offset` and `id`, seek from the bottom (`0` = live, `-1` = oldest) |
| ← client | `hello {resume, session, target}` | Connection accepted |
| ← client | `ready` | Attached to tmux; subscribe to history metadata |
| ← client | `scrollback {available, lines, offset, rows, active, alternate, navigation?}` | History extent, position, copy mode, and whether the application owns scrolling |
| ← client | `result {id, ok, message?, reference?}` | Outcome of `send` / `paste-image` / a scrollback seek |
| ← client | `signal {type, payload}` | A remote request, e.g. `browser.open` |
| ← client | `closed {reason, message}` | `detached`, `ended`, `expired`, `outdated`, `error` |

The server pauses the transport when more than 1 MiB is unacknowledged.

**Current contracts.** Both clients send `protocolVersion` from `shared/protocol.ts`.
A mismatch returns `outdated` before redeeming the launch ticket and asks the
user to reload. Desktop loads the same frontend from its server. Changes to the
native bridge use `desktopBridgeVersion`; new native capabilities require an
app release. Version checks reject unsupported input; there are no protocol
translators or historical readers. Connection grants authorize an owner/login,
target and session independently of the selected UI.

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
| `C` | both | JSON control: `resize`, `send`, `paste-image`, `scrollback`, `signal-result` / `ready`, `result`, `scrollback`, `signal`, `exit` |

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

**Creation and forking** share a process-owned `creation.lock`, serializing
allocations without blocking operations on existing sessions. Lock order is
creation → registry; other operations never take the creation lock. The
registry lock is held only to snapshot settings and to commit a new record;
Git and harness allocation run outside it. Registration re-reads the latest
registry and rechecks unique names and conversation identities, preserving
concurrent deletes and attachment timestamps. A failed process releases the
allocation lock automatically, with no persistent reservations to recover.
Forking uses a snapshot of the source settings, so deleting the source record
during allocation does not cancel an already-started fork.

The runtime creates a new branch from the source directory’s `HEAD` with
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

## Desktop shell and OS integration

`desktop/` is a separate npm package, so server builds never download Electron.
`main.ts` owns app lifecycle, menus, server trust and `outpost://` dispatch.
`launch.ts` validates the envelope; `store.ts` atomically serializes trusted
origins, and `preferences.ts` serializes font size and bell sound only.

One `BrowserWindow` hosts local workspace chrome. `workspace.ts` owns it, tab
activation and close/reload confirmation. `layout.ts` owns ordered tab IDs,
the active session, an optional two-session split and shared pane geometry.
`workspace-ui.ts` renders the tab strip, session switcher, server launcher and
settings. Its `workspace-preload.ts` bridge accepts only enumerated local UI
actions; the main process verifies that calls came from its bundled main frame.
The local renderer receives tab labels, connection state, attention and draft
flags, never grants, terminal bytes or draft contents.

The tab strip replaces the system title bar using Electron's
`titleBarStyle: 'hidden'` and [Window Controls Overlay](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar#custom-window-controls).
Native window controls share the same
`tabBarHeight` as the HTML strip and terminal view offset. CSS uses the overlay's
safe-area geometry to reserve space for OS buttons, including RTL placement;
the overlay visibility event releases this space in fullscreen. Only the local
header has a window drag region. Its tab scroller and buttons opt out, and a
flexible spacer always leaves room to drag the window with a full tab strip.
Window close, minimize, maximize and fullscreen remain native operations.

`terminals.ts` owns each session's sandboxed `WebContentsView` and native bridge.
Views use nonpersistent sessions partitioned by server origin. Switching tabs
only changes visibility; hidden views retain their size and keep processing
output and acknowledgements. A split displays two existing views and changes
their bounds. Moving/reordering tabs never redeems another grant. There is a
32-tab limit. Closing a tab explicitly destroys its web contents; child views
are also closed when the owning window is destroyed. Renderer failures are
shown per tab and do not reset the workspace or other sessions.

Remote views use sandboxing, context isolation, no Node integration, no
webviews and no popups/downloads. Top-level navigation is restricted to the
selected server's desktop terminal entry; TLS failures are not bypassed.
Clipboard reads use native paste events. The paste bridge checks transient user
activation in its isolated preload; web clipboard permissions are denied.
Only that view's main frame may invoke the bridge. External links pass the
same HTTP(S), no-credentials validator as broker signals and open through
Electron's shell API, without constructing shell commands. Clipboard copying
requires the active, focused view and is bounded to 1 MiB. OSC 52 queries remain ignored.

`TerminalContextMenu` is shared by browser and desktop terminals. It delegates
clipboard actions to `attachClipboard` (including image paste and pending OSC 52
copies), history to `TerminalHistory`, and display changes to `TerminalView`.
The same clipboard controller maps macOS Ctrl+V to its explicit paste action;
native paste shortcuts continue to use clipboard events. The alias runs only
on a non-repeated keydown, within the user's clipboard permission gesture.
Right-click and keyboard menu gestures stay local; opening the menu preserves
the xterm selection. Radix handles menu navigation, dismissal and viewport
positioning. The desktop native context menu is only for editable fields such
as the message composer; there is no separate native list of terminal actions.

The versioned bridge reports session metadata and receives focus, preferences
and explicit terminal commands. Native focus is authoritative for bells, so a
hidden tab can notify even while another tab is focused. Notification clicks
activate the owning tab and restore the window. The frontend never infers tab
focus from the BrowserWindow alone. Font size is applied to xterm and refitted
through the existing resize path, without page zoom or reconnecting. The message
composer keeps its draft while hidden; only a Boolean draft flag reaches the
main process for close/reload/quit confirmation. Terminal input already sent to
the remote harness is not inspected for drafts.

Packaged apps register the protocol through Electron and installer metadata.
macOS handles `open-url` before app readiness; Windows uses initial arguments
and `second-instance`. A single app instance owns the workspace; subsequent
launches add tabs. Closing a tab or window never terminates tmux. The server
launcher can forget a server and close its tabs. No connection tickets or
layouts with credentials are persisted; reopening the app starts a fresh
workspace. The app icon and Windows AppUserModelID belong to Outpost.

`electron-builder.yml` packages unsigned preview DMG/ZIP files for both Mac
architectures and an NSIS installer for Windows x64. Apple silicon uses ad-hoc
signing, without Developer ID or notarization. All packaging workflows are
manual; no build runs on push. `updates.ts` checks GitHub desktop releases only
when asked and opens a newer release for manual installation. There is no
background updater for these previews. See [desktop development](../CONTRIBUTING.md).

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
| Session registry | `~/.outpost/registry.json` |
| tmux sockets | `~/.outpost/sockets/<session>.sock` |
| Activity checkpoints | `~/.outpost/activity/<session>.json` |
| Pasted images | `~/.outpost/clipboard/<session>/` (newest 20) |
| Signal helpers and sockets | `~/.outpost/bin/`, `~/.outpost/run/` |

Registry writes take `flock` and replace the file atomically. Records are
validated strictly; invalid data is reported, never rewritten. Outpost reads
only its current workspace and registry schemas. A missing current file starts
an empty store; there is no automatic import of earlier layouts.

## Security model

- Local mode accepts only loopback connections with loopback `Host` headers.
  Hosted mode requires HTTPS, verified accounts and same-origin requests.
- Mutating requests require `X-Outpost-Request: 1`; browser origins are
  checked; tokens are HMAC-signed with the installation secret.
- Hosted SSH uses only the account's key and known-hosts file (`-F none`, no
  agent). Connection multiplexing sockets are scoped per owner and identity.
- Desktop confirms unknown server origins before loading their UI. Trust is
  explicit and revocable from app home; only HTTPS and localhost HTTP qualify.
- Images are limited to 16 MB, signals to 32 KiB and 120 per minute per
  connection, clipboard text to 1 MiB.

## Extending Outpost

**Add a desktop capability.** Define its narrow contract in `shared/desktop.ts`,
expose one method in the preload and validate the sender and all arguments in
the main process. Keep terminal behavior in the frontend; do not create another
broker, authentication scheme or desktop copy of `TerminalView`.

**Add a coding harness.** Add an entry to `shared/harnesses.ts`, then
`runtime/outpost_<id>.py` (adapter) and `runtime/outpost_<id>_store.py`
(store), and register the adapter in `outpost_harness.py`.

**Add a signal type.** Define a validator in `shared/signals.ts`, allow it in
the broker, and handle it in the shared client, delegating native actions through the bridge.

## Verification

| Layer | Tests |
| --- | --- |
| Runtime and relay | `tests/runtime/` — real tmux in a disposable home: lifecycle, framing, resize, image paste, signals, activity semantics |
| Server | `tests/unit/` — tokens, workspace, API validation and network policy, hosted isolation and revocation, broker against a fake relay, TypeScript ⇄ Python contracts |
| Whole path | `tests/integration/` — local targets over WebSocket; SSH in Docker with tmux 3.2 in both modes; conversation discovery |
| Browser | `tests/browser/` — real backend: add target, create session, web terminal, desktop ticket flow, phone layout |
| Desktop packaging | Manual `desktop.yml` workflow builds macOS arm64/x64 and Windows x64 installers; OS integration still needs native manual verification |
