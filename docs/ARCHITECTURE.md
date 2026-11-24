# Outpost architecture

A machine owns its coding sessions. The web home (`/`) lists machines and their sessions.
Terminal and Chat (`/chat`) attach to the coding agent on the selected machine.

For the two enrollment methods and their acceptance criteria, see the [v3 connectivity design](V3.md). For installation and ownership changes, see [machine setup and removal](../README.md#machine-setup-and-removal).

## V3 terminology

| Term | Meaning |
| --- | --- |
| Terminal client | Outpost Desktop or the web terminal. The client asks its Outpost instance to attach to a session. |
| Outpost server | The local or hosted instance that owns the workspace, authorizes attachments and communicates with enrolled machines. |
| Machine | The Linux system that runs coding agents. A **target** (`Target`, `/api/targets`) is its workspace record. |
| Outpost machine service | The `outpost-terminal` executable installed on the machine. Its **node** handles machine protocol requests and opens streams to the session’s terminal service or chat host. |
| Session | The machine-owned workspace for one coding agent. Its process can keep running after a viewer detaches. |
| Enrollment | The binding between a remote machine, one Outpost server and workspace owner, and one Linux execution account. It records one connection method. |
| Connection method | **Connect over SSH** lets the Outpost instance open SSH to the machine. **Run setup on the machine** explicitly enables a persistent outbound connection from the machine to that instance. |

## Principles

1. **The machine owns the session.** For a native CLI, the terminal service owns the PTY,
   screen and in-memory scrollback requested by its viewers. For an ACP agent, the chat host owns the
   process and journal. Closing or losing a viewer leaves the agent running.
2. **One machine connection carries work in both directions.** Terminal attachments, Chat,
   file transfers and agent tool calls share that connection. Published files remain on
   the machine for returning viewers. A separate paste request commits an uploaded image to the original viewer.
   The running driver handles the image in its own draft.
3. **Outpost authorizes each attachment.** A client opens its session through Outpost.
   Access is scoped to the workspace owner, machine and session. A coding agent’s Outpost
   tools act as that session.
4. **Enrollment fixes the connection method.** Local and hosted instances both default to
   SSH. Only explicit outbound enrollment allows the machine to initiate an Outpost
   connection. After a disconnect, Outpost uses the enrolled method again. Changing it
   requires re-enrollment.
5. **One executable serves both methods.** The versioned Linux executable in
   `~/.outpost/bin` provides the node, terminal services, chat hosts, MCP server and
   hooks. They run as the machine’s execution account and use private Unix sockets.
6. **The client shims the platform.** Making a remote session feel native
   (paste an image with the usual shortcut, Shift+Enter for a newline, copying
   to your clipboard, opening links on your computer) is the client's job.
   GPUI owns desktop input and rendering. The browser and native helper share the terminal connection code.
7. **Explicit gestures only.** The local clipboard is read only on a paste
   gesture, never polled. Remote programs can copy to your clipboard (OSC 52)
   and ask to open `http(s)` links, but can never read your clipboard.
8. **Extensible at the edges, small in the middle.** Desktop capabilities, coding
   harnesses, signal types and transports are registries or interfaces. The
   data path between them stays a dumb, well-specified pipe.

## Components

```text
Connect over SSH           client ──→ Outpost instance ──SSH──→ Linux machine
Run setup on the machine   client ──→ Outpost instance ←─────── Linux machine
```

Arrows show who opens each connection. Data flows both ways on each link. On the machine,
the node connects to the terminal service or chat host for the requested session.

| Directory | Runs on | Role |
| --- | --- | --- |
| `frontend/` | Browser | Workspace UI, Connect dialog, web terminal client |
| `backend/` | Outpost server | HTTP API, deployments, transports, machine connections, terminal broker, chat and history hubs |
| `machine/` | Linux machines | Outpost machine service: node, session registry, terminal service, chat host, MCP server, harness adapters |
| `desktop/` | Your computer | GPUI workspace, native PTYs, server accounts, trust and installers |
| `shared/` | Browser + desktop + server | Schemas, harness registry, terminal protocols and desktop account contracts |

**One definition per contract.** Request and stored-record shapes are TypeBox
schemas in `shared/schemas.ts`; the server and the machine validate with them,
and the types in `shared/model.ts` are derived from them. The server and the Outpost machine service share the rest of `shared/` too: framing, the node protocol
(`shared/machine.ts`), the chat host protocol and the harness registry.
`tests/unit/contracts.test.ts` checks that every registered harness has a
machine adapter. Browser entry paths live in
`shared/pages.ts`, shared by navigation and the production SPA fallback. A new
browser page must be registered there so development and production agree.

## Supported platforms

| Role | Supported |
| --- | --- |
| Machines (where sessions run) | Linux (including WSL) with Bash, `setsid` (util-linux) and the Outpost machine service. Forks also require Git. |
| Outpost server | Node.js 24+ with OpenSSH, on Linux (including WSL) or macOS. Hosted deployments run on Linux. |
| Web terminal | Any current browser, including phones. |
| Outpost Desktop | GPUI desktop for macOS arm64/x64 and Windows x64. |

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
| SSH origin and identity | The computer running Outpost, using your OpenSSH config, agent, keys and configured jump hosts | The hosted server, using the workspace owner’s Ed25519 key and known-hosts file. Any bastion must be reachable and usable from that server. |
| Where an outbound enrollment connects | The local instance needs an address reachable from the machine. Its default loopback address is local to the workstation. | The hosted instance’s public HTTPS origin, reachable from both client and machine |
| Sessions on the Outpost server itself | Available on a local Linux server | Unavailable |

Running a session on the local Linux server executes the service on that computer. A Desktop local shell uses a native PTY on the user's computer and ends when its pane closes. Neither involves a remote machine enrollment.

`backend/deployment.ts` defines the interface; `backend/hosted/` implements the
account side. Routes receive an owner and a resolved machine context; they never
branch on the mode.

## Terminal data path

### Connect flow

`frontend/connect/useConnect.ts` owns launching for both explicit and remembered
choices. `ConnectDialog` renders the chooser and optional desktop help. Web popups
and desktop links open synchronously from the user's click; effects only clean up,
so Strict Mode cannot launch twice. An installed standalone web app navigates to
the terminal in its current window, retaining its Home Screen context.

Desktop choices dismiss the chooser immediately. `desktopHandoff.ts` observes
window blur and page visibility before sending the OS intent. Retry/download help
appears after two seconds only if the browser stays focused and the user has not
continued working in the web UI. Leaving the browser dismisses any help and ends
the observer; returning never reopens it. Closing, retrying, choosing another
terminal, or changing machines cancels the timer and listeners. These signals are
UX hints, not acknowledgement that the app connected. Remembered launches skip
help entirely; synchronous launch errors reopen the chooser. No browser polling
or terminal credential is needed to ask the app to connect.

`preference.ts` stores only an explicitly chosen terminal in browser local
storage for the current origin. Connect reads it on each click, including changes
made in other tabs. The sidebar's **Connection preferences** works in local and
hosted modes; **Ask every time** removes the choice. Missing or invalid preferences
show the chooser, storage write failures are reported without blocking connection,
and launch errors return to the chooser. This never stores credentials or skips
authentication or desktop trust confirmation.

1. The UI chooses `web` or `desktop` (`shared/terminals.ts`). Web opens
   `/terminal?target=…&session=…`; that authenticated page requests a signed,
   single-use launch ticket valid for five minutes.
2. Every website entry uses `outpost://server?origin=…`. The public download
   page identifies just the server. The workspace's **Open in Outpost Desktop**
   button adds the expected `account`. A session's **Connect** action also
   adds the `target` and `session` IDs. A session link requires all three IDs.
   The link contains no credentials. The native helper validates the link and
   confirms first-use trust before contacting the server.
3. `ServerAccounts` uses an existing app login for the requested account, or
   starts browser approval. When the workspace supplied an expected account,
   consent requires that account. Pending session intents complete after login.
   Every session entry point requests a fresh scoped launch through
   `/api/desktop/targets/:t/sessions/:s/connect`.
4. The web terminal and the native session helper use `TerminalSocket` to connect
   to `/api/terminal`. The broker returns a 30-day resume token in `hello`.
   Grants remain bound to their issuing login and one session; revoking that
   login closes its live connections. Resume tokens stay in memory, never in
   OS links or page URLs. Proxies must not log WebSocket query strings.
5. `desktopSessionId` defines routing identity as server, account, machine and
   session, independently of login lifetime. Reopening activates the existing
   pane across windows. A connected pane consumes a fresh launch with `activate`
   on its existing socket; a renewed app login reloads the same pane with its
   new grant. The broker always checks the full grant, including login identity.
   Desktop tracks up to 16 pending server sign-ins, each with up to 16 session
   requests waiting for approval.

### Client choices and shared responsibilities

| Choice | Entry | Authorization | Native integration |
| --- | --- | --- | --- |
| Web terminal | `TerminalPage`, `/terminal` | Browser login requests a grant | Browser permissions and clipboard APIs |
| Outpost Desktop | GPUI workspace | The account helper requests a session grant | Native clipboard, file dialogs and PTYs |

The native connection stores the reusable grant from `hello` and reconnects
without reopening the shell.

Toolbar visibility is a browser preference in `TerminalView`; resizing
uses its existing observer and never opens another connection. Keyboard,
clipboard, composer, links, bells and notifications have one web implementation.
`terminal/session.ts` owns the emulator, connection, input handlers, browser events
and resource cleanup for one mounted terminal. `TerminalView` owns React state,
drafts and presentation. Subscriptions are paired with cleanup when acquired and
released in reverse order, including after partial initialization; late async
results cannot update a disposed session. A failed initialization can be retried explicitly.
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

`TerminalContextMenu` owns the browser terminal menu. Application mouse
modes pass through to xterm without a multiplexer interpreting clicks.
Without a mouse request, xterm selects text locally. Shift-drag
on Windows/Linux or Option-drag on macOS forces local selection when an application
requests mouse events. `attachClipboard` copies completed local mouse selections
through the same clipboard path as the context menu. It never enters a remote
mode or sends a selection gesture. Application OSC 52 copies still work.

The service and renderer use xterm's normal and alternate buffers. The normal
buffer retains 10,000 scrollback rows by default. Desktop can request a numeric
line limit or unlimited in-memory history on attachment and change it on a live
connection. A larger request increases worker retention. Opening a smaller viewer or
disconnecting leaves the retained history intact. An explicit settings change can
reduce retention to the largest attached request, with a 10,000-row floor for
browser viewers. Each viewer restores only its own window of
history. The alternate screen has no scrollback. Stopping the worker releases
its history. A Terminal view of an ACP agent reconstructs its transcript from
the chat host's bounded journal.
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
on narrow screens; browser terminals leave the toolbar toggle reachable when the
toolbar is hidden, while desktop panes use their terminal context menu.

`touch.ts` maps a single-finger vertical swipe to xterm's existing wheel handler;
it owns that touch gesture to avoid also scrolling xterm's local viewport.
Multi-touch remains available for browser zoom. It does not inspect the harness
or synthesize remote history commands. `TerminalTextDialog` offers native browser selection
of a bounded snapshot of the visible xterm rows, joining wrapped lines. Opening
it sends no PTY input and the live terminal continues rendering behind it. This
is a clipboard aid, not retained history; the snapshot is discarded on close.

The broker keeps a bounded FIFO for typed input, composer drafts and pasted
references. The service wraps a paste in bracketed-paste delimiters only when
the application requested that mode. Image bytes never enter this FIFO.
Drafts are confirmed only after the terminal service accepts their bytes into its PTY write queue; no queued
input is replayed across reconnects.
The browser and broker each cap queued transport input at 2 MiB. The machine
connection's `BoundedWriter` stops writing when the underlying stream applies
backpressure, resumes on drain, and drops the connection after 30 seconds
without drain.
Overflow closes the attachment with an explicit error and discards queued input.
Binary input, composer drafts and text pastes share the 1 MiB/s input
budget. These are transport bounds;
Bun's PTY write API accepts bytes into its own internal queue and does not expose
its buffered byte count.

Clipboard, drop and picker gestures use the same `TerminalSocket.pasteImage`
operation in both clients. A viewer uploads up to 16 MiB in acknowledged
`image-write` chunks. The machine checks the type, size, offset and transfer
ID and bounds outstanding memory. A complete upload stays private to its viewer
for up to 30 seconds. An `image-paste` request consumes that transfer once,
on the same connection. Disconnect cancels an uncommitted paste.

In a native Codex, Claude Code or Kimi session, the worker starts an authenticated
Xvfb display with TCP disabled. A GTK selection owner offers the image on that
display and the worker sends Ctrl+V to the agent. Success requires a request for
pixels. Listing clipboard formats alone does not acknowledge delivery. The owner
serves repeat reads briefly, releases expired data, and exits when the worker
closes its pipe. Missing clipboard software leaves the terminal usable: when the
tool or machine cannot accept a native clipboard paste, `image-paste`
automatically falls back to storing a machine-local image and inserting its
path. The explicit file-path action always stores a machine-local image and
inserts its path.

An ACP terminal stages image files privately in the viewer's draft. Backspace on an
empty line removes an image. Cancelling or disconnecting discards the draft's
files. Enter commits the files and submits their IDs with the text through the same prompt path as Chat.
The chat host sends image content when the agent advertises that capability;
when the agent does not accept inline images or an image exceeds 5 MiB,
`image-paste` automatically falls back to storing a machine-local image and
inserting its path.
Local Desktop panes use normal text paste and forward the application's own
clipboard key.

Published files travel in the other direction with `file-list` and offset-based
`file-read` requests scoped to the attached session.

`TerminalSocket` owns recovery for both web and desktop remote terminals. Every
15 seconds after readiness or a successful health check, it sends an authenticated
`ping` through the broker and machine connection to the terminal service. The service replies
without writing bytes to the coding process. A missing reply after 30 seconds
replaces the attachment, including when an idle socket still claims to be OPEN.
Returning to a visible page, browser focus, `pageshow`, or `online` checks it
immediately with a shorter 5-second deadline. The browser adapter forwards system
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
automatic attachments use `start=0`. The node checks that intent when it opens
the terminal stream, so a process that exited while the client was offline is reported as ended,
even when its original exit event never reached the client. A single-use launch lost before the client receives its first resume grant
requires a fresh Connect from Outpost. Browser/OS suspension delays JavaScript;
recovery begins when the page can run again.

The broker independently probes the remote service every 15 seconds, suspending
its deadline while renderer backpressure deliberately pauses stdout. A viewer
that sends no rendering acknowledgements for 60 seconds while output is paused
is disconnected for resynchronization. WebSocket ping/pong detects lost clients.

`useBellNotifications` manages browser permission requests, with an eight-second
busy timeout and permission refresh on focus.

Browser alerts use `notificationTransport.ts` and a notification-only service
worker (`public/terminal-notifications.js`, scope `/terminal`). Registration and
activation have deadlines; failures leave a retryable notice. The worker has no
fetch handler, cache, background session, or Push subscription. Notification
clicks focus the matching web terminal or open its normal authenticated page;
data contains only machine/session identifiers, never launch/resume credentials.
Pending notifications are cancelled by generation on acknowledgement/disposal,
and an old notification's cleanup cannot close a newer notification with the same
session tag. Browsers without service workers retain the page Notification path.
The manifest supports Home Screen launch; iOS outside that context gets actionable
setup instructions instead of an unusable permission prompt. Permission is
labelled as allowed, not as a promise of background delivery: suspended pages
cannot receive live bells, and server-side Web Push is not implemented.

The browser loads xterm's WebGL addon after opening the terminal. Initialization
failure or context loss disposes the addon and falls back to the DOM renderer.
Terminal parsing and broker flow control do not depend on the renderer. Output
acknowledgements are batched at 64 KiB or 20 ms, at most every 10 ms, after
xterm's write callback;
callbacks from an old connection cannot acknowledge a new socket's output.
Adjacent output awaiting a write is combined in batches up to 128 KiB, without
crossing checkpoint, geometry or readiness barriers. This avoids scheduling an
xterm write for each tiny network frame during a burst. A single larger source
frame remains intact; xterm's parser still yields according to its own budget.

`terminal/links.ts` owns OSC 8 hyperlinks and detected HTTP(S) URLs in the web terminal. OSC 8 activation confirms the actual destination before invoking the
shared browser opener; cancellation invokes no opener and creates no retry notice.
When application mouse reporting is active, a link's press and drag stay local
instead of also reaching the harness and triggering an independent browser request.
Local text selection and Shift/Option selection gestures retain xterm's normal
behavior.

### Terminal protocol (client ⇄ broker, WebSocket)

Binary frames carry raw terminal bytes in both directions. Text frames carry
JSON control messages. The following messages apply to a broker attachment. The current wire definitions live in `shared/protocol.ts`.

| Destination | Message | Meaning |
| --- | --- | --- |
| Broker | `resize {cols, rows}` | Client geometry |
| Broker | `focus {active}` | Whether this viewer is active; the latest active viewer controls PTY dimensions |
| Broker | `ack {bytes}` | Output rendered; flow control |
| Broker | `ping {id}` | Probe the remote terminal service without sending terminal input |
| Broker | `send {id, data}` | Input that must be confirmed (composer drafts) |
| Broker | `scrollback {lines}` | Update this Desktop viewer’s retention request for a running machine terminal |
| Broker | `clear {id}` | Clear the shared screen and scrollback, keeping the current cursor line |
| Broker | `paste {id, data}` | Paste text using the running application’s bracketed-paste mode |
| Broker | `activate {id, token}` | Acknowledge a fresh launch ticket for this already attached session without opening another stream |
| Broker | `acknowledge {id, completionId}` | Mark the displayed native completion as seen; never acknowledge a newer completion |
| Broker | `draft {active}` | The message box has text; messages from other sessions wait until it is sent or cleared |
| Broker | `deliver-now` | Type the next waiting message in once the agent is idle |
| Client | `hello {resume, session, target}` | Connection accepted |
| Client | `restore {checkpoint}` | Ordered checkpoint header, hyperlinks, buffer lines and end |
| Client | `geometry {cols, rows}` | Shared terminal dimensions, applied before subsequent output |
| Client | `clear` | Clear the screen at this point in the ordered output stream |
| Client | `ready` | Checkpoint restored; attached to the persistent PTY |
| Client | `activity {activity}` | Native turn state using the same `SessionActivity` as the session list; invalid metadata becomes Unknown |
| Client | `deliveries {waiting}` | Messages from other sessions, channels or schedules waiting to be typed in |
| Client | `result {id, ok, message?}` | Outcome of `ping` / `send` / `clear` / `paste` / `activate` / `acknowledge` |
| Client | `signal {type, payload}` | A remote request, e.g. `browser.open` |
| Client | `closed {reason, message}` | `ended`, `expired`, `outdated`, `unavailable`, `error` |

The server pauses the transport when more than 256 KiB is unacknowledged and
resumes below 128 KiB. Acknowledgements mean xterm has parsed the bytes; painting
is independently scheduled by xterm's renderer.

Only `error` permits automatic reconnection. `unavailable` means setup requires
user action, such as installing a missing helper or restarting an incompatible
service. The broker preserves the node's HTTP error status through a single failure
classifier, shared with API lookup failures. A missing session or exited process is `ended`;
authentication errors are `expired`; other permanent request/setup errors are
`unavailable`. Transport failures, timeouts and machine RPC throttling remain retryable.
Input congestion and WebSocket policy violations require explicit reconnection;
the client does not repeatedly retry rejected input.
An explicit Reconnect is available after the user repairs an unavailable machine.

The coding process owns session lifetime. The Linux helper observes
`Subprocess.exited`; the reusable Bun PTY's `exit` callback only reports stream
closure and does not report each child exit. On child exit, pending output drains
until 50 ms of quiet, with a one-second ceiling so background descendants cannot
hold the session open. Each viewer flushes its snapshot and pending output before
the `exit` frame and EOF, with a 30-second shutdown deadline for slow viewers.
The service removes its socket, so management reports the session as stopped.
The broker handles `exit` immediately, independent of stream cleanup.
Reconnect starts the coding tool again in the session's current conversation; it
never automatically restarts a tool that deliberately exited.

**Current contracts.** Both clients send `protocolVersion` from `shared/protocol.ts`.
A mismatch returns `outdated` before redeeming the launch ticket and asks the
client to update. Connection grants authorize an owner/login,
machine and session independently of the selected UI.

### Machine connection (server ⇄ node)

The Outpost server and the node share one bidirectional link per workspace owner and machine.
The terminal client asks the server for a session attachment. The server can also open a
stream on behalf of a channel, schedule or another session while the terminal client is closed.

#### Installing and removing a machine

Choose the connection method in **Machines → Add a machine**. Both methods install the same
executable for one Linux execution account. A private record in
`/var/lib/outpost-machine/machine.json` binds the machine to its Outpost server and workspace
owner. Session data belongs to the execution account under `~/.outpost`.

- **Connect over SSH** is the default. On first connection Outpost checks the platform and
  installed software, transfers the matching service and release checksum over SSH, and
  verifies the service before atomic installation. Installed coding tools are detected
  automatically, and unavailable coding tools or required ACP adapters can be set up on demand.
  A restricted machine can receive approved artifacts over this SSH connection. Interrupted setup
  can be run again. Subsequent connections run
  `outpost-terminal node` for the enrolled socket with `ssh -T` and exchange protocol bytes
  on stdin and stdout. A bastion can carry this connection. The node needs no SSH PTY,
  application port forward or machine-side HTTPS endpoint. The machine initiates no
  connections to Outpost.
- **Run setup on the machine** covers a machine Outpost cannot SSH to. An operator runs the
  wizard’s one-time command in a shell on the machine. It retrieves the installer from the
  chosen Outpost instance. The verified executable is installed before the first
  redemption, so `status` and `unenroll` are available even if that request fails.
  The service saves its random credential locally and the server binds it to the owner
  and machine. Retries with that credential receive the same receipt. Enrollment and
  boot-service activation share the local ownership lock with removal. A service
  manager then starts the outbound connection at boot and restores it after link loss.

Switching methods or transferring a machine requires releasing its local enrollment and
enrolling it again. Removing the machine from its old workspace revokes Outpost access
there. For an outbound enrollment, revocation closes the active link and rejects
reconnection. Remove the old Outpost key from the Linux account if the server should
also lose SSH access.

Releasing the enrollment or removing the executable preserves the account’s session
data and published files. Stop coding tools before uninstalling the executable.
Both `unenroll` and `uninstall` remove the outbound service when installed. A new
owner using the same Linux account can access its existing session data. Use a
fresh account to keep owners’ data separate.
The [operator instructions](../README.md#machine-setup-and-removal) cover setup, revocation and removal.

#### Linux account handoff

Release the enrollment as the original Linux user, remove the old workspace entry and
revoke its dedicated SSH key. Finish any setup or removal commands before the handoff
and keep the former account from starting another setup during it.

As root, confirm that `/var/lib/outpost-machine/machine.json` is absent. Transfer
ownership of `/var/lib/outpost-machine`, its `locks` directory and the existing
`*.lock` files inside it to the new Linux user. Keep the directories at mode 0700
and the lock files at 0600. Change ownership in place so the locks retain their
inodes. The former account keeps its own `~/.outpost` session history and files.
Add the machine from the new workspace and run setup as the new execution user.

#### Shared machine protocol

On SSH a login shell may print before the node starts. The node emits the marker
`\0OUTPOST-NODE-1\0` and a `hello` with its version and protocol. A machine
running an incompatible version is asked to update before any operation runs.
The required machine service version is defined in `shared/terminalService.ts`.

Frames are length-prefixed as everywhere in Outpost (one type byte, a 4-byte
big-endian length, the payload): `C` carries a JSON control message and `D`
stream data (a 4-byte stream number, then bytes). `shared/machine.ts` defines
the messages:

| Message | Direction | Meaning |
| --- | --- | --- |
| `hello {version, protocol, pid}` | node → server | Once, before anything else |
| `call {id, op, args}` / `result {id, ok, data \| error}` | both | A request and its answer. The server calls session, file, directory, search and history operations; the node calls `agent` for an agent's Outpost tool call |
| `open {stream, kind, args}` / `opened {stream, data}` | server → node / node → server | Open a `terminal`, `chat`, `file-read` or `file-receive` stream. A terminal image paste uses the terminal stream. |
| `close {stream, error?, data?}` | both | End a stream; a receiving node's final answer travels with it |
| `credit {stream, bytes}` | both | Grant the sender more of its 4 MiB stream window |
| `events` | node → server | The machine's event log grew; the server reads it with the `events` call |

Errors keep their HTTP status, so a missing session is still a 404 through the
connection. Calls have a deadline (30 seconds unless the operation sets one) and
can be cancelled. A stream's sender may have 4 MiB unacknowledged; the receiver
grants credit as it consumes, so a paused WebSocket stops its terminal stream
without stalling others. Losing the connection fails pending calls and streams.
With SSH, Outpost can open a new connection. With outbound enrollment, the machine
reconnects to Outpost. Terminal services and chat hosts run independently of the node,
so their agents keep running when the streams close.

Terminal and chat streams carry their driver's own protocol unchanged: the node
connects the stream to `~/.outpost/terminals/<id>.sock` or
`~/.outpost/chats/<id>.sock`, starting the driver first when the attachment
asks to. Closing a stream closes only that socket.

**Agents' tool calls.** The node also listens on `~/.outpost/run/node-<id>.sock`.
Its name is an HMAC of the server secret, account and machine. The host's
installation record pins that node identity. MCP clients read the installed
socket for server-backed operations, and the node checks that the calling
session exists in its registry. An agent can call `publish_file` locally even
while disconnected. Success confirms the stored snapshot. The machine sends a
best-effort notification to attached viewers. A viewer can fetch the bytes over
the attachment or discover the file on the next listing after reconnecting.

SSH setup can run shell commands before the machine service exists. Software
inspection loads the execution account’s login environment to find the same
tools as session launches. Installation runs noninteractively and reports
progress and verification errors. Subsequent machine operations use the node
protocol. On an outbound enrollment the operator supplies that first shell
on the machine.

SSH connection sharing is a backend transport policy. Linux and macOS backends
use owner/identity-scoped control sockets with a 120-second idle lifetime.
Windows backends always use independent connections: the transport explicitly
sets `ControlMaster=no`, `ControlPath=none` and `ControlPersist=no`, overriding
user SSH configuration. `OUTPOST_SSH_MULTIPLEX=0` applies the same policy on
other platforms. This depends on the backend host, not the desktop or SSH machine.
SSH keepalives (`ServerAliveInterval=15`, three misses) end a connection whose
network went away.

The transport supplies one alternate invocation without sharing when sharing is
enabled. Starting a node uses it when the first attempt exits 255 before the
node's marker, with no output and only recognized control-connection
diagnostics on stderr; starting a node twice is harmless. Read-only, buffered
software inspection uses it the same way. Mixed or unknown diagnostics prevent
retry, including authentication or configuration failures alongside an earlier
control-connection error. Both attempts share the original deadline,
cancellation signal, credentials and input bytes. Streamed installations never
retry. Recovery never kills a master or removes its socket, so other
connections are left alone.

`shared/node/terminalFrames.ts` owns encoding and incremental decoding for the
server, the node and the drivers. Framing validates the type and length before
accepting a payload; the connection owner interprets its controls.

### Persistent terminal service

`outpost-terminal serve` receives launch configuration on stdin, starts a PTY
with Bun's native terminal API, and runs a pinned `@xterm/headless` engine.
The node starts it detached, in its own process group, with its log in
`~/.outpost/logs/<id>.log` and no inherited connection stdio, so it outlives the node
and its connection. Each session has its own process; a failure cannot take
down every session. The service never needs Node or Bun installed separately on
the machine. Its socket is owner-only (mode 0600, in the owner-only state
directory): the machine's user account is the trust boundary. Besides viewers,
it answers one-shot requests on the same socket: `status`, `stop`,
`acknowledge`, hook events, `files` hints and signals.

The normal buffer retains the session’s negotiated scrollback in memory. There is no raw output journal,
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
additional viewers receive a transient error and retry. A 10,000-row snapshot at 400 columns
holds about 50 MiB of raw cells plus metadata. Larger Desktop histories grow with the number of retained rows.
Checkpoint schema 3 sends referenced hyperlinks in chunks and encodes each row's repeated final cell once,
preserving its character and style as well as combined characters and links.
`machine/attachment.ts` encodes and streams this immutable snapshot in
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

This contract uses the versions declared in `shared/terminalService.ts` and `shared/protocol.ts`.
Publish the matching Outpost machine service before deploying the server. Replacing the
executable does not alter a running PTY service: after a service protocol
change, existing sessions restart explicitly to use it.

The headless engine alone answers terminal queries, even when disconnected.
The browser forwards user input, mouse and focus events, suppressing duplicate
terminal-generated replies. Palette queries use the same shared terminal theme.
Resizing updates both engine geometry and the PTY, delivering normal SIGWINCH.
The coding tool runs under `setsid -c`, which starts a new session with the PTY
as its controlling terminal and its process group in the foreground. Bun's PTY
API assigns the PTY as stdio only, which establishes no foreground process group
and therefore cannot deliver resize signals. Bash then runs the launch script,
so the session's arguments keep their shell syntax. `setsid` does not remain as
a supervisor; the service retains the PTY master and its independent lifetime.
Ctrl+C and other application keys pass directly through the PTY.

The terminal service persists across client and Outpost server restarts and losses of the machine connection.
Its in-memory state and running processes do not survive a machine reboot or
service crash. Explicit **Stop coding tool** asks the driver to stop; if it does not
answer, the node ends its process tree, children first, after checking that the
PID still runs an Outpost driver. Updating the installed executable atomically
leaves already-running sessions alone.

### Building and installing the dependency

`shared/terminalService.ts` defines the executable version, service protocol,
and terminal bounds; the node protocol has its own version in
`shared/machine.ts`. The manual `.github/workflows/terminal.yml` builds baseline x86_64 and ARM64
binaries for glibc and musl, plus SHA256SUMS. Publishing creates an immutable
`terminal-v<version>` release. Both v3 enrollment methods use these same assets.
For SSH setup, the Outpost instance obtains the matching executable and checksum and
transfers them to the machine. For outbound setup, the machine fetches its installer
from Outpost. Setup checks SHA-256 and `--version` before renaming the verified
executable into `~/.outpost/bin/outpost-terminal`. Minimal musl installations
also require the system `libstdc++` package.

**Creation and forking** share the `creation` lock, serializing
allocations without blocking operations on existing sessions. Lock order is
creation → registry; other operations never take the creation lock. The
registry lock is held only to snapshot settings and to commit a new record;
Git and harness allocation run outside it. Registration re-reads the latest
registry and rechecks unique names and conversation identities, preserving
concurrent deletes and attachment timestamps. Each lock key has a private file in `~/.outpost/locks/`.
An exclusive SQLite transaction holds the lock across processes and async work.
Closing the connection or exiting the process releases the lock. Its file stays
in place so every contender uses the same inode.
Forking uses a snapshot of the source settings, so deleting the source record
during allocation does not cancel an already-started fork.

Retryable creates carry a request key scoped by the server to its deployment,
account and machine. The node hashes the creation input and commits a receipt
(`creation key → input fingerprint + session ID`) in the registry's `creations`
map in the same atomic write as the session. Replays under the creation lock
return the existing session; different input with the same key is rejected.
Receipts survive session deletion so a stale retry reports deletion instead of
recreating the session. Operations without a retry key allocate no receipt.
These small receipts contain hashes and IDs, not a second copy of session settings.

The node creates a new branch from the source directory’s `HEAD` with
`git worktree add -b`, then allocates a fresh harness conversation and saves
its session. It inherits the source tool and launch settings. Git receives
the branch and path as argument values; its failures stop before conversation
allocation or registration. If harness allocation fails after Git succeeds, the
error identifies the created worktree so it can be reused or removed manually.

### Shared session activity

A session's driver owns its activity: the terminal service for a terminal, the
chat host for a chat. The session list asks a running driver (its `status`
reply) and viewers receive `activity` messages as it changes; with no driver,
the last saved state is shown. `shared/activity.ts` defines `working | waiting |
idle | finished | error | unknown`, display labels, attention semantics, and the
bounded wire parser. `finished` means an unread completion; `waiting` means
native approval/input is required. Only completions are dismissible. Terminal
output rate, silence and keyboard input never infer whether the agent is working.

**Hooks.** Every terminal launch configures the tool's own lifecycle hooks to
run `outpost-terminal hook`, which passes only the fields activity reads
(`session_id`, `hook_event_name`, `agent_id`, `isSidechain`, `source`, `turn_id`,
`notification_type`, `is_interrupt`) to the session's terminal service. Hooks
never block or fail the tool: they emit no output or decisions, and a hook with
no running service does nothing. Each harness adapter (`machine/harnesses/`)
owns its native configuration:

- Claude uses invocation-only `--settings` hooks for selection, submission, tools,
  permission/elicitation waits, completion and failure. An interrupted tool means
  Idle; an ordinary tool failure leaves the turn Working.
- Codex uses invocation-only `-c` hooks. A short-lived app-server reads
  `hooks/list` to obtain the native identities and hashes, then the launch
  trusts exactly these generated commands. It does not change config.toml,
  grant blanket hook trust, start a thread, or invoke a model.
- Kimi uses an additive local plugin in its installed-plugin registry, preserving
  other entries and leaving config.toml alone. Its hooks only select the main
  conversation; they are inert outside an Outpost launch. Main-agent wire records
  determine state because Kimi's generic turn hooks do not reliably identify
  subagents. Pending interactions remain Waiting until all are resolved; failed
  turns become Error.
- Antigravity CLI uses an additive local plugin registered in `.gemini/config/plugins.json`,
  preserving user entries and `inherits`. Its camelCase hooks map root-conversation
  starts, invocations, tools, cancellations and errors, ignoring subagent hooks
  that carry no direct user input.
- DeepSeek Harness provides an ACP agent. Outpost renders its journal in either Chat or Terminal.

A failed hook setup is shown on the session and does not prevent the terminal
starting. Hooks use no model calls, additional context, prompts or MCP tools.

**Conversation identity.** SessionStart and prompt submission name the tool's
current native conversation. When it differs from the session's (the user ran
new, clear or resume inside the tool), it becomes the session's current
conversation in the session timeline; if another session held it, it moves
here and that session shows where it went. Later events from the conversation
left behind are ignored, as are subagent events and compaction's SessionStart.
Neither terminal text nor another conversation's modification time can select
a conversation.

**Transcripts.** The service also follows the current conversation's native
transcript, which the adapter locates inside the session's pinned store:
Claude's newest `projects/*/<id>.jsonl`, the rollout Codex's `state_5.sqlite`
names for the thread, Kimi's main-agent `wire.jsonl`, Antigravity's
`antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`. Paths that leave the
store or symlinks are not read. The first read walks backwards from the last
complete line to the newest state marker; later reads, every second, consume
only appended complete lines. A replaced or truncated file is read again from
its end. Records over 8 MiB are skipped in both directions. Claude orders by
native timestamp, because it can flush an older prompt after its reply; Kimi
keeps an approval Waiting until every open one is resolved; Codex's review mode
is Unknown until it exits.

**Precedence.** For Claude and Codex, hooks are the primary source. A newer
transcript end (idle, finished or error) in the same turn recovers a missed hook
only while the hooks still say Working or Waiting, so the transcript's late copy
of a reply already seen is not a new completion. For Kimi the transcript alone
determines state. A marker present at launch, or when the conversation changes,
is not new activity: an old reply counts as seen, an old prompt as Idle. When
the tool exits, Working and Waiting become Idle while an unread completion or
an error stays.

**Completions.** A completion's ID is a hash of the session, the conversation
and its source (the hook event or the transcript record). The driver saves the
last state and the IDs the user has seen (newest 64) in
`~/.outpost/activity/<session>.json`; that file is derived and holds no
conversation content. Typing into the terminal, sending a draft or a paste, and
an explicit acknowledgement mark the displayed completion seen; focus reports
and attaching do not. An acknowledgement names its completion, so an old one
cannot clear a newer completion. With no driver running, the saved unread
completion or error is still shown and can be acknowledged.

The terminal view acknowledges the displayed completion on activation or a local
interaction. Pending/confirmed IDs give immediate local feedback; a failed request
restores the notice, and connection generations discard old replies. Activation
before fresh metadata waits for a current observation. Stale completions are not
automatically acknowledged. Later completions require a new interaction.

The app and list share all states. Unknown has a diagnostic; `null` means no
observation yet. The clients render terminal bells independently of agent state. Local shell tabs have no coding-agent badge.

Tests in `tests/machine/activity.test.ts` drive the activity model with native
records and hook payloads. `OUTPOST_TEST_NATIVE_ACTIVITY=1 node --import tsx
--test tests/machine/native.test.ts` runs the installed Claude Code, Codex and
Kimi Code in disposable homes against a local HTTP model fixture, exercising
their real hooks and transcripts without paid model calls or touching the
user's native stores.

### Terminal search

`useTerminalSearch.ts` owns one `@xterm/addon-search` instance for each xterm
lifetime. `TerminalSearch` is an absolute overlay within `terminal-body`, so
search never changes terminal dimensions, sends PTY input, or fetches remote
history. It searches only xterm's active buffer, including retained scrollback.
`searchAddon.ts` adapts the pinned search addon 0.16.0: its stock 200 ms trailing
debounce can starve highlights during continuous TUI output, and its line cache
misses redraws that restore the cursor. The adapter invalidates cached text and
refreshes matches synchronously on xterm's coalesced `onWriteParsed` event and
resize. It retains cached immutable history and invalidates the mutable screen,
including a wrapped logical line starting in history. A history marker detects
trimming even when the 10,000-line limit leaves `baseY` unchanged; trimming,
reflow, buffer switches and direct replacement invalidate the cache completely.
Synchronized output spanning packets retains highlights with the painted frame
until xterm releases it, including its missing-end-sequence safety timeout.
It retains xterm's matching, Unicode handling, decorations and native
scrollback markers. Refresh uses the addon's no-scroll path, so background output
does not move the user's viewport. The narrow private addon surface is guarded
at initialization and covered by frame-level DOM/WebGL tests; replace this adapter
when upstream provides a public synchronous invalidate/refresh API.
Highlights are capped at 1,000 and the UI reports that bound rather than a misleading exact total.
Closing search clears decorations and restores terminal (or recovery) focus.
The query stays with its tab until that view is destroyed.

Browser search handles Cmd+F/Ctrl+F, toolbar and context-menu actions locally. The native workspace searches its own terminal buffer.

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
batches, so output written afterward is retained. `TerminalRenderer` reports
direct buffer changes after clear, local reset and completed remote checkpoint
restoration. Search invalidates cached lines and decorations at those barriers
too, without waiting for a later PTY write or scrolling to a result.

### Messages into terminals

A message for a session running in a terminal (from another session, a
channel or a schedule) goes to its terminal service, which types it in when
that cannot get in your way (`machine/delivery.ts`): the agent is idle, as its
hooks and transcript report; no viewer has a draft in the message box; no line
you started typing in the tool is unfinished (no Enter, Ctrl+C or Ctrl+U since);
and you have not typed for 3 seconds. The message is pasted (bracketed when the
program asked for that) under its `[Outpost: …]` header, then Enter follows on
its own; keys you press meanwhile wait until after it. One message goes in at a
time. Its turn ending returns the agent's last transcript message as the reply;
an interrupted or failed turn, or one that never starts within a minute, fails
it with a notice. A session can hold messages instead (**Edit session**): they
wait, the terminal shows how many, and **Deliver now** types the next one in once
the agent is idle. The queue is kept in `~/.outpost/deliveries/<session>.json`
and keyed by the server's delivery, so a resend after a reconnect or restart
changes nothing; the server checks on typed messages through the node until
they settle.

Claude Code's channels could carry these natively, but a channel Outpost
provides loads only with `--dangerously-load-development-channels`, which asks
for confirmation at every start, and an unregistered channel drops messages
without any error. Outpost types messages in for every tool instead.

### Signals

Coding sessions run with `BROWSER=~/.outpost/bin/outpost-browser`, a wrapper for
`outpost-terminal open URL`. It sends the signal to the session's terminal
service, which forwards it to its most recently attached viewer and waits up to
12 seconds for that viewer's answer. The broker validates the signal
(`browser.open` accepts only `http(s)` URLs without credentials) and passes it
to the client, which opens the link on your computer. Delivery is at most once.
With no attached terminal, the helper fails with a clear message.

### Session files

`machine/files.ts` owns immutable session files in
`~/.outpost/files/<session>/<file-id>/`, in both directions: files the agent
publishes for the user (`source: published`) and files sent to the agent in a
message (`source: received`). Each holds `metadata.json` beside
`content/<name>`, so the agent's own tools see the real filename. Storing copies
to a private temporary directory, checks the size (and, when publishing, that
the source did not change), then publishes content and metadata together by
atomic rename. Per-session locks serialize quota checks and removal without
holding the session registry lock through file transfer. Limits are 32 MiB per
file and 100 files / 256 MiB per managed session. File IDs are random
identifiers; clients never provide remote filesystem paths for download or
removal. A `file-receive` stream stores exactly the declared number of bytes;
a `file-read` stream sends one file's metadata, then its bytes. Removing a file
leaves its source alone; deleting a managed session removes its store.

### Outpost MCP

Every launch, whichever driver (terminal or chat) and harness runs it, gets
Outpost's server and the session's own MCP servers from `machine/launch.ts`, as
neutral descriptors: `Launch.outpost` (`{name, command, args, env}`) and
`Launch.servers` (the same, or `{name, url, headers}` for streamable HTTP). The
session's servers come from its configuration's `mcpServers`, in the common
`mcpServers` format; the name `outpost` is reserved. Outpost's server is
`outpost-terminal mcp`, speaking MCP 2025-06-18 over stdio. Its binding
is the launch's environment: `OUTPOST_SESSION_ID`, `OUTPOST_STATE_DIRECTORY` and
`OUTPOST_DRIVER`. The launcher sets it, also in the coding tool's own
environment, and a tool call can never select a session. A process with no
binding lists no tools; a partial or invalid binding fails closed.

`machine/mcp.ts` exposes the same tool registry to bound terminal and Chat
sessions. The machine handles `publish_file` locally, even while disconnected.
For every server-backed call, the MCP process reads the machine's current
enrollment and sends the bound session ID and request to its node socket.
The node carries the call over the machine connection. This works for both
SSH and outbound enrollment.

The server answers history searches, `list_machines` and `list_sessions`.
Each account opens its SQLite history index in a dedicated worker on first use.
Catalog pages and message batches cross the worker boundary together, so a
busy index leaves the server event loop available for terminal traffic. In the
same transaction as each message change, the index updates the machine's
references to its text chunks. A durable queue prioritizes a representative
chunk from each conversation. Machines sharing a chunk in an account share
its vector. Workers use one server-local embedding model.
`message_session` returns immediately and the reply arrives as a new message.
`post_to_channel` posts to a channel the session belongs to. `fetch_file`
copies another session's file into this one and returns its local path.
Messages and posts share a limit of 20 per minute per session, and a thread
between sessions allows 6 messages. `outpost publish FILE` publishes from
any shell in a managed session.

Adapters only translate the descriptors into their tool's native form; they
never construct Outpost's server:

- **Codex:** invocation-only `-c mcp_servers.<name>={command, args, env}` or
  `{url, http_headers}`.
- **Claude:** invocation-only `--mcp-config` JSON with `stdio` and `http`
  servers. The native conversation selector follows integration options so the
  variadic MCP flag cannot consume a prompt.
- **Chat (all harnesses):** the same servers as ACP `mcpServers` on
  `session/new` and `session/load` (`chatServers`).
- **Kimi Code:** one Outpost plugin declares both activity hooks and Outpost's
  server, for terminal and chat alike (Kimi has no invocation-only option, so
  its chat passes only the session's servers over ACP, and its terminals get
  none of them). The plugin contains no session IDs: each
  server process inherits its Kimi process's binding. Installation is atomic,
  idempotent, and preserves plugin order, unrelated records and per-server
  preferences. Only a missing registry is initialized; malformed registry data
  is rejected. Plugin commands must be names on the PATH, so the plugin runs
  `env` with the exact `outpost-terminal` path. An ordinary Kimi launch loads
  the installed plugin with no binding and sees no Outpost tools.
- **Antigravity CLI:** one Outpost plugin in `~/.outpost/integrations/antigravity/outpost/`
  registered in `.gemini/config/plugins.json` declares activity hooks and
  Outpost's server for terminal launches (`agy acp` does not load plugin MCP
  servers, so chat passes Outpost's server and the session's `stdio` and `http`
  servers over ACP). `outpost-terminal agent antigravity` pins `--gemini-dir`
  and maps ACP `systemPrompt` append onto `_meta.antigravity.systemPrompt`.

Native configuration references: [Claude MCP](https://code.claude.com/docs/en/mcp),
[Kimi plugin MCP servers](https://moonshotai.github.io/kimi-code/en/customization/plugins.html#mcp-servers-in-plugins)
and [Antigravity CLI plugins](https://antigravity.google/docs/plugins).

The rest of a session's launch settings take the same route (`settings` in
the adapter): its instructions as Claude's `--append-system-prompt` or Codex's
`-c developer_instructions`, and its model as `--model` or `-c model`.
`instructions` and `servers` in `shared/harnesses.ts` say where each applies,
which the UI shows. The chat host selects the model and mode over ACP (see
[CHAT.md](CHAT.md)).

MCP configuration is additive; Codex/Claude user configuration and Kimi's
`config.toml` and `mcp.json` are not rewritten. Harness-specific flags, plugin
formats and lifecycle setup live in each adapter in `machine/harnesses/`;
shared code contains no harness dispatch. A running agent keeps the
integration it started with.

Terminal file requests are scoped to the attached viewer. Chat downloads use
the chat page’s grant and the server’s session file client. The server limits
concurrent chat downloads to two per owner and four in total.

After committing a file, the MCP server sends the session's driver a
best-effort hint, which the driver passes to its viewers.
The broker validates it and broadcasts to every viewer of that owner's machine
and managed session. The receipt means **stored**, not delivered to a viewer.
The files themselves are durable; they can be published with no attached client.
Clients load the list on connection, refresh on hints and visibility changes,
and reconcile every 30 seconds while connected to recover lost hints. Removal
also broadcasts a refresh. Changing the terminal attachment cancels its outstanding requests.

`TerminalFiles` owns the dropdown. `useSessionFiles` reconciles metadata and owns
download/removal actions for the browser dropdown and viewer. `FileViewer`
is shared UI: a window-filling modal with filename, timestamp and size, download
and remove actions, previous/next buttons, arrow-key cycling and Escape to close.
It follows file identity across refreshes; removing the selected file advances
to its neighbor. Only signature-detected PNG/JPEG/GIF/WebP files are rendered in
an image element. Other formats show an unsupported-preview message with the
same actions. No file content is interpreted as HTML or executable code.

`SessionFileCache` is a session-scoped LRU with a 64 MiB original-byte budget.
Pending reads are deduplicated and serialized; errors are evicted for retry.
The dropdown's lazy thumbnails, full previews and downloads reuse those bytes.
`SessionFiles` retains generated thumbnails separately, bounded to 4 MiB; image
decoding is serialized and each bitmap is closed. `useFileImage` owns only the
displayed object URL and revokes it on replacement/unmount. Closing the dropdown
or viewer keeps cached bytes, so reopening normally needs no content transfer.
Metadata refreshes do not invalidate immutable file content. Removal and list
reconciliation evict missing files; leaving the session clears its cache. LRU
eviction or a new client/session scope can require another download. Budgets cover
cached blobs; actively displayed images and in-flight transfers also use memory.
HTTP responses remain `no-store`, and authorization never enters a download URL.

Browser caches live with the mounted terminal. The native session helper reads files over its pane’s attached socket.

## Desktop shell and OS integration

The `v3` desktop executable in `desktop/native/` owns GPUI windows, tabs,
nested pane layouts and the Alacritty grids. Each local pane owns a native
PTY, a shell process and bounded I/O queues. Moving a pane moves its existing
GPUI entity. Closing its last owner releases the PTY. Managed session panes
attach to the same broker and terminal service as the browser.

`desktop/src/native-helper.ts` runs in one bundled Node process per profile.
It reuses the V3 TypeScript account, first-use trust, session discovery,
creation and WebSocket clients. The GUI exchanges events and requests over
private child-process pipes. The helper stores server logins separately from
recent session references and presentation preferences. Browser authorization
returns through the registered `outpost://`
handler. On platforms that launch a second process, the profile lock and a
per-run secret route links to the owner of the sign-in verifier.

The machine's versioned cell checkpoints are decoded in a temporary headless
xterm grid. The helper translates the normal and alternate buffers, palette,
margins, cursor, hyperlinks and input modes to the native terminal. After the
checkpoint the temporary grid is disposed. Live bytes go directly to
Alacritty. The native client acknowledges output after applying it. Local PTY
programs receive terminal replies locally. Managed programs receive replies
from the terminal service on the machine.

A local shell starts after its pane measures the grid. Browser and Desktop
use the measured grid for the first managed attachment and retain it for
reconnects. Desktop reveals the restored screen once the checkpoint is complete.

A split pane's title is a drag handle. The zoom, actions and close buttons
have separate hit targets. Dragging transfers the existing terminal and its
draft when the pointer is released. Closing a pane, tab or window confirms
the affected terminals and keeps any sessions on their machines running.

The UI preserves the black title bar, shell tabs, splits and server launcher.
On Windows, the tab strip supplies the native caption hit targets for dragging,
snapping and window controls. The executable and installer share the Outpost icon.
The **Machines ↗** action opens the signed-in server’s machine workspace in the system browser. `desktop/scripts/package.mjs`
builds the macOS bundle, DMG and ZIP or the Windows per-user installer with
the executable, session helper, Node runtime and third-party notices.

## Outpost Chat

A managed session has one running coding agent. The machine serializes the first start and routes each subsequent attachment to that agent. A native CLI accepts ordinary terminal viewers. Chat subscribes to its committed conversation records and delivers prompts through its durable terminal queue. An ACP agent receives both views through its chat host. Terminal renders its journal as an interactive transcript and submits responses to the host’s pending approvals.

In v3 the server delivers channel mentions, session messages and schedules over either enrolled connection. Delivery requires a running Outpost instance and a reachable recipient. A hosted server can open SSH for a scheduled prompt while the user's laptop is asleep. [Outpost Chat](CHAT.md)

## Cross-machine history

The built-in Outpost MCP registers `search_history`, `read_context`,
`read_message`, `get_session` and `refresh_index` alongside `publish_file`.
`shared/historyTools.json` is the single tool/schema definition used by the
server and the MCP server. In v3, history indexing and machine activity collection can use either connection method. Fresh reads need a reachable machine. Unmanaged CLI launches expose no Outpost tools.

`backend/history/` owns an account-private SQLite index, local multilingual
embeddings and background backfill. It reads each machine through its machine
connection (`history.catalog`, `history.read`, `history.message`), and agents'
history tool calls arrive on the same connections. `Deployment.historyOwners()`
supplies verified owners without history code branching on deployment mode.
Calls enumerate the owner's current workspace each time, so removed machines and
other accounts cannot be read through cached results or cursors. Offline
machines retain explicitly identified cached history. The embedding model is
shared; conversation indexes are not.

History reads use the harness adapters' native-store readers on the machine
(`machine/history.ts`). Catalog pages include normal/archived Codex rollouts,
Claude transcripts and subagents, Kimi agents and DeepSeek generations. Byte
checkpoints, prefix/tail fingerprints and generations distinguish append from
common rewrite/truncation cases; incomplete final records wait for a later
append. Native configuration records are not indexed as conversation messages.
Original transcripts remain read-only.

**Lineage.** Every message has a logical identity: the tool's own ID where its
store has one (Claude Code's `uuid`, Codex's item `id`), otherwise a hash of the
message chained to the previous one's identity, carried across reads in the
checkpoint. A fork or continuation copies messages with their IDs, so the index
links a conversation to the one it continues: the one the tool names
(`forked_from_id` in Codex), or else the conversation where its first message
appears but not at the start (where that message first appeared), then the
oldest. The fork point is the last of its leading messages the parent also
has. Messages up to it are copies: search reports each logical message once,
where it began, with the copies as `alsoIn`; `read_context` lists branches at a
fork point and the origin of a branch. Summaries (Claude Code's compact summary,
Codex's `compacted` items) mark compactions: earlier messages are flagged as
before a compaction, and a summary is searched only when its conversation has
nothing before it. The fixtures in `tests/fixtures/history/` follow the tools'
own record shapes; an unrecognized record has no messages rather than failing
the read.

The server deduplicates documents and overlapping chunks, uses FTS5 trigram
lookup for literal/keyword candidates and sqlite-vec cosine distance for semantic
candidates, then combines ranks for mixed search. Results retain physical
machine/tool/session attribution. Short transactions yield during backfill, and
file checkpoints advance only after their complete batches are durable.
Account-signed cursors page through bounded context and message reads. Large
message tails can be read online after verifying their full content hash.
Each source stays a physical file; lineage links them, never merges them.

The pinned quantized multilingual model runs on CPU, with two inference threads;
its cache is below the server's data directory. Server installations should
allow at least 2 GiB of memory for inference and concurrent terminal/chat work.
Indexing and vector coverage are reported independently; incomplete or offline
history must never be presented as an exhaustive search. Historical text is
untrusted data, never instructions for the current session.

## Coding harnesses

`shared/harnesses.ts` lists harnesses for the UI and validation (id, label,
command, installer, native ID pattern, storage variable, and where session
instructions and MCP servers apply).
`machine/harnesses/harness.ts` defines the adapter contract, one class per
harness: its native store (discovery, search text, transcripts, titles,
history messages), conversation allocation, activity markers, launch arguments
(resume, MCP servers, instructions and model, hooks) and how the tool serves ACP for chat (`chat`,
`chatResumable`, `chatServers`). Session records pin the storage directory, and
their timeline names the native conversations, so a session resumes its
current conversation.

## Machine state

| Data | Location |
| --- | --- |
| Session registry | `~/.outpost/registry.json` |
| Locks | `~/.outpost/locks/<name>.lock` |
| Installed owner and node endpoint | `/var/lib/outpost-machine/machine.json`, `~/.outpost/run/node-<id>.sock` |
| Terminal services and chat hosts | `~/.outpost/terminals/<session>.sock`, `~/.outpost/chats/<session>.sock`, logs in `~/.outpost/logs/` |
| Activity | `~/.outpost/activity/<session>.json` |
| Messages waiting for a terminal | `~/.outpost/deliveries/<session>.json` |
| Event log (activity changes, driver starts and exits) | `~/.outpost/events/events.ndjson`, rotated once at 4 MiB to `events.1.ndjson` |
| Image file-path pastes (explicit and fallback) | `~/.outpost/clipboard/<session>/` (newest 20) |
| Session files | `~/.outpost/files/<session>/<file-id>/` (`metadata.json`, `content/<name>`) |
| Kimi Code plugin | `~/.outpost/integrations/kimi/` |
| Antigravity CLI plugin | `~/.outpost/integrations/antigravity/` |
| Claude Code chat adapter | `~/.outpost/agents/claude-agent-acp-<version>/`, linked from `~/.outpost/bin/` |
| Outpost machine service and helpers | `~/.outpost/bin/` |

A session record holds its name, tool, directory, pinned native store, its
configuration (instructions, model, mode, MCP servers, arguments and
environment, with a revision that changes only when one of them does)
and its conversation timeline; the last conversation is current, and one that
another session resumed names where it moved. Every registry write holds the
registry lock and replaces the file atomically. Records are validated
strictly; invalid data is reported, never rewritten. Outpost reads only its
current workspace and registry schemas. A missing current file starts an empty
store; there is no automatic import of earlier layouts.

## Activity log

`backend/logs/` keeps each account's activity log in one stream of an embedded
[log-viewer](https://github.com/KevinWang15/log-viewer), mounted at
`/log-viewer` and spooled to `<data>/logs/`. The stream is named by an HMAC of
the server secret and account. Events (`shared/logs.ts`) have a kind, a type, a
level, a sentence and fields; the viewer shows the kind as the logger, the
machine as the thread, and the rest as structured fields.

- **On machines**, `saveActivity` records each change of a session's state, and
  terminal services and chat hosts record their starts and exits
  (`machine/events.ts`). Each driver appends whole lines; the node serves them
  by cursor (`events` call, `inode:offset`) and announces growth with an
  `events` frame. The server reads after every connection, on every
  announcement, and once a minute for each machine of `backgroundOwners()`,
  saving each machine's cursor in the account's `log-cursors.json`. A first
  read starts at the end, so a new server does not replay a machine's history;
  later reads catch up with what happened while it was away, at the time it
  happened there. A machine that stops answering is logged once, and again when
  it answers.
- **On the server**, the chat hub logs posts and each delivery's progress, the
  session service wrapper (`backend/logs/sessions.ts`) logs creations, edits,
  conversation changes and deletions, routes log machine changes, installations
  log their start and outcome, and the broker logs terminal connections.

The viewer authorizes every request itself: an account reads and keeps filters
and bookmarks on its own stream only, and every `open`, `ingest` and `configure`
action is refused, so no one can write to a log, open files, or create the
viewer's own rule webhooks. HTTP requests pass the app's admission checks and
are handed to the viewer without body parsing; `/log-viewer/ws` upgrades are
routed to the viewer before Fastify's WebSocket plugin sees them. Its pages may
be framed only by Outpost's own Logs page, which embeds `embed.html` and sets
its filter over the `postMessage` bridge.

**Webhooks** (`backend/logs/webhooks.ts`) are stored per account in
`webhooks.json`. Each event that matches a webhook's kinds and level is queued
for it (at most 200 waiting, oldest dropped) and sent one at a time as a POST
with Outpost's JSON body and the owner's headers. Network errors, 429 and 5xx
are retried after 2, 15 and 60 seconds; other answers are final, and redirects
are not followed. A webhook that starts failing, and one that delivers again,
is logged as a `webhook` event that is not sent to that webhook. A hosted server resolves the address first,
refuses loopback, private, link-local and other non-public addresses, and
connects to the address it checked.

## Security model

- Local mode accepts only loopback connections with loopback `Host` headers.
  Hosted mode requires HTTPS, verified accounts and same-origin requests.
- Mutating requests require `X-Outpost-Request: 1`; browser origins are
  checked; tokens are HMAC-signed with the installation secret.
- Hosted SSH uses only the account's key and known-hosts file (`-F none`, no
  agent). Connection multiplexing sockets are scoped per owner and identity.
- An SSH enrollment never initiates an Outpost connection from the machine. An outbound enrollment requires an operator to redeem a single-use code. Its machine credential authorizes Outpost operations for that enrollment. Revocation closes the connection and prevents reconnection. [Enrollment security](../SECURITY.md#remote-machine-enrollment-in-v3)
- Desktop confirms unknown server origins before contacting them. It accepts
  HTTPS and loopback HTTP. Signing out removes saved trust, the local login and
  that server's sessions from Desktop and requests token revocation.
- The Linux execution account owns Outpost's private files and sockets.
  Processes running as that account can use them. Agent tool calls use the
  caller's bound session ID and travel through the current machine enrollment.
  Outpost checks the caller before serving the request.
- Images are limited to 16 MB, signals to 32 KiB and 120 per minute per
  connection, clipboard text to 1 MiB.
- Each account can read its own activity log and configure webhooks for event
  delivery. A hosted server sends webhook events only to public addresses.

## Extending Outpost

**Add a desktop capability.** Implement workspace controls in GPUI. Route session operations through the native helper and the shared terminal protocol.

**Add a coding harness.** Add an entry to `shared/harnesses.ts`, then a
`Harness` subclass in `machine/harnesses/<id>.ts`, registered in
`machine/harnesses/index.ts`. Implement it with that harness's native
interfaces; shared machine code must not branch on harness names.

The DeepSeek adapter uses `command: dsh` independently of its `deepseek` harness
ID, with `DSH_HOME` pinned per session. Its official package exposes ACP. Outpost starts the ACP host for either view
and serves its interactive transcript to web and desktop terminals. `outpost-terminal agent
deepseek` (`machine/agents/deepseek.ts`) maps the chat host's `session/load` to
the advertised `session/resume`, forwarding all other requests, permissions,
updates and invocation-scoped MCP descriptors. It does not add replay or
system-prompt capabilities the native server lacks.

Native DeepSeek session stores select the highest JSONL generation per session,
including `.jsonl.zstd`. The adapter's `historyBytes` decodes a file with the
runtime's built-in Zstandard decoder, frame by frame, so a truncated final frame
waits for its append; search reads the same decoded records. Checkpoints use
decoded byte positions, so added frames retain cursors. The other stores are
read as plain files.

**Add an Outpost MCP tool.** Register the tool in `machine/mcp.ts` for terminal
and Chat sessions. Supply instructions if the agent needs them. Server-backed
tools use the machine's enrolled node and the caller's session binding.

**Add a signal type.** Define a validator in `shared/signals.ts`, allow it in
the broker, and handle it in the shared client, delegating native actions through the bridge.

## Verification

The table describes the existing test suites. The connectivity refactor also has [acceptance criteria for both enrollment methods](V3.md#acceptance-criteria).

| Layer | Tests |
| --- | --- |
| Machine | `tests/machine/` — the machine's modules in a disposable state directory: registry, creation receipts, forks, edits and switching, images, activity from hooks and transcripts, native stores and history reads, DeepSeek decoding, store readers, locks; opt-in real Claude Code, Codex and Kimi Code hooks |
| Server | `tests/unit/` — tokens, workspace, API validation and network policy, hosted isolation and revocation, the machine connection against a fake node, the broker against a fake terminal stream, contracts |
| Whole path | `tests/integration/` — local machines over WebSocket; SSH in Docker with the built service in both modes; conversation discovery and history over real machine connections; chat through the node |
| Browser | `tests/browser/` exercises machine setup, sessions, web terminals and the Desktop session handoff against a real backend. It also covers phone layout, WebGL rendering, clipboard copying and GPU context loss. |
| Mobile browser | `tests/browser/mobile/` via `npm run test:mobile` — Chromium phone and WebKit phone/tablet: touch controls, viewport changes, copy/paste, notifications, and resume; real PTY input and resize coverage |
| Native desktop | `npm run test:desktop` exercises V3 restore, reconnect and layout logic. `npm --prefix desktop run test:ui` exercises GPUI controls, native shell I/O and moving a live pane across windows. |
| Chat | `tests/unit/chat-*.test.ts` (journal, transcript, mentions, cron and prompts); `tests/integration/node-chat.test.ts` (chat host through the node: conversation timeline, one driver, Outpost tools, files, queue, DeepSeek and Kimi); `tests/integration/chat.test.ts` (hub with real chat hosts: channels, floor passing, session messages, schedules); `tests/browser/chat.spec.ts`. A scripted ACP agent (`tests/fixtures/acp-agent-fixture.py`) stands in for the tools; no model is called |
| Desktop packaging | Manual `desktop.yml` workflow builds macOS arm64/x64 and Windows x64 installers; OS integration still needs native manual verification |

Mobile automation uses real browser engines with emulated device sizes. Android swipes use Chromium's trusted
touch input; WebKit swipe routing and keyboard occlusion use synthetic touch/VisualViewport events because
the headless port cannot open a phone keyboard. Notification tests cover permission/setup failures and
cleanup races with browser API doubles, plus actual worker activation in both engines and notification
registration in Chromium. They do not prove physical iOS selection handles, OS banners, Home Screen installation, or
background suspension behavior. Those still need a physical iPhone/iPad and Android device check.

Browser and machine tests compare the PNG read by a headless clipboard
consumer and verify its single paste keystroke. ACP tests check image content,
draft removal and explicit submission. The native macOS workspace test checks
text paste and raw Ctrl+V using a real local PTY.