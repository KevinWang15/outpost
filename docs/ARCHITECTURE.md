# Outpost architecture

Outpost keeps AI coding sessions (Claude Code, Codex, Kimi Code) running in persistent PTYs
on Linux machines, and lets you return to them from a browser or from Outpost Desktop as if the session were running on your computer.

This document is the source of truth for how Outpost behaves and why. Code
comments refer back to the principles below by name.

## Principles

1. **The target owns the terminal.** A dedicated `outpost-terminal` process
   owns each coding session's PTY, screen and 10,000-line in-memory scrollback.
   Clients and relays are disposable. Reconnect restores a checkpoint and then
   follows live output; disconnect never terminates the session.
2. **One managed connection path.** Every managed Outpost terminal — browser or Electron —
   uses the same chain:

   ```text
   client ⇄ WebSocket ⇄ Outpost broker ⇄ transport (SSH or local shell) ⇄ relay ⇄ terminal service ⇄ PTY
   ```

   Hosted and local server installations run the same code. Desktop local shells
   use a native PTY on the user's computer; they have no broker, authentication,
   remote dependency, or persistence daemon. Both use the same terminal UI.
3. **Modes differ only in identity.** A *deployment* answers four questions:
   who owns this request, where is their workspace stored, which SSH identity
   do they use, and may they use this computer as a target. Everything else —
   sessions, software, terminals, the UI — is mode-agnostic.
4. **One installed target dependency.** Required Software installs a versioned,
   self-contained Linux executable in `~/.outpost/bin`. Python management code
   is still sent with each operation. The terminal service opens only a private
   Unix socket and runs as the execution user; no network daemon or system-wide
   service is needed.
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
                 │  terminal service per session · harness    │
                 └───────────────────────────────────────┘
```

| Directory | Runs on | Role |
| --- | --- | --- |
| `frontend/` | Browser | Workspace UI, Connect dialog, web terminal client |
| `backend/` | Outpost server | HTTP API, deployments, transports, terminal broker |
| `terminal-service/` | Linux target | Self-contained persistent PTY executable, headless xterm engine |
| `runtime/` | Targets | Session registry, service control, relay, harness adapters |
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
| Targets (where sessions run) | Linux with Bash, Python 3.9+ and Outpost Terminal. SSH as root, or the Outpost computer itself when the server runs on Linux (including WSL). |
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
twice. An installed standalone web app navigates to the terminal in its current
window, retaining its Home Screen context. Closing, retrying, or changing targets aborts pending requests, and late
poll results cannot replace a newer attempt.

Remembered launches keep their request and desktop handoff state in the hook
without mounting a dialog. Successful handoffs clear silently. Launch errors
reopen the chooser; a separate six-second timer reveals progress and recovery
actions for a stalled request or handoff, even when a status poll is blocked on
the network. Explicit choices keep the usual progress and success dialog.

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
   `/terminal/desktop` from that origin. The validated tab receives its credential
   through the preload's `ticket()` call, without putting it in the page URL.
3. Both entry pages render `TerminalView` and use `TerminalSocket` to connect
   to `/api/terminal`. The broker returns a 30-day resume token in `hello`.
   Both grants remain bound to the originating login and one session; logout
   revokes them and closes live connections. Resume tokens never appear in
   OS links or page URLs. Proxies must not log WebSocket query strings.
4. The connection hook polls `/api/connections/:id` until desktop is attached,
   including when the dialog is skipped for a remembered choice.
   Retrying issues a fresh ticket. Electron identifies tabs by normalized server
   origin and an opaque `sessionKey`, derived from the login, target and session.
   Every Connect activates that tab; a connected tab acknowledges the new ticket
   with `activate` over its existing WebSocket. The broker verifies that the signed
   ticket matches the connection's full grant before consuming it and marking the
   handoff connected. The routing key itself never authorizes access. Disconnected
   tabs use the fresh ticket to reconnect without replacing their renderer or draft.
   There are at most 16 pending OS launches and 32 terminal panes.

### Client choices and shared responsibilities

| Choice | Entry | Authorization | Native integration |
| --- | --- | --- | --- |
| Web terminal | `TerminalPage`, `/terminal` | Browser login requests a grant | Browser permissions and clipboard APIs |
| Outpost Desktop | `DesktopTerminalPage`, `/terminal/desktop` | The owning native tab supplies its launch or resume credential through `DesktopBridge.ticket()` | Versioned `DesktopBridge` through a sandboxed preload |

`/terminal/desktop` and `/desktop` (downloads) are public page shells. The terminal
broker authorizes each connection; these pages confer no account API access.
Desktop needs no copied login cookie or second authentication system.

Native tabs keep their current credential in the main process. On `hello`,
`DesktopTerminalPage` uses `saveResume()` to replace it with the reusable grant
and remember the session. Reload requests the current credential again. A fresh
launch routed to an already connected tab must not replace its resume credential
with the single-use ticket consumed by `activate`.

The desktop entry requires the current preload bridge. Opening it in an ordinary
browser shows launch instructions; URL fragments and browser storage are never
credential sources. Browser sessions use the authenticated `/terminal` entry.
Electron uses nonpersistent partitions per server; no account cookies or passwords
are copied into the app.

Toolbar visibility is a UI preference in the shared `TerminalView`; resizing
uses its existing observer and never opens another connection. Keyboard,
clipboard, composer, links, bells and notifications have one web implementation.
`terminal/session.ts` owns the emulator, connection, input handlers, host events
and resource cleanup for one mounted terminal. `TerminalView` owns React state,
drafts and presentation. Subscriptions are paired with cleanup when acquired and
released in reverse order, including after partial initialization; late async
results cannot update a disposed session. A title or callback update does not
recreate the connection. A failed initialization can be retried explicitly.
Transient status messages, message-send errors, session link prompts, and bell alerts share an
absolutely positioned notice stack inside the terminal body. The stack is bounded
and scrolls independently on small screens. Showing, updating, or dismissing a
notice cannot change the terminal surface dimensions or trigger a PTY resize.
The resize observer still handles window/pane size, mobile keyboard, font-size,
and explicit terminal-control layout changes.
The terminal surface has its own stacking context beneath notices and the closed
screen, containing xterm's internal canvas, input-helper, and scrollbar layers.
While the closed screen is shown, the surface is inert so it cannot capture mouse,
touch, or keyboard input. Recovery receives focus when the terminal had it;
desktop activation preserves focused UI controls and otherwise selects a recovery
button instead of the inactive terminal.

`TerminalContextMenu` owns the terminal menu in both clients. Application mouse
modes pass through to xterm without a multiplexer interpreting clicks.
Without a mouse request, xterm selects text locally. Shift-drag
on Windows/Linux or Option-drag on macOS forces local selection when an application
requests mouse events. `attachClipboard` copies completed local mouse selections
through the same clipboard path as the context menu. It never enters a remote
mode or sends a selection gesture. Application OSC 52 copies still work.

The service and renderer use xterm's normal and alternate buffers. The normal
buffer retains 10,000 scrollback rows; the alternate buffer has no scrollback.
Screen erase and scrollback erase remain separate operations. Reconnecting
restores both buffers, including normal-buffer history behind an active
alternate screen. The renderer's actual xterm scrollbar browses those rows,
without a remote copy mode or an application-specific scrolling heuristic.
Full-screen applications own any history not represented by terminal scrollback.
The Codex adapter does not override `tui.alternate_screen`.

Shared CSS hides only xterm's empty legacy `.xterm-viewport` scrollbar; its active
`.xterm-scrollable-element` keeps normal behavior. Local selection/copying never
pauses the service or changes the harness's terminal mode.

`viewport.ts` follows the visual viewport's size and offset using coalesced
animation frames. `terminal/geometry.ts` observes the container and xterm screen,
including keyboard open/close, rotation, cell-metric changes and renderer fallback.
Display-scaling changes, font loading and tab activation also remeasure and
refresh the screen. Hidden views retain their last valid dimensions. Resize
requests are coalesced per animation frame, including during continuous window
dragging and font-size key repeat. Only ordered geometry from the connection
resizes the buffer; measuring never races live output. The socket deduplicates the last requested dimensions,
not the last rendered dimensions, so an in-flight acknowledgement cannot swallow
a resize back to the original size. Readiness sends the latest dimensions after
checkpoint restoration. During pinch
zoom it preserves the last unzoomed layout instead of reflowing terminal text.
Touch controls use larger targets and 16px form text, and the composer stays
focused while a send is pending. Floating notices remain visible and dismissible
on narrow screens, and leave the toolbar toggle reachable when the toolbar is hidden.

`touch.ts` maps a single-finger vertical swipe to xterm's existing wheel handler;
it owns that touch gesture to avoid also scrolling xterm's local viewport.
Multi-touch remains available for browser zoom. It does not inspect the harness
or synthesize remote history commands. `TerminalTextDialog` offers native browser selection
of a bounded snapshot of the visible xterm rows, joining wrapped lines. Opening
it sends no PTY input and the live terminal continues rendering behind it. This
is a clipboard aid, not retained history; the snapshot is discarded on close.

The relay retains a bounded FIFO for typed input, composer drafts and pasted
references. The service wraps a paste in bracketed-paste delimiters only when
the application requested that mode. Image bytes never enter this FIFO.
Drafts are confirmed only after the terminal service accepts their bytes into its PTY write queue; no queued
input is replayed across reconnects.
The browser and broker each cap queued transport input at 2 MiB. The broker's `BoundedWriter` stops writing when the SSH pipe
applies backpressure, resumes on drain, and fails after 30 seconds without drain.
Overflow closes the attachment with an explicit error and discards queued input.
Binary input, composer drafts and pasted references share the 1 MiB/s input
budget. These are transport bounds;
Bun's PTY write API accepts bytes into its own internal queue and does not expose
its buffered byte count.

Image paste, image file drops and the terminal's image picker all call
`TerminalSession.pasteImage(File)`. `shared/images.ts` owns the supported formats,
16 MiB limit and saved-image response. The workspace has no separate upload
control. Progress and success notices remain overlays and never resize xterm.

For remote sessions, `TerminalSocket` POSTs raw bytes to `/api/terminal/image`,
using its existing session-scoped resume token in the Authorization header.
The route accepts resume tokens only and checks the originating login before
buffering the bounded body. Launch tickets and workspace cookies cannot authorize
an upload. Both web and desktop terminals use this same endpoint. `SessionClient`
passes the bytes over the existing runtime-operation stdin transport, without
Base64. The runtime reads a bounded body outside the registry lock, atomically
saves the image, and returns its harness-specific reference; it sends no PTY input.

The client then sends `paste {id, data}` on the original terminal connection and
waits for acknowledgement. Disconnect cancels the HTTP request; a reconnect
cannot receive an old upload's paste. One image is processed at a time per terminal.
Neither uploads nor paste requests are automatically retried, and no Enter is
appended. Failed/cancelled transfers can leave saved files but never submit a
prompt; the existing newest-20 retention bounds remote clipboard storage.
Local shells save raw bytes through their private desktop IPC, then paste the
quoted local/WSL path with the owning shell generation checked before insertion.

`TerminalSocket` owns recovery for both web and desktop remote terminals. Every
15 seconds after readiness or a successful health check, it sends an authenticated
`ping` through the broker and relay to the terminal service. The service replies
without writing bytes to the coding process. A missing reply after 30 seconds
replaces the attachment, including when an idle socket still claims to be OPEN.
Returning to a visible page, browser focus, `pageshow`, or `online` checks it
immediately with a shorter 5-second deadline. Desktop forwards Electron's system
resume and screen-unlock events to **all** remote tabs, including hidden tabs and
minimized windows. Local shell PTYs are left running. An in-flight probe is shared
across these events; wake can shorten its deadline but never extend it.

Transient transport failures retry indefinitely with jittered exponential backoff,
capped at 30 seconds. The backoff resets after 30 seconds connected and a successful
service probe. An OS offline hint pauses background retries, without tearing down
a working connection (loopback/LAN may still work). Returning online or to the
terminal skips the backoff. Wake replaces stale handshakes while preserving ones
still receiving data. Fresh attachments otherwise have a 60-second server and
75-second client deadline, including checkpoint rendering. Closing or replacing an
attachment disposes its timers, pending requests and uploads; failure handling
does not wait for a WebSocket close handshake. Temporary connection-slot exhaustion
is retryable with a resume grant, allowing old network connections time to expire.

Recovery reuses the session-scoped resume grant and restores the current screen
and scrollback checkpoint into the same terminal, with its latest size and focus.
The coding process keeps running and composer drafts stay in the page. Input,
submissions, and image pastes are **never replayed**; a missing delivery confirmation
asks the user to check before retrying. Ended, expired, outdated, setup-error,
renderer-error, and input-congested connections still require explicit action.
This cannot recover an expired/revoked credential or a machine that lost the remote
PTY automatically. Initial connections and explicit Reconnect include `start=1`;
automatic attachments use `start=0`. The target checks that intent under the registry
lock, so a process that exited while the client was offline is reported as ended,
even when its original exit event never reached the client. A single-use launch lost before the client receives its first resume grant
requires a fresh Connect from Outpost. Browser/OS suspension delays JavaScript;
recovery begins when the page can run again.

The broker independently probes the remote service every 15 seconds, suspending
its deadline while renderer backpressure deliberately pauses stdout. A viewer
that sends no rendering acknowledgements for 60 seconds while output is paused
is disconnected for resynchronization. WebSocket ping/pong detects lost clients.

`useBellNotifications` manages browser permission requests, with an eight-second
busy timeout and permission refresh on focus. Desktop uses the bridge's native
notification capability; no browser permission prompt is involved. The shell
rechecks that the window is in the background, groups pending notifications,
and focuses the owning window when clicked. System Focus / Do Not Disturb
and notification settings still apply. Shared `bell.ts` owns attention state
and the chime; the native notification is silent to avoid duplicate sound.

Browser alerts use `notificationTransport.ts` and a notification-only service
worker (`public/terminal-notifications.js`, scope `/terminal`). Registration and
activation have deadlines; failures leave a retryable notice. The worker has no
fetch handler, cache, background session, or Push subscription. Notification
clicks focus the matching web terminal or open its normal authenticated page;
data contains only target/session identifiers, never launch/resume credentials.
Pending notifications are cancelled by generation on acknowledgement/disposal,
and an old notification's cleanup cannot close a newer notification with the same
session tag. Browsers without service workers retain the page Notification path.
The manifest supports Home Screen launch; iOS outside that context gets actionable
setup instructions instead of an unusable permission prompt. Permission is
labelled as allowed, not as a promise of background delivery: suspended pages
cannot receive live bells, and server-side Web Push is not implemented.

Both clients load xterm's WebGL addon after opening the terminal. Initialization
failure or context loss disposes the addon and falls back to the DOM renderer.
Terminal parsing and broker flow control do not depend on the renderer. Output
acknowledgements are batched at 64 KiB or 20 ms, at most every 10 ms, after
xterm's write callback;
callbacks from an old connection cannot acknowledge a new socket's output.
Adjacent output awaiting a write is combined in batches up to 128 KiB, without
crossing checkpoint, geometry or readiness barriers. This avoids scheduling an
xterm write for each tiny network frame during a burst. A single larger source
frame remains intact; xterm's parser still yields according to its own budget.

`terminal/links.ts` owns OSC 8 hyperlinks and detected HTTP(S) URLs for both
clients. OSC 8 activation confirms the actual destination before invoking the
shared browser opener; cancellation invokes no opener and creates no retry notice.
When application mouse reporting is active, a link's press and drag stay local
instead of also reaching the harness and triggering an independent browser request.
Local text selection and Shift/Option selection gestures retain xterm's normal
behavior. Confirmed desktop links use the native bridge, not xterm's default popup.

### Terminal protocol (client ⇄ broker, WebSocket)

Binary frames carry raw terminal bytes in both directions. Text frames carry
JSON control messages (`shared/protocol.ts`):

| Direction | Message | Meaning |
| --- | --- | --- |
| → server | `resize {cols, rows}` | Client geometry |
| → server | `focus {active}` | Whether this viewer is active; the latest active viewer controls PTY dimensions |
| → server | `ack {bytes}` | Output rendered; flow control |
| → server | `ping {id}` | Probe the remote terminal service through the relay without sending terminal input |
| → server | `send {id, data}` | Input that must be confirmed (composer drafts) |
| → server | `clear {id}` | Clear the shared screen and scrollback, keeping the current cursor line |
| → server | `paste {id, data}` | Paste text using the running application’s bracketed-paste mode |
| → server | `activate {id, token}` | Acknowledge a fresh launch ticket for this already attached session without starting another relay |
| → server | `acknowledge {id, completionId}` | Mark the displayed native completion as seen; never acknowledge a newer completion |
| ← client | `hello {resume, session, target}` | Connection accepted |
| ← client | `restore {checkpoint}` | Ordered checkpoint parts: begin, buffer lines, end |
| ← client | `geometry {cols, rows}` | Shared terminal dimensions, applied before subsequent output |
| ← client | `clear` | Clear the screen at this point in the ordered output stream |
| ← client | `ready` | Checkpoint restored; attached to the persistent PTY |
| ← client | `activity {activity}` | Native turn state using the same `SessionActivity` as the session list; invalid metadata becomes Unknown |
| ← client | `result {id, ok, message?}` | Outcome of `ping` / `send` / `clear` / `paste` / `activate` / `acknowledge` |
| ← client | `signal {type, payload}` | A remote request, e.g. `browser.open` |
| ← client | `closed {reason, message}` | `ended`, `expired`, `outdated`, `unavailable`, `error` |

The server pauses the transport when more than 256 KiB is unacknowledged and
resumes below 128 KiB. Acknowledgements mean xterm has parsed the bytes; painting
is independently scheduled by xterm's renderer.

Only `error` permits automatic reconnection. `unavailable` means setup requires
user action, such as installing a missing helper or restarting an incompatible
service. The broker preserves runtime HTTP error status through a single failure
classifier, shared with API lookup failures. A missing session or exited process is `ended`;
authentication errors are `expired`; other permanent request/setup errors are
`unavailable`. Transport failures, timeouts and target RPC throttling remain retryable.
Input congestion and WebSocket policy violations require explicit reconnection;
the client does not repeatedly retry rejected input.
An explicit Reconnect is available after the user repairs an unavailable target.

The coding process owns session lifetime. The Linux helper observes
`Subprocess.exited`; the reusable Bun PTY's `exit` callback only reports stream
closure and does not report each child exit. On child exit, pending output drains
until 50 ms of quiet, with a one-second ceiling so background descendants cannot
hold the session open. Each viewer flushes its snapshot and pending output before
the `exit` frame and EOF, with a 30-second shutdown deadline for slow viewers.
The service removes its socket, so management reports the session as stopped.
The broker handles `exit` immediately, independent of SSH process cleanup.
Reconnect starts the coding tool with the same native conversation ID; it never
automatically restarts a tool that deliberately exited.

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
Inspection loads the interactive login environment to discover the same tools as
session launches. Installation loads login profiles noninteractively, then runs
the submitted script with `sh -s`. Batch installers have no controlling terminal
and must not initialize interactive shell job control. Their stdout and stderr
are streamed unchanged; the terminal helper installer reports its download and
verification stages explicitly.

The broker starts the relay through the target's transport exactly like any
other runtime operation (`ssh -T … "$SHELL -lic …"`, or the login shell
locally). Login shells may print first; the relay then prints a magic marker
and exchanges length-prefixed frames: one type byte, a 4-byte big-endian
length, and the payload. If the runtime fails before the marker (a missing
session, missing terminal service), its `OUTPOST_RESULT` error becomes the client's
`closed` message.

| Type | Direction | Payload |
| --- | --- | --- |
| `I` | broker → relay | Input bytes for the persistent PTY |
| `O` | relay → broker | Live PTY output |
| `C` | both | JSON control: `resize`, `focus`, `send`, `clear`, `paste`, `acknowledge`, `signal-result` / `restore`, `geometry`, `clear`, `ready`, `activity`, `result`, `signal`, `exit` |

Framing separates terminal bytes from control messages. The relay connects to
`~/.outpost/terminals/<id>.sock` and forwards complete frames, adding activity
and signal messages only between frames. SSH needs no PTY. Closing the relay
closes only that socket, leaving the service and harness running.

`shared/node/terminalFrames.ts` owns encoding and incremental decoding for the
broker and terminal service. `runtime/outpost_frames.py` implements the same
bounded format for the relay and lifecycle RPCs. Framing validates the type and
length before accepting a payload; the connection owner interprets its controls.

### Persistent terminal service

`outpost-terminal serve` receives launch configuration on stdin, starts a PTY
with Bun's native terminal API, and runs a pinned `@xterm/headless` engine.
Python starts it in a new OS session with independent log files and no inherited
SSH stdio. Each session has its own process; a failure cannot take down every
session. The service never needs Node or Bun installed separately on the target.
The helper and its sockets have owner-only permissions. Control RPC authenticates
the daemon PID and user using Linux `SO_PEERCRED` before lifecycle operations.

The normal buffer retains 10,000 rows in memory. There is no raw output journal,
copy mode, prefix key, status bar or keyboard negotiation shim. The service
interprets terminal state and delivers live output to attached renderers. Complete
UTF-8 and VT sequences are framed before entering xterm so checkpoints never
split a control sequence. Unterminated control strings are bounded to 1 MiB.

`shared/terminalState.ts` defines the checkpoint wire types without importing
xterm internals. `shared/terminalCheckpoint.ts` is the single versioned adapter
to xterm 6.0's internal state. Its private surface is typed in
`shared/xtermInternals.ts`; runtime service/method checks guard the engine boundary
before state is read or restored. Reconnect transfers cells (including styles,
combined characters,
soft wrapping and OSC 8 links), both buffers, cursor/save-cursor state, tabs,
character sets, scrolling margins, palette and application/mouse modes. It does
not re-execute old output: bells, OSC 52 and browser requests cannot replay.
Changes to xterm's internal buffer layout require coordinated headless/renderer
updates and a checkpoint protocol bump. This coupling is intentional; separate
terminal parsers would otherwise disagree about screen state.

Snapshot capture copies owned cells and metadata synchronously between PTY
callbacks using native typed-array copies. Row compression is deferred until
streaming, so the atomic phase does not scan every cell in JavaScript. Captured
rows are released as each part is encoded, and abandoned generators release their
remaining rows. At most two viewers per service may be restoring simultaneously;
additional viewers receive a transient error and retry. A maximum-size snapshot
holds about 50 MiB of raw cells plus metadata before streaming releases them.
Checkpoint schema 2 encodes each row's repeated final cell once,
preserving its character and style as well as combined characters and links.
`terminal-service/attachment.ts` encodes and streams this immutable snapshot in
4 ms slices, honoring socket backpressure. The live PTY keeps running; each
restoring attachment queues subsequent output and geometry in order. Readiness
follows the complete snapshot, enabling input (including Ctrl+C) while queued
output catches up. Catch-up and live socket buffers are each limited
to 8 MiB; a viewer that stops reading a blocked snapshot for 30 seconds is disconnected.
The browser applies checkpoints, geometry and bytes through one
ordered render queue and acknowledges both snapshots and live output. Its
buffer is replaced on reconnect instead of appending duplicate history.
`frontend/terminal/rendering.ts` owns that queue, the restoration lifecycle and
the readiness barrier. Connection generations discard queued work and callbacks
from a previous attachment. Restoration is required by `TerminalSocket`, which
owns transport and acknowledgements; `TerminalSession` owns its lifetime and UI
event subscriptions, while `TerminalView` renders its state.
The renderer rejects live bytes and readiness before a complete checkpoint, and
configures xterm to leave generated terminal replies to the headless service.

The service always processes PTY output, including with no clients attached;
a client with an excessive output backlog is disconnected and can resynchronize.
It cannot freeze the harness through transport backpressure. Each viewer retains
its requested dimensions. The latest activated viewer controls PTY dimensions;
loading a second viewer does not steal control. When the controller becomes
inactive, another active viewer takes over; when it disconnects, the most recent
active (or remaining) viewer takes over at its own remembered size. With no
active viewer, the current controller keeps its dimensions. All viewers receive
the same geometry before subsequent output. Input from attached clients is
ordered into one PTY. Focus messages express UI activation separately from
application-generated terminal focus escape sequences.

This contract uses terminal service 1.2.0 / protocol 4 and client protocol 13.
Publish the matching helper before deploying the server. A service protocol
change requires explicitly restarting existing service processes after installing
the dependency; replacing the executable does not alter a running PTY service.

The headless engine alone answers terminal queries, even when disconnected.
The browser forwards user input, mouse and focus events, suppressing duplicate
terminal-generated replies. Palette queries use the same shared terminal theme.
Resizing updates both engine geometry and the PTY, delivering normal SIGWINCH.
`outpost_terminal.child_command` wraps the harness command in a short Python
bootstrap: create a child session, claim stdin's PTY as its controlling terminal,
set the foreground process group, restore terminal signal defaults, and exec the
original command. The service retains the PTY master and its independent lifetime;
the bootstrap does not remain as a supervisor. Assigning PTY stdio alone does not
establish a foreground process group and therefore cannot deliver resize signals.
The existing Python dependency provides this setup without a new target package.
Sessions started before this setup need an explicit Terminate/Connect to restart the
CLI and resume its conversation; reconnecting a viewer cannot establish terminal
ownership for an already-running process.
Ctrl+C and other application keys pass directly through the PTY.

The terminal service persists across client, SSH and Outpost server restarts.
Its in-memory state and running processes do not survive a target reboot or
service crash. Explicit Terminate walks the authenticated service's process
tree using PID/start-time checks (and pidfds where available). Updating the
installed executable atomically leaves already-running sessions alone.

### Building and installing the dependency

`shared/terminalService.ts` defines the executable version, service protocol,
and terminal bounds. `runtime/outpost_terminal.py` mirrors the service contract.
The manual `.github/workflows/terminal.yml` builds baseline x86_64 and ARM64
binaries for glibc and musl, plus SHA256SUMS. Publishing creates an immutable
`terminal-v<version>` release. The Required Software installer selects the
architecture/libc, downloads that exact release, checks SHA-256 and `--version`,
and renames the verified executable into `~/.outpost/bin/outpost-terminal`.
It uses the existing editable installation plan, SSH/local transport and log UI.
Minimal musl targets also receive the `libstdc++` system package.

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
list and live terminal activity. Harness adapters supply live state when the CLI
has an authoritative status API; other harnesses use native turn markers.
Terminal output rate, elapsed silence and local typing never infer Working or
Idle. Current activity and unread completions are separate: live Working always
wins over startup baselines and acknowledgement checkpoints. Reading activity
does not acknowledge it.

**Codex** reads `thread/read` (`includeTurns: false`) from the existing daemon's
`CODEX_HOME/app-server-control/app-server-control.sock`. This observes an exact
thread without starting a process, resuming/subscribing to a thread, or submitting
a model request. An active turn is Working, including a turn that survived a
terminal restart.
Approval/input waiting flags appear in the activity description. Idle permits
checking for an unread completion; stale transcript start markers cannot keep a
daemon-confirmed idle thread Working. A running terminal whose thread is not
loaded in that daemon, an unreachable daemon, or an unsupported response becomes
Unknown instead of guessing from old files. If neither terminal nor daemon is
running, persisted completions can still be checked.

Codex 0.162.1's `/review` does not emit a parent start event, and its own live
status can remain Idle before delegated work starts. The adapter recognizes
native review entry/exit records (including paginated `ItemCompleted` records).
An unresolved review with no confirmed live work shows Unknown until an active
status or later lifecycle event resolves it; acknowledgement and startup
checkpoints cannot turn that uncertainty into Idle.

The native API supplies the current transcript path. Local input/startup
checkpoints use the selected path in Codex's `state_5.sqlite`, opened read-only
with bounded queries. Reverts keep the logical thread ID but switch to a new
rollout; filename globs and modification time cannot select it correctly.
An unindexed new thread has no checkpoint yet. Paths stay within the pinned
`CODEX_HOME`; index errors never fall back to an obsolete file. The adapter owns
these native-format details. Changing the conversation inside Codex still does
not change Outpost's pinned thread identity.

`outpost_rpc.py` shares JSON-RPC response handling between allocation processes
and the local observer. `outpost_rpc_socket.py` provides a stdlib-only Unix
WebSocket client with peer-user verification, bounded HTTP/frame/message sizes,
fragmentation and ping/pong support, and a two-second whole-observation deadline.
No observation performs socket I/O while holding the acknowledgement lock or
from terminal input handling. Startup tolerates unavailable native activity data;
subsequent observations report failures without preventing terminal attachment.

The baseline and acknowledgement checkpoints decide whether a completed turn
is still unchecked. Only completion notices consult them for Codex; the other
harnesses also use the startup baseline to discard stale transcript work markers.
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
starts with the relay and runs separately from its I/O loop; the persistent
terminal service owns the PTY independently.
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
The desktop bridge contract is defined by `desktopBridgeVersion` in
`shared/desktop.ts`; server and app must be updated together.
The renderer alone owns the terminal bell flag. The native shell displays reported
state and owns OS notifications, but does not independently rewrite attention on
activation or notification creation. Both a host focus transition and an explicit
focus command acknowledge the bell, including reselecting the active tab. The
preload ignores an initial host-state response if a newer focus event arrived
while that response was in flight.

### Terminal search

`useTerminalSearch.ts` owns one `@xterm/addon-search` instance for each xterm
lifetime. `TerminalSearch` is an absolute overlay within `terminal-body`, so
search never changes terminal dimensions, sends PTY input, or fetches remote
history. It searches only xterm's active buffer, including retained scrollback.
The addon refreshes highlights after output and resizes; highlights are capped
at 1,000 and the UI reports that bound rather than a misleading exact total.
Closing search clears decorations and restores terminal (or recovery) focus.
The query stays with its tab until that view is destroyed.

The shared controller captures Cmd+F/Ctrl+F before xterm and browser Find. The
desktop Edit menu sends the typed `find` command through `DesktopBridge` to the
active terminal, including local shells. Toolbar and context-menu actions use
the same controller. Search input and match navigation are entirely local.

### Clear screen

**Clear screen** uses Cmd+K on macOS and Ctrl+Shift+K on Windows/Linux. It is
available in the shared terminal context menu and the desktop Edit menu; the
Outpost home tab and Settings list the shortcut. Plain Ctrl+K remains application
input. The operation is available while connected, and sends no keystrokes or
shell commands. It does not restart the coding process or change terminal size.

Clearing uses the shared `clearTerminal` engine adapter: discard the active
screen and its scrollback, retaining the current cursor line at the top. It also
clears rows below a cursor already at row zero, where xterm's public `clear()`
would return early. Discarded markers are removed, retained OSC 8 links receive
new markers, and the viewport returns to live output. Fullscreen applications
repaint according to their own behavior; clearing does not force a redraw.
For remote sessions the request reaches the authoritative Linux service, which
clears its buffer and broadcasts `clear` to all attached viewers. Checkpoints
therefore cannot restore discarded history. Local shells apply the same operation
directly in their renderer's ordered queue. Clear is a barrier between output
batches, so output written afterward is retained. The search addon is recreated
afterward to invalidate cached lines and decorations without private API access.

The current clear and health-check contract uses terminal service protocol 4 and client protocol 13.
Install the updated helper and explicitly restart existing service processes;
older protocols are rejected instead of ignoring the operation.

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
origins, and `preferences.ts` serializes font size, bell sound, and the default
local shell profile ID (`null` selects the platform default). All three keys are
required in a saved preferences file. A missing file uses defaults; an unsupported
saved shape is rejected with reset instructions, without rewriting it.

### Recent remote sessions

`recent-sessions.ts` atomically serializes at most ten remote sessions to
`recent-sessions.json` in Electron's `userData` directory. The file contains
plain resume credentials, the normalized server origin, opaque session routing
key, display title, and last connection time. Launch tickets, local shell
sessions, terminal contents, and drafts are not saved.

The store and open-tab registry share `remoteSessionId(server, sessionKey)`.
Records are added or refreshed only after the broker's authenticated `hello`,
or when explicitly opening an already connected tab. The main process derives
identity from the sending tab; the renderer cannot choose a different server or
session entry. Workspace snapshots contain display metadata only, never tokens.
Selecting a recent entry activates an existing tab across windows, or uses the
same remote view creation and WebSocket connection path as a new launch. Resume
credentials never go through the fresh-launch `activate` operation.

Entries survive app restarts. Remove/clear deletes saved credentials and disables
background re-saving by the affected open tabs; a subsequent explicit Connect
can remember them again. Forgetting a server closes its tabs and removes its
entries. Startup also removes entries for origins that are no longer trusted.
The store serializes concurrent mutations and app quit waits for pending writes.

Expiry is enforced by the existing broker on use: resume grants last 30 days,
while the original hosted login must remain valid. New grants do not extend
that login. Expired or logged-out entries stay listed and show the existing
Connection expired error; there is no background refresh or automatic sign-in.

### Local shells

The logo opens managed servers and sessions; **+**, the new-terminal shortcut,
and a new window open a local shell. Right-click **+** or the File menu selects
a profile. `shell-profiles.ts` resolves the login shell on macOS/Linux and
PowerShell, Command Prompt, and WSL on Windows. Only native profile IDs cross
the chrome bridge; the renderer cannot supply an executable, environment, or cwd.

`TerminalPane.connection` distinguishes a remote launch from a local PTY owner.
The same registry, window layout, tab transfer, split, focus, notification, and
clipboard infrastructure serves both. Moving a local tab preserves its view and
PTY. Closing it ends its shell; quitting ends all local shells. Tab, window and
app close always ask for confirmation when tabs remain, and reload asks before
restarting a running local shell. Single-tab confirmation names the tab and
explains whether its shell ends or its remote session keeps running, including
any unsent message in the same prompt. Cancel is the default action.
Remote session lifetimes are unchanged.

`scripts/build-desktop.mjs` bundles `frontend/terminal/local-entry.tsx` and the
shared `TerminalView` into the app. Local terminals work offline, without a server
or account. `TerminalConnection` separates the screen from `TerminalSocket` and
`LocalTerminalConnection`. The latter uses the separate `LocalTerminalBridge`,
exposed only by `local-preload.ts` to the exact packaged local terminal page.
Every native local operation resolves and validates its sender's owning tab and
main frame; remote pages cannot invoke the PTY capability. Both page types remain
sandboxed, isolated, and without Node integration. The local page's CSP denies
network requests and its navigation is locked to its bundled entry.

`local-terminal.ts` owns `node-pty`, using a native PTY on macOS and ConPTY on
Windows. The local renderer is the terminal emulator: normal scrolling, alternate
screen, terminal queries, bells, cursor reports, and application mouse input pass
through xterm. The common `TerminalRenderer` serializes output, reset, and geometry;
local mode starts with an empty buffer and does not install the remote query-reply
suppression or restore a checkpoint. Resize events go to both xterm and the PTY.
Output and geometry share one ordered IPC channel. Render acknowledgements pause
PTY reads at 262,144 unrendered UTF-16 code units and resume below 65,536. A
generation ID rejects stale data, input, and acknowledgements after a restart.

Each local pane starts in the user's home directory and retains up to 10,000 lines
in xterm memory. There is no local session recovery after renderer reload or app
exit. Local panes report connection and bell state, without guessing coding-harness
activity. Image paste sends raw bytes over IPC and saves a bounded file in the pane's private clipboard directory,
quotes the path for its shell, and uses `wslpath` for the default WSL distribution.
Closing the pane cleans up those files. Native PTY bindings and spawn helpers are
kept outside ASAR and rebuilt for Electron by the packaging tools. Windows uses
node-pty's bundled ConPTY DLL; `desktop/scripts/native-assets.mjs` restores its
DLL and OpenConsole helper beside rebuilt bindings after packaging and in dev.
This avoids the older shutdown path's Node fork helper and keeps the Electron
RunAsNode fuse disabled.

### Shared workspace

The hierarchy is **application → windows → tabs → pane trees**. A pane is a
terminal instance; a tab is a layout container; a window owns an ordered list of
tabs. `workspace-model.ts` defines these domain types independently of Electron
and the renderer bridge. `workspace.ts` owns all windows, the pane-to-window
ownership map and a single app-wide `TerminalPanes` registry. The registry owns
terminal resources, connections, reload and disposal, and exposes a read-only map.
Each pane ID has one owning `WorkspaceWindow`; duplicate launches and
notification clicks resolve that owner dynamically, including after a transfer.
`workspace-window.ts` owns one `BrowserWindow`, native view placement and local
chrome. `WindowLayout` owns membership and selection: the window selects one tab,
and each tab remembers one active pane in its binary split tree, with an optional
label and a zoom flag. The active pane is derived from those selections, never
stored a second time at window level. A workspace page preserves that selection
but has no focused terminal; pane shortcuts do not act on hidden panes.

Tab and split IDs are stable layout identities; leaf IDs identify the actual
terminal web contents. Tab values and trees are read-only to callers; model
operations replace them. Whole-layout restores and transfer insertions validate
unique membership, valid ratios and selections before changing state. Removing a
leaf collapses its parent, removing an empty group selects a neighboring tab, and
zoom changes visibility without discarding the tree. One recursive `paneLayout`
computes the native content rectangles, pane headers, dividers and hit-test bounds.
Minimum sizes compress proportionally when the window is too small, leaving saved
ratios intact. Dividers paint a one-pixel stroke inside a six-pixel native gap;
the gap is also the pointer target and supports keyboard resizing. Menus resolve
the focused or most recently focused window. Resolving an action never creates a
window; explicit launch/new-window actions own creation and clean up failed pane
attachments.
`workspace-ui.ts` renders the tab strip, session switcher, server launcher and
settings. `pane-ui.ts` renders keyed pane headers, keyboard-accessible dividers and
error panels in the space reserved around native terminal views. The
`workspace-preload.ts` bridge accepts only enumerated local UI actions; one IPC dispatcher verifies the bundled main frame and routes each call
to that sender's window. Actions name their scope (`activateTab`, `activatePane`,
`closeTab`, `closePane`, `splitPane`, `zoomPane`, `reloadPane`) and take explicit
target IDs. Each action checks membership in that sender's window.
`workspace-commands.ts` validates argument shapes at that IPC boundary. Command
names and argument types are derived from `WorkspaceBridge`, used by both the
preload and dispatcher; there is no separate string-alias registry. The window
then applies ownership checks and executes the typed command. Invalid commands
are rejected before cancelling a drag or changing window state.
`keyed-elements.ts` preserves DOM nodes in the tab strip, server list, session
switcher and error panels; metadata refreshes update their contents without
resetting keyboard focus or icon animations. The switcher retains the selected
session by ID across updates. Native host-state messages are sent only when
focus or preferences change, not on every activity refresh.
The local renderer receives separate pane and tab summaries, never grants,
terminal bytes or draft contents. `workspace-summary.ts` projects tab labels,
member IDs and aggregate status from the model and pane states. A tab summary
does not inherit a representative pane's identity, origin, error or connection
capability. This projection is shared with DOM fixtures, keeping presentation
tests on the production aggregation rules.

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
`pane-appearance.ts` owns inactive-pane dimming in the native presentation layer,
independent of the server page and terminal bridge. It inserts a fixed,
click-through CSS overlay, serializes focus updates and reapplies after navigation.
Focus never alters view bounds or xterm's layout. The active pane retains its
normal appearance when the application loses focus.

`workspace-shortcuts.ts` shares tab and pane accelerators between the native
menu and the workspace guide: Cmd+T/W and Cmd+D/Shift+D on macOS,
Ctrl+Shift+T/W and Ctrl+Shift+D/Ctrl+Alt+D on Windows. Zoom, pane close and pane
cycling use the same definition in both places.
Cmd+W / Ctrl+Shift+W closes only the focused pane, with confirmation. Layout removal
collapses its split and removes empty tabs; an empty window closes afterward.
Closing all panes in a tab is an explicit File/tab-menu or tab-close-button action.
Cmd+Shift+W / Alt+F4 remains the separate native window-close action.
`workspace-close.ts` handles all three close scopes through one policy. It permits
one pending confirmation per window, captures the exact terminal instances, and
rechecks membership after confirmation before disposing each pane. A moved pane,
new arrival or replacement is not covered by the earlier confirmation. Empty
tabs collapse in the model; empty native windows close after removal. App quit
also checks for arrivals during confirmation and cleanup before exiting.
Pane accelerators are intercepted in native `before-input-event` as well: terminal
renderers can consume Enter before a menu accelerator runs. The shared definition
drives matching and dispatch, suppressing repeat presses and duplicate menu delivery.
Both the Outpost home page and Settings render the same shortcut list. The home
page stays open until a tab or another page is selected; it has no Back/Escape
control. Transient panels retain Escape dismissal.

`workspace-shortcuts.ts` also reserves Ctrl+Tab and Ctrl+Shift+Tab in Electron's
`before-input-event` for both the workspace and terminal web contents. It prevents
renderer delivery and the duplicate menu accelerator, then uses the existing
`WindowLayout.cycleTabs` order and activation path. Terminal callbacks resolve the
current owner after cancelling provisional drags, so shortcuts follow moved tabs
without adding renderer IPC or keeping a second tab order.
The same native input handler consumes Escape during a drag, including repeats
and key release. Keyboard focus can remain inside a terminal while the workspace
holds pointer capture, so a workspace DOM listener alone cannot cancel reliably.

`workspace-drag-ui.ts` handles both tab buttons and pane headers. It selects on
press, starts a drag after an eight-pixel threshold, and moves pointer capture to
the stable workspace body so removing a header or tab cannot cancel the gesture.
`workspace-drag.ts` owns one drag across the app. Its payload contains only a
layout kind and ID; it carries no grants, terminal data or message contents.
A 32 ms timer resolves screen DIP coordinates against window bounds, measured tab
bars and shared pane geometry, respecting the temporary native stacking order.

`pane-transfer.ts` is the single transfer path for dragging, context menus and the
session switcher. A small structural window interface keeps the transaction
independent of Electron and testable with the real layout model. It snapshots source and destination layouts, extracts a pane or
whole tab subtree, inserts it at a tab position or pane edge, and reparents the
same native views while changing their app-wide owners. Failure or cancellation
restores both layouts and ownership, including active panes, zoom and panels.
No terminal process, connection, renderer, buffer or draft is recreated.

Hover over another window's tab bar provisionally transfers the live view(s).
The destination selects the incoming tab. An empty source uses native opacity to
stay focused and keep pointer capture while becoming invisible; `hide()` would
discard that capture. The destination is raised without taking focus. Hovering
the inserted tab retains its anchor to avoid flex-width feedback. Leaving restores
the layout, and release commits without another reparent. Esc, capture loss, blur,
renderer failure, terminal disposal or closing either participating window cancels.
Menu and launch actions cancel the drag before resolving current ownership.

Pane-edge hover instead shows a click-through native highlight above terminal views.
It does not mutate the tree or resize views while hit testing; therefore a stationary
pointer cannot create a layout/measurement feedback loop. Release commits through
the same transfer transaction. A self-drop or invalid area inside a workspace cancels;
outside every workspace it creates a window. Moving all of a lone window's contents
moves that native window instead. Empty windows close only after a committed move.

`drag-preview.ts` paints the native highlight or an outside-drag title label. Every
update supplies complete bounds from pane geometry or fixed label dimensions,
never previous popup measurements. Windows resize insets are disabled. Loading
asynchronously cannot reshow a hidden or destroyed preview. New window bounds are
clamped to the destination display's work area.

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
output and acknowledgements. Nested splits place existing views using the shared
tree geometry. Moving/reordering panes never redeems another grant. There is a
32-pane limit across at most 16 workspace windows. Closing a tab explicitly destroys
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
launches focus an existing tab or add one to the active window. Closing a remote tab or window never terminates its target session. The server
launcher can forget a server and close its tabs. Reopening the app starts a fresh
workspace with its recent remote sessions available for explicit reconnect;
layouts and running local shells are not restored. The app icon and Windows
AppUserModelID belong to Outpost.

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
| Terminal service sockets | `~/.outpost/terminals/<session>.sock` |
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
| Runtime and relay | `tests/runtime/` — real terminal service in a disposable home: lifecycle, framing, resize, image paste, signals, activity semantics |
| Server | `tests/unit/` — tokens, workspace, API validation and network policy, hosted isolation and revocation, broker against a fake relay, TypeScript ⇄ Python contracts |
| Whole path | `tests/integration/` — local targets over WebSocket; SSH in Docker with the built service in both modes; conversation discovery |
| Browser | `tests/browser/` — real backend: add target, create session, web terminal, desktop ticket flow, phone layout; mobile WebGL rendering, real clipboard copying, and GPU context-loss fallback |
| Mobile browser | `tests/browser/mobile/` via `npm run test:mobile` — Chromium phone and WebKit phone/tablet: touch controls, viewport changes, copy/paste, notifications, and resume; real PTY input and resize coverage |
| Desktop model | `tests/unit/desktop-panes.test.ts` — split-tree invariants, small-window geometry, transfer/rollback and destroyed views, platform shortcuts and dimming races |
| Workspace DOM | `tests/desktop/workspace-dom.spec.ts` — packaged chrome, real layout model, pane focus/zoom, divider input, drag cancellation, stable DOM identity, error actions and shortcut guide |
| Native desktop | `tests/desktop/` via `npm run test:desktop` — Linux Electron, real preload/IPC/node-pty, native keyboard/mouse, cross-window pane/tab transfers, hover cancellation, drafts, dimming, PTY resize, close confirmation, wake recovery and image clipboard/cleanup |
| Desktop packaging | Manual `desktop.yml` workflow builds macOS arm64/x64 and Windows x64 installers; OS integration still needs native manual verification |

Mobile automation uses real browser engines with emulated device sizes. Android swipes use Chromium's trusted
touch input; WebKit swipe routing and keyboard occlusion use synthetic touch/VisualViewport events because
the headless port cannot open a phone keyboard. Notification tests cover permission/setup failures and
cleanup races with browser API doubles, plus actual worker activation in both engines and notification
registration in Chromium. They do not prove physical iOS selection handles, OS banners, Home Screen installation, or
background suspension behavior. Those still need a physical iPhone/iPad and Android device check.

For Linux native desktop checks, install `desktop/` dependencies, run
`npm --prefix desktop run native` and `npm --prefix desktop run build`, then
`xvfb-run -a --server-args='-screen 0 2400x1400x24' npm run test:desktop` on a headless
host with `xdotool` installed. The large virtual display fits multiple native windows
and an outside drop target. The suite uses isolated app profiles and disposable
input/resize recorders; it exercises real OS pointer capture and menu/input routing.
macOS/Windows accelerator definitions are unit-tested, but native window management,
scaling and keyboard behavior still need checks on those operating systems.
Browser image checks compare saved
bytes and exact bracketed-paste input, including no automatic Enter; API/runtime
checks cover 16 MiB boundaries, authorization/revocation, cancellation, retention,
and uploads that must not hold the session registry lock. Native Windows/macOS
clipboard and WSL path conversion still require those operating systems.
