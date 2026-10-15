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

`frontend/connect/useConnect.ts` owns launching and desktop handoff polling for
both explicit and remembered choices. `ConnectDialog` renders that state. Web
popups open synchronously from the user's click, including when skipping the
chooser; effects only poll an existing launch, so Strict Mode cannot launch
twice. Closing, retrying, or changing targets aborts pending requests, and late
poll results cannot replace a newer attempt.

`preference.ts` stores only an explicitly chosen terminal in browser local
storage for the current origin. Connect reads it on each click, including changes
made in other tabs. The sidebar's **Connection preferences** works in local and
hosted modes; **Ask every time** removes the choice. Missing or invalid preferences
show the chooser, storage write failures are reported without blocking connection,
and launch errors return to the chooser. This never stores credentials or skips
authentication or desktop trust confirmation.

1. The UI chooses `web` or `desktop` (`shared/terminals.ts`). The authenticated
   `POST /api/targets/:t/sessions/:s/connect` route checks ownership and issues a
   signed, single-use launch ticket valid for five minutes.
2. Web opens `/terminal?target=…&session=…`, whose authenticated page requests
   its ticket. Desktop receives `outpost://connect/<base64url payload>` with
   `{v: 2, terminal: 'desktop', server, sessionKey, token, title}`. Electron validates the
   envelope and HTTPS/localhost origin, confirms server trust, and loads
   `/terminal/desktop#token=…` from that origin.
3. Both entry pages render `TerminalView` and use `TerminalSocket` to connect
   to `/api/terminal`. The broker returns a 30-day resume token in `hello`.
   Both grants remain bound to the originating login and one session; logout
   revokes them and closes live connections. Resume tokens never appear in
   OS links or page URLs. Proxies must not log WebSocket query strings.
4. The desktop Connect dialog polls `/api/connections/:id` until attached.
   Retrying issues a fresh ticket. Electron identifies tabs by normalized server
   origin and an opaque `sessionKey`, derived from the login, target and session.
   Every Connect activates that tab; a connected tab acknowledges the new ticket
   with `activate` over its existing WebSocket. The broker verifies that the signed
   ticket matches the connection's full grant before consuming it and marking the
   handoff connected. The routing key itself never authorizes access. Disconnected
   tabs use the fresh ticket to reconnect without replacing their renderer or draft.
   There are at most 16 pending OS launches and 32 tabs.

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

`TerminalContextMenu` owns the terminal menu in both clients. On every attach,
the runtime disables tmux mouse bindings (`mouse off`), including its context
menus. It removes the prefix `<` / `>` menu and `[` / Page Up copy-mode shortcuts, and
exits an active copy-mode view. These settings apply to Outpost's isolated tmux
server without restarting the running harness.

Disabling tmux's mouse bindings leaves application mouse reporting intact:
tmux forwards the pane's requested terminal modes, and xterm handles those
standard modes. Without a mouse request, xterm selects text locally. Shift-drag
on Windows/Linux or Option-drag on macOS forces local selection when an application
requests mouse events. `attachClipboard` copies completed local mouse selections
through the same clipboard path as the context menu. It never enters a remote
mode or sends a selection gesture. Application OSC 52 copies still work.

Applications own conversation history and scrolling. Outpost exposes no tmux
history scrollbar, polling worker, seek commands, or application-specific history
bindings. It does not infer selection or scrolling capabilities from mouse
reporting or alternate-screen use. The Codex adapter resumes the conversation
without overriding `tui.alternate_screen`; native configuration and explicit
arguments determine the mode. An already-running process retains its launch
arguments until it exits and is resumed.

Because tmux attaches using the alternate screen, xterm's local buffer cannot
replace tmux's retained history. Output from before attachment and older output
in applications without a history viewer are not exposed by a generic Outpost
scrollbar. The normal xterm scrolling behavior is retained. Shared terminal CSS
hides only xterm's empty legacy `.xterm-viewport` scrollbar; its active
`.xterm-scrollable-element` keeps normal behavior.

The relay retains a bounded FIFO for typed input, composer drafts and image
pastes. Image paths are pasted through tmux after earlier PTY input is flushed.
Drafts are confirmed only after their bytes are written to the PTY; no queued
input is replayed across reconnects.

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
| → server | `activate {id, token}` | Acknowledge a fresh launch ticket for this already attached session without starting another relay |
| → server | `acknowledge {id, completionId}` | Mark the displayed native completion as seen; never acknowledge a newer completion |
| ← client | `hello {resume, session, target}` | Connection accepted |
| ← client | `ready` | Attached to tmux |
| ← client | `activity {activity}` | Native turn state using the same `SessionActivity` as the session list; invalid metadata becomes Unknown |
| ← client | `result {id, ok, message?, reference?}` | Outcome of `send` / `paste-image` / `activate` / `acknowledge` |
| ← client | `signal {type, payload}` | A remote request, e.g. `browser.open` |
| ← client | `closed {reason, message}` | `detached`, `ended`, `expired`, `outdated`, `error` |

The server pauses the transport when more than 1 MiB is unacknowledged.

**Current contracts.** Both clients send `protocolVersion` from `shared/protocol.ts`.
A mismatch returns `outdated` before redeeming the launch ticket and asks the
user to reload. Desktop loads the same frontend from its server. Changes to the
native bridge use `desktopBridgeVersion`; new native capabilities require an
app release. The desktop page shows an update error for a mismatched bridge.
The shell also detects pages that never report state after loading, so an older
server cannot silently leave the tab showing Connecting while native actions fail.
Version checks reject unsupported input; there are no protocol
translators or historical readers. Connection grants authorize an owner/login,
target and session independently of the selected UI.

### Relay protocol (broker ⇄ relay, stdio)

All session operations use one runtime upload path. The process arguments carry
only a short Python bootstrap and the byte lengths of the compressed runtime
and request. The runtime and request travel on stdin, avoiding operating-system
command-line limits (including Windows' 32,767-character limit). The bootstrap
uses exact, unbuffered reads, leaving subsequent stdin bytes for image data or
live relay frames. It creates no temporary runtime files or persistent agent.
Software inspection and installation use the separate POSIX script transport,
which can run before Python is installed.

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
| `C` | both | JSON control: `resize`, `send`, `paste-image`, `acknowledge`, `signal-result` / `ready`, `activity`, `result`, `signal`, `exit` |

Framing replaces in-band escape sequences, so typed or pasted bytes can never
be mistaken for control messages. The relay owns a PTY for `tmux attach`, so
SSH needs no PTY and window sizes travel as `resize` messages.

### tmux, configured to disappear

Each session is its own tmux server (`~/.outpost/sockets/<id>.sock`, no user
configuration) set up so it feels like the tool is running directly in your
terminal: no status bar, `escape-time 10`, application mouse reporting,
`set-clipboard on` (OSC 52 out), extended keys for Shift+Enter, truecolor,
focus events and `Ctrl+\` to detach. Connecting starts a stopped session in the same conversation.

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

### Shared session activity

`Activity.describe()` in the target runtime is the source for both the session
list and live terminal activity. Harness adapters read native turn markers;
terminal output rate, elapsed silence and local typing never infer Working or
Idle. The same baseline and acknowledgement checkpoints decide whether a
completed turn is still unchecked. Reading activity does not acknowledge it.
Actual terminal input, the list's explicit check action and the terminal's
explicit completion acknowledgement update those checkpoints. Focus-report
escape sequences and attachment itself do not advance the watermark.

`TerminalActivity` acknowledges the displayed completion on activation or a
local click/key gesture, through the existing terminal socket. Native host focus
covers tab clicks, keyboard cycling and window activation; browser focus and
visibility events use the same controller. Activation before the first observation
checks that first result only while still active. Later completions require a new
activation or interaction. Pending and confirmed completion IDs suppress stale
echoes locally; only that ID is shown as Idle, and a failed request restores the
unchecked state with a notice. A bounded set retains recent confirmations, and
connection generations discard results from an old attachment.

`outpost_activity_stream.py` samples this reader immediately after attachment
and two seconds after each completed read, with one read in flight. Its worker
starts after the PTY fork and runs separately from terminal I/O.
Only the latest result is retained, so backpressure cannot accumulate a queue
of observations. Reads that exceed five seconds show Unknown until the reader
returns; a stalled read never spawns replacement workers. The worker is a daemon,
and closing the stream stops scheduling reads without making terminal shutdown
wait for filesystem I/O. Worker startup and read failures become Unknown.
Completion acknowledgements wake the same worker immediately and reuse the list's
exact-ID check under the target's activity lock. At most 32 requests can be queued,
in flight or awaiting delivery combined. They run outside the PTY loop, refresh
the observation after saving, and return request results on the existing stream.
Only changed metadata is emitted over the existing relay and WebSocket; it
opens no additional SSH connection or account API request. Polling continues
without terminal output so completions and acknowledgements from other clients
are observed. Clients clear stale activity on close/reconnect.

`shared/activity.ts` owns the `working | idle | finished | unknown` enum,
`SessionActivity` and display labels. Unknown is an explicit observation state;
diagnostics carry details, not a second source of state. A client's `null` means
no observation has arrived on this connection yet, never a failed observation.
Both `ActivityBadge` and `tab-status.ts`
use it; the broker and native IPC use its bounded parser. The relay sends state,
timestamp, opaque completion ID and any diagnostic, never transcript content.
The desktop bridge is version 4: server and app must be updated together.
The renderer alone owns the terminal bell flag. The native shell displays reported
state and owns OS notifications, but does not independently rewrite attention on
activation or notification creation. Both a host focus transition and an explicit
focus command acknowledge the bell, including reselecting the active tab. The
preload ignores an initial host-state response if a newer focus event arrived
while that response was in flight.

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

`workspace.ts` owns all windows and a single app-wide `TerminalTabs` registry.
Each terminal ID has one owning `WorkspaceWindow`; duplicate launches and
notification clicks resolve that owner dynamically, including after a transfer.
`workspace-window.ts` owns one `BrowserWindow`, its close/reload confirmation and
local chrome. Its `TabLayout` owns ordered tab IDs, the active session, an optional
two-session split and shared pane geometry. Menus resolve the focused window.
`workspace-ui.ts` renders the tab strip, session switcher, server launcher and
settings. Its `workspace-preload.ts` bridge accepts only enumerated local UI
actions; one IPC dispatcher verifies the bundled main frame and routes each call
to that sender's window. Tab actions check ownership before changing a terminal.
`keyed-elements.ts` preserves DOM nodes in the tab strip, server list, session
switcher and error panels; metadata refreshes update their contents without
resetting keyboard focus or icon animations. The switcher retains the selected
session by ID across updates. Native host-state messages are sent only when
focus or preferences change, not on every activity refresh.
The local renderer receives tab labels, connection and activity state, attention and draft
flags, never grants, terminal bytes or draft contents.

`tab-status.ts` renders the same status icons and text in tabs and the session
switcher. Connecting/reconnecting and disconnected states take priority. Connected
tabs show a blue spinner for Working, a gray clock for Idle, a ringing bell for
Needs you (`finished`), or a question mark for Unknown. An unread terminal bell
takes priority over activity. The green connection check remains while waiting
for the first activity observation. Hover descriptions and accessible tab names
include connection, activity and bell state. Animations respect reduced motion;
ordinary state updates keep the existing icon node so they do not restart them.
Activating the session dismisses terminal-bell attention through the existing
bell/focus path; unchecked completion follows the shared activity checkpoints.

Activation applies view visibility before restoring or focusing the native window.
Native focus events may select another visible split pane, but cannot override an
activation in progress or reactivate a view already hidden by the current layout.

`tab-shortcuts.ts` reserves Ctrl+Tab and Ctrl+Shift+Tab in Electron's
`before-input-event` for both the workspace and terminal web contents. It prevents
renderer delivery and the duplicate menu accelerator, then uses the existing
`TabLayout.cycle` order and activation path. Terminal callbacks resolve the
current owner after cancelling provisional drags, so shortcuts follow moved tabs
without adding renderer IPC or keeping a second tab order.

`tab-drag-ui.ts` starts a drag after an eight-pixel threshold, transferring pointer
capture from the tab button to the stable strip so removing a tab node cannot
cancel the gesture. `tab-drag.ts` owns one drag across the app and resolves drop
positions from native DIP cursor coordinates and each chrome's measured geometry.
A 32 ms timer runs only during a drag, including while edge scrolling. Hit testing
respects the temporary stacking order of the raised hover destination and never
drops through an overlapping Outpost window. Holding the pointer over the inserted
tab retains its position, so changing flex widths cannot cause a reorder loop.

Hovering over another tab bar provisionally transfers the **live** terminal using
`tab-transfer.ts`, the same ownership/reparenting path used for permanent moves.
It saves both `TabLayout` snapshots first. The destination selects the incoming
tab and displays its live view; an empty source becomes transparent using native
window opacity. The source is kept open and focused so it retains mouse-up and
Escape; `hide()` would discard that capture. The destination is raised without
taking focus. Leaving its strip restores both layouts, including split panes,
selection and panels. Release commits the provisional move without a second
reparent. Escape, capture loss, blur, renderer failure, tab disposal or closing
either participating window restore it. Menu and launch actions cancel before
resolving ownership. No grant or terminal data enters drag payloads.

Outside tab bars, `tab-drag-preview.ts` shows a noninteractive native label. It
always supplies a fixed width and height when moving and disables Windows resize
insets. No native move occurs for a stationary pointer, and no read-back window
dimensions feed the next update. Asynchronous loading cannot reshow a hidden or
destroyed preview.

A release inside the source strip reorders; an outside drop creates a window.
A lone tab instead moves its existing window. Transfers never reload, reconnect
or consume another ticket. Failed attachment restores both layouts. Moving the
last tab into another window closes the empty source only after the move commits.
A source split collapses to its remaining session. New window bounds are clamped
to the destination display's work area. The renderer, connection, terminal buffer
and draft stay alive.

The tab strip replaces the system title bar using Electron's
`titleBarStyle: 'hidden'` and [Window Controls Overlay](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar#custom-window-controls).
Native window controls share the same
36-pixel `tabBarHeight` as the HTML strip, terminal view offset, drag hit testing
and fixed-size floating tab preview. CSS uses the overlay's
safe-area geometry to reserve space for OS buttons, including RTL placement;
the overlay visibility event releases this space in fullscreen. Only the local
header has a window drag region. Its tab scroller and buttons opt out, and a
flexible spacer always leaves room to drag the window with a full tab strip.
Window close, minimize, maximize and fullscreen remain native operations.

Terminal views and workspace panels fill the remaining height to the bottom of
the window. Connection state lives in the tabs; there is no persistent status
bar. Workspace action errors use a native dialog owned by the calling window,
with at most one open per window. This remains visible above native terminal
views without reserving space. Drag destinations use their existing insertion
markers, tab highlight and live terminal preview.

`terminals.ts` owns each session's sandboxed `WebContentsView` and native bridge.
Views use nonpersistent sessions partitioned by server origin. Switching tabs
only changes visibility; hidden views retain their size and keep processing
output and acknowledgements. A split displays two existing views and changes
their bounds. Moving/reordering tabs never redeems another grant. There is a
32-tab limit across at most 16 workspace windows. Closing a tab explicitly destroys
its web contents; closing a window destroys only the views it still owns. Quit
confirmation covers tabs and drafts across all windows. Renderer failures are
shown per tab and do not reset the workspace or other sessions.

Fresh launches for an existing tab wait in a bounded, in-memory queue until its
renderer handles them. The preload subscribes before reading pending launches;
only an explicit acknowledgement removes one, so loading and StrictMode cleanup
do not lose a handoff. Exact repeats of the most recent OS link are ignored.

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
copies), and display changes to `TerminalView`.
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
and `second-instance`. A single app instance owns all workspaces; subsequent
launches focus an existing tab or add one to the active window. Closing a tab or window never terminates tmux. The server
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
