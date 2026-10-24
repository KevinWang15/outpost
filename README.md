# Outpost

![Outpost — keep the session, keep your flow.](docs/images/banner.png)

Outpost keeps your **Claude Code, Codex and Kimi Code** sessions running in persistent terminals
on your Linux machines, and lets you come back to them from your browser or
Outpost Desktop — with paste, copy, Shift+Enter and links working as if
the agent ran on your computer.

- **One Connect button.** Choose the web terminal or Outpost Desktop for macOS and Windows. Both share the terminal UI and connection path.
- **Feels native.** Paste screenshots with your normal paste shortcut and the agent receives the image. Shift+Enter inserts a newline. Text the agent copies lands on your clipboard. Links it opens open in your browser.
- **Managed sessions outlive connections.** Close the tab or lose Wi-Fi; the agent keeps working. Reconnect from any computer or your phone, to the same process.
- **Local terminals, too.** Outpost Desktop opens your local shell alongside managed sessions, with shared tabs, splits and clipboard controls. Local tabs work offline and end when closed.
- **Local tool or hosted service.** Run it on your own computer with your SSH config, or host it for a team with accounts and per-user SSH keys.
- **Know what needs you.** Each session shows whether the agent is working, idle, or finished a turn you haven't seen.
- **Find any conversation.** Search the history on a target, including conversations started outside Outpost, and resume them as sessions.

![The Outpost workspace: a target with three sessions and their activity](docs/images/workspace.png)

## Requirements

| Where | What you need |
| --- | --- |
| Targets — where sessions run | Linux with Bash, Python 3.9+ and Outpost Terminal, reachable over SSH as root. The computer running Outpost can be a target too when it runs Linux (including WSL). Outpost can install missing software for you. |
| Outpost server | Node.js 24+ and OpenSSH, on Linux, WSL or macOS. |
| Web terminal | Any current browser, including on phones. |
| Outpost Desktop | macOS (Apple silicon or Intel) or Windows x64. Bundles Electron; no browser, Python or WSL installation needed. |

## Run the local tool

```sh
npm ci
npm run build
npm start          # http://127.0.0.1:3000
```

For development, `npm run dev` serves the UI at http://127.0.0.1:5173 with hot reload.

Local mode needs no account and accepts connections only from this computer.
SSH targets use your own OpenSSH configuration, agent and keys. Data lives in
`~/.outpost` (set `OUTPOST_DATA_DIR` to change it). On Windows, run Outpost
inside WSL and open http://localhost:3000 in your Windows browser: in WSL,
Outpost listens on all interfaces so Windows' localhost forwarding reaches it,
and still accepts only connections that arrive through localhost.

To use Outpost running on another machine, forward its port to the **same**
port locally (`ssh -L 3000:127.0.0.1:3000 that-machine`) and open
http://127.0.0.1:3000.

## Fork a session

Choose **Fork** in a session’s **…** menu to create a new Git branch and
worktree on the same target. A branch such as `feature/new-login` suggests
`/path/project-feature-new-login`; you can edit the path or restore the
suggestion. The branch starts at the source directory’s current commit,
leaving uncommitted changes in the source.

Only after Git succeeds does Outpost create a fresh conversation, using the
source session’s coding tool, arguments, and environment. The new session is
named after the branch and starts when you connect. Git must be installed on
the target; invalid repositories, existing branches, and existing destination
paths produce an error without creating a session.

## Connect

Click **Connect** next to a session and choose a terminal. Check **Remember my
choice** first to open that terminal directly on future connections. This applies
to all sessions on this Outpost server in the current browser. Remembered
connections skip the dialog, including desktop opening and success messages;
the dialog returns if opening fails or takes longer than six seconds. To change it or
show the chooser again, open **Connection preferences** in the sidebar, choose a
terminal or **Ask every time**, and save. This preference does not change login
or desktop server trust requirements.

| Choice | Opens in | Installation | Authorization |
| --- | --- | --- | --- |
| Web terminal | A regular browser window; also works on phones | None | Your Outpost browser login requests a session ticket |
| Outpost Desktop | An Electron window with its own Outpost Dock/taskbar identity | Outpost Desktop | Transfers a session ticket from your signed-in browser; no second login |

Every choice attaches to the same persistent session. Closing a client disconnects
it; the coding session keeps running. You can change clients later.

Desktop Connect brings the app forward and selects the session's tab. If that
session is already open from the same browser login, its existing tab is reused,
including its draft and live connection. Keep Outpost Desktop and your server
updated together; an incompatible terminal interface shows an update message.

### Web terminal

Opens full-window in the browser. Paste images with your normal paste shortcut,
drop them onto the terminal, or use the image button. On phones, an on-screen
key bar (Esc, Tab, Ctrl, Alt, arrows, ⇧↩, ^C) and a message box are shown. Dropped connections reconnect by
themselves.

Both the web terminal and Outpost Desktop keep retrying through long outages,
with pauses between attempts. Returning online or waking a laptop checks the
connection immediately; Desktop also checks remote tabs in background windows.
Recovery restores the running session, its saved screen/history and current size,
and keeps unsent message drafts. It never automatically resends input or image
pastes. If delivery was interrupted, check the terminal before sending again.
If the tool exited while you were away, choose **Reconnect** to start it again.
Expired or revoked credentials require a fresh **Connect** from Outpost.

#### Phones and tablets

Open your hosted Outpost address in the phone's browser and choose **Connect →
Web terminal**. The terminal and its controls follow the visible area above the
keyboard. Use the message box for longer prompts; **Send** keeps the keyboard
open and clears an unchanged draft only after delivery is confirmed; edits made
while waiting are kept. **Keyboard** in the
key bar shows or hides the keyboard for direct terminal input. Swipe the key bar
sideways to reach the other keys.

Swipe vertically over terminal output to send the same scrolling gesture as a
mouse wheel. The application decides what that does; it does not pause remote output or add a history buffer. **Select text** in the key bar or context menu
opens a copy of the text currently on screen, where the phone's normal text
selection handles work. Use **Copy selection** or **Copy all**, then **Done** to
return. This does not pause the running session or retrieve older output.

Use the image button to choose a supported image from your phone. If clipboard
paste is blocked, touch and hold the message box and use the browser's Paste
command. Status and error messages remain visible on small screens.

When you return from another app or the network comes back, Outpost checks the
connection and reconnects if needed. It does not resend prompts automatically.
An expired login or a deliberately ended session still requires an
explicit connection. Your remote coding process continues while the phone is
away.

For iPhone/iPad notifications, use **Share → Add to Home Screen**, open Outpost
from that icon, connect with **Web terminal**, and tap the bell to allow
notifications. Android browsers with notification support can use the bell
directly. Home Screen web apps keep terminal navigation inside the app.
**Notifications require HTTPS and a running terminal page.** There is no
background push delivery while the browser is suspended or closed, and no offline
terminal. The notification button reports permission; browser/OS notification
settings still control whether an alert is displayed.

#### Keyboard, clipboard, and history

On macOS, **Ctrl+V** also pastes an image or text with the terminal focused,
in both the browser and Outpost Desktop. **Command+V** continues to work.
The browser may ask for clipboard permission for Ctrl+V; if access is blocked,
use Command+V instead.

Use **Hide terminal toolbar** for more screen space. In the browser, the small
button at the top right restores it; in Outpost Desktop, right-click the terminal
and enable **Terminal toolbar**. This preference is shared by both clients.
Connection errors, link prompts and bell notices remain visible while the toolbar
is hidden.

Right-click the terminal (or press **Shift+F10** / the **Menu** key) for **Copy**,
**Paste**, **Select all**, image upload, and toggles for the toolbar, message box
and on-screen keys. This menu is shared by the web terminal and Outpost Desktop
on macOS and Windows. Copy uses the terminal selection; Select all selects
output currently loaded in the terminal, not the entire remote conversation.
Browser clipboard access may ask for permission; if Paste is blocked, use your
normal paste shortcut. The message box keeps its usual text-editing menu.

Attach images directly in the terminal: paste from the clipboard, drop a file
onto the terminal, or use the image button (also available in the context menu).
PNG, JPEG, GIF and WebP images up to 16 MB are supported. Outpost saves the image
on the session's machine and pastes its reference into the current prompt;
press Enter when you are ready to send. Uploads run separately from terminal
input and are cancelled if the connection drops. Local shell tabs save images
on your own computer.

Press **Cmd+F** on macOS or **Ctrl+F** on Windows/Linux to find text in the
current terminal. The search box floats at the top-right without resizing the
terminal. Matches are highlighted with a result count; **Enter** goes to the
next match, **Shift+Enter** to the previous one, and **Esc** closes search and
returns focus to the terminal. **Aa** toggles case sensitivity. Search is also
available from the terminal toolbar and right-click menu, and **Edit → Find in
terminal** in the desktop app. Web, remote desktop, and local shell tabs share
this feature. It searches the screen and scrollback currently held by xterm,
not files or output that has already left the buffer.
Highlights update with terminal output, including applications that redraw their
screen to scroll their own history. That history is searchable as the application
displays it; Outpost cannot search content the application has not sent to xterm.

Text selection is local to the terminal and copies when you release the mouse.
It does not pause the remote display. Applications that
request mouse events receive them normally; to select text locally in such an
application, hold **Shift** while dragging on Windows/Linux or **Option** on
macOS. You can also use **Copy** from the context menu or your usual copy shortcut.

The terminal retains up to **10,000 lines of scrollback in memory**, including
output produced while you are disconnected. Reconnecting restores that history,
the screen and terminal modes. The existing scrollbar browses actual local
terminal history; selecting text does not freeze the process. Screen clearing,
explicit scrollback clearing, and alternate-screen applications follow normal
terminal semantics. Full-screen applications can still provide their own
conversation/history viewer. Outpost does not force Codex into inline mode.

The target must stay running: this preserves sessions across browser, app, SSH,
and Outpost server disconnects/restarts, not target reboots or terminal-service
crashes. Closing a tab disconnects; **Terminate** explicitly stops the session.

When the coding tool rings the terminal bell, the page and tab title show
which session rang, and a short chime plays. Click or type in the terminal
once to enable sound. Bells received while you are away stay marked until
you return; repeated bells are limited to one chime per second.

Click the bell button in the terminal toolbar to enable notifications,
then allow notifications in your browser. On Windows and macOS, bells also show
a system notification while the terminal is in the background. Clicking it
returns to the terminal; repeated bells produce one notification until you
return. This requires HTTPS (or localhost) and an open terminal tab. If alerts
do not appear, check the browser's site permissions and
[Windows notification settings](https://support.microsoft.com/en-us/windows/experience/notifications-and-do-not-disturb-in-windows)
or [macOS System Settings → Notifications](https://support.apple.com/guide/safari/sfri40734/mac),
including Focus / Do Not Disturb. Disable notifications through your browser's
site settings.

If a browser permission prompt is hidden, open the site controls beside the
address bar and allow Notifications. The terminal refreshes permission when
you return to it.

![The web terminal](docs/images/web-terminal.png)

### Session files

Managed Codex, Claude Code and Kimi Code sessions receive an **Outpost MCP** tool named `publish_file`.
Ask the agent to publish a generated image or document to your Outpost session;
the tool takes an absolute `path` and an optional download `name`. Any managed
coding tool can also use the same helper from its shell:

```sh
outpost-mcp publish /absolute/path/to/report.pdf
```

When a session has files, its web or desktop terminal shows a **Files** badge
at the top right. Open it for thumbnails, filenames, dates and sizes, with
download and remove actions. Click any file to open the full-window viewer.
Use its left/right buttons or **← / →** keys to cycle through files, and **Esc**
to close. The viewer keeps filename, date, size, download and remove actions
visible; unsupported formats show **Preview not supported**. In the desktop app
the viewer covers the whole window, including split panes.
Windows and macOS downloads use the native Save dialog; web terminals use the
browser's download handling. The panel and viewer do not resize the terminal.
Thumbnails, previews and downloads share a bounded session cache, avoiding repeat
transfers while the file remains cached. Closing the file panel keeps the cache;
closing the session clears it.

Files are snapshots stored on the target, survive client disconnects, and
appear again after reconnection. Removing an attachment leaves the original
file alone. Deleting the managed session also deletes its attachments. Limits
are **32 MiB per file**, **100 files**, and **256 MiB total per session**.
PNG, JPEG, GIF and WebP have previews; other formats are available to download.
Local shell tabs do not have this session file list.

The helper is installed automatically when Outpost starts a managed agent.
Codex and Claude receive launch-specific MCP configuration. Kimi uses its native
Outpost plugin, which also reports activity. Its MCP helper inherits the current
process's session identity; ordinary Kimi launches outside Outpost expose no
Outpost tools. No manual MCP setup is required, and existing user MCP servers
remain configured.

After updating Outpost, finish or save current work and restart an existing
agent session once to load its MCP integration. This does not require a new
Outpost Terminal binary. Update the server and desktop app together for native
file downloads.

### Outpost Desktop

Open **Download Outpost Desktop** in the Connect dialog, or visit `/desktop`
on your server. Download the matching macOS DMG (arm64 for Apple silicon,
x64 for Intel) or Windows x64 installer from
[GitHub releases](https://github.com/KevinWang15/outpost/releases).

1. On macOS, drag Outpost into Applications; on Windows, run the installer.
2. Open Outpost once to register its links.
3. In your browser, choose **Connect → Outpost Desktop** for a session.
4. Allow the browser to open the app and confirm the server on first use.

These are **unsigned previews**. After the first launch attempt, macOS may
require **System Settings → Privacy & Security → Open Anyway**. Windows may
show **SmartScreen → More info → Run anyway**. Only proceed with a release
you trust; release artifacts include checksums.

The app arranges your sessions in tabbed windows, with its own Outpost
icon and native notifications. Drag tabs to reorder, double-click to rename,
or use the session switcher to find an open session by name or server.
Click the Outpost logo to open the servers, sessions, and help page. It includes
the keyboard shortcut guide, also available from **Help → Outpost guide and shortcuts**.
Click a terminal tab to return; Escape does not dismiss this home page.

**Local terminals:** the app opens a local shell at startup, and **+** opens another.
Local tabs work offline without an Outpost server or account. macOS uses your login
shell; Windows uses PowerShell 7 when available, otherwise Windows PowerShell.
Right-click **+** or use **File → New terminal with profile** to choose another shell,
including Command Prompt or the default WSL distribution on Windows. WSL must
already have a distribution installed. Settings lets you choose the default shell.
Local and remote tabs share splits, dragging between windows, clipboard handling,
font settings, and bell notifications. Local shells start in your home directory.

**⌘W** on macOS / **Ctrl+Shift+W** on Windows closes only the focused pane,
after confirmation. Remaining panes expand; an empty tab and then an empty window
are removed. To close every pane in a tab, use its **×** or **File → Close current tab**,
which also asks for confirmation. Closing a window or
quitting also asks when any terminal tabs remain. **Cancel** is the default.
Closing a local tab or quitting the app ends its shell. Reloading a local terminal
asks before restarting a running shell. Local terminal history is held in memory
for that tab, up to 10,000 lines; it is not restored after quitting. Pasted images
are saved in a private directory for the tab and removed when the tab closes.
Managed Outpost sessions retain their existing persistence and reconnect behavior.

Drag a tab outside the tab bar and release to give it a window. Drop it into
another Outpost window's tab bar to merge it there; an insertion marker shows
the position when reordering. Hovering over another window's tab bar shows the
live terminal there and hides its empty source window. Release to keep the move;
moving away or pressing **Esc** restores the original layouts. Hover at either
edge to scroll a long tab bar. Right-click also offers **Move tab to new window**
and **Move tab to window**.
Moving a tab preserves its live connection, terminal buffer and message draft.
Moving the last tab into another window closes the empty source window.

Tabs share the top row with the native macOS or Windows window controls, with
no separate title bar. Drag the empty space between **+** and
the workspace tools to move the window, even when many tabs are open.

Each tab can contain nested split panes, mixing local shells and remote sessions.
Each pane owns its terminal; tabs group panes, and windows group tabs. Switching
tabs restores that tab's focused pane. Workspace pages preserve the selection
without letting pane shortcuts close or split a hidden terminal.

**View → Split side by side / Split top and bottom** opens a new local shell
beside the focused pane using your default shell profile. The split toolbar button
splits side by side; right-click it for top and bottom. To split with an existing
remote session, drag its tab to a terminal edge, or use **◫** in the session switcher.

Sign in to one or more servers from the **Outpost logo → Logged-in Outpost
servers** page. Enter a server URL, approve first-use trust, and finish sign-in
and app approval in your system browser. The app never receives your password
or browser cookies. An existing browser login provides SSO. App logins last
30 days; expired logins show **Connect** so you can sign in again.

Right-click a tab and choose **Split with Outpost terminal…**, or right-click
**+** and choose **Outpost terminal…** for a new tab. The shared finder loads
all sessions on your logged-in servers, including sessions you have never
opened in the app. Type to filter by session, target, tool, directory or server;
use **↑ / ↓** and **Enter**, click a result, or choose **New session** in the
finder; **Esc** cancels. Servers and unreachable targets report errors
independently, so available results remain usable. An already-open session moves
its existing pane into the chosen split or tab, preserving its connection and
draft. A split uses the selected pane of the tab whose menu you opened.

The finder's **New session** action opens the same dialog as **New session** beside
a logged-in server. It temporarily hides the finder, then refreshes the full
catalogue and highlights the created session so Enter opens it in the original
destination. The server row preselects its server; splitting beside a remote
pane preselects that pane's server and target. All creation fields are shared:
Outpost server, execution target, then the web workspace's session name, coding
tool, project directory (with suggestions), directory creation, arguments and
environment fields. A single available server or target is selected
automatically. You can change either selection.

**Cancel** creates nothing and leaves the layout alone. **Create session**
creates the session and opens it in the original new-tab or split destination.
During creation, the dialog waits for the server to finish before it can close.
If creation succeeds but opening fails, the session remains available in the
finder. Missing target software must first be installed from the web workspace.
This works with both local-mode and hosted Outpost servers.

Drag a pane's header to reorganize it:

- Drop on the left, right, top or bottom of another terminal to split there. A
  translucent preview highlights the destination, including in another window.
- Drop in a tab bar to make the pane its own tab at that position.
- Drop outside all Outpost windows to create a window containing the pane.
- Press **Esc** to cancel. Dropping onto itself or an invalid workspace area also cancels.

Dragging a tab moves its entire pane group. Closing or moving the last pane removes
the empty tab and window; remaining siblings expand into the space. Transfers keep
the same terminal processes, connections, history and message drafts.
Drag dividers to resize (arrow keys also work); double-click a divider to reset it.
The divider is a one-pixel line with a wider grab area. Inactive panes are subtly
gray; clicking them restores their normal appearance without resizing the terminal.
On macOS, **⌘D** splits side by side and **⌘Shift+D** splits top and bottom.
Double-click a pane header, or use **View → Zoom / restore pane**, to temporarily
expand a pane without removing its siblings. The pane header menu also provides
move, split, reload and close actions. Closing a pane or a whole tab asks for confirmation.
Up to 32 terminal panes across 16 windows can stay open. Connecting an already-open
session or clicking its notification focuses the correct pane, tab and window.

**Ctrl+Tab** selects the next tab and **Ctrl+Shift+Tab** the previous one in the
current window, wrapping at either end of the tab strip. Both shortcuts use
Control on macOS and Windows and work while the terminal or a workspace panel
has focus.

Tab icons and the session switcher follow the session list's **Activity** field:
a blue spinner means **Working**, a gray clock means **Idle**, and an amber
bell means **Needs you** (unread completion) or **Waiting for you** (approval/input).
A red alert means **Error**. Hover over a badge for its specific state.
They use native lifecycle hooks, status APIs and turn records, with shared
acknowledgement and updates about every two seconds. Temporary read failures show
a dimmed, still icon labeled **last known** for up to 15 seconds, then **Unknown**
with a diagnostic. Connection errors
take priority, and an unread terminal bell remains highlighted until you return.
The green check means connected while the first activity reading is pending.
Lifecycle tracking follows conversation changes within the agent. After updating
Outpost, restart existing managed agent sessions to install their observers;
reconnecting a terminal alone keeps its existing agent process.

Activating a tab clears its terminal bell and marks the displayed **Needs you**
completion as seen. This works with clicks, keyboard tab switching and returning
to the app window, without typing into the terminal. The icon updates immediately
while the target saves the acknowledgement shared with the session list. A later
completion remains unread until you return or interact again. If saving fails,
the unchecked state returns with an error. Browser terminals use the same logic
when you return to their page.

Settings remembers text size, bell sound, and the default local shell. The toolbar starts hidden in the
app and can be revealed from the terminal context menu. The same xterm.js
client handles input, selection, image paste and reconnects in both clients.
WebGL accelerates rendering when available, with a DOM renderer fallback.
Local panes use the same terminal screen with a native PTY connection and have no
activity badge. A split tab aggregates its remote panes: connection problems,
attention (bells, completions, approval waits and errors), then working activity take priority. Pane headers show each remote
session’s own status, and hovering the tab lists all its panes. Focusing one pane
acknowledges only that session.

Desktop bells use Outpost's system notification permission. Allow **Outpost**
in macOS or Windows notification settings and check Focus / Do Not Disturb.
An inactive tab gets a bell indicator; clicking a system notification returns
to that exact session, including when the app is minimized. Sound starts after
you interact with the terminal. **Help → Check for updates** opens newer previews
for manual installation; remote sessions survive closing or upgrading the app.

| Action | macOS | Windows |
| --- | --- | --- |
| Copy selection | ⌘C | Ctrl+Shift+C |
| Paste text or an image into the terminal | ⌘V or Ctrl+V | Ctrl+Shift+V |
| Newline in coding tool | Shift+Enter | Shift+Enter |
| New local terminal | ⌘T | Ctrl+Shift+T |
| New window | ⌘Shift+N | Ctrl+Shift+N |
| Cancel pane or tab drag | Esc | Esc |
| Switch session | ⌘P | Ctrl+Shift+P |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Go to tab 1–8 / last tab | ⌘1–9 | Alt+1–9 |
| Split with local shell, side by side | ⌘D | Ctrl+Shift+D |
| Split with local shell, top and bottom | ⌘Shift+D | Ctrl+Alt+D |
| Zoom / restore focused pane | ⌘Shift+Enter | Ctrl+Shift+Enter |
| Close focused pane | ⌘W | Ctrl+Shift+W |
| Focus other pane | ⌘Option+Right | Ctrl+Alt+Right |
| Larger terminal text | ⌘= or ⌘Plus | Ctrl+= or Ctrl+Plus |
| Smaller terminal text | ⌘Minus | Ctrl+Minus |
| Reset terminal text size | ⌘0 | Ctrl+0 |
| Close window | ⌘Shift+W | Alt+F4 |

Server badges distinguish **Connected**, **Offline**, and **Sign-in expired**.
Pending browser sign-ins show temporary progress beneath the URL field. Click an offline badge to retry, **Cancel sign-in** to
stop waiting, or **Sign out** to revoke that app login. Sign-out requires the
server to be reachable. It does not end the coding processes on your targets.
Trust is remembered independently of login and is not cleared by sign-out.
The **Outpost logo → Recent sessions** list keeps your 10 most recent remote
sessions across app restarts. Click an entry, or choose with ↑/↓ and press Enter,
to reconnect. If it is already open, its existing tab and window are activated.
Local shells are not included. **Remove** and **Clear recent sessions** forget
saved connections without closing tabs or ending remote sessions.
Signing out also removes that server's recent-session shortcuts. Existing
terminals authorized by that app login disconnect; their remote processes keep running.
Closing a tab includes any unsent message in its confirmation; hiding the message box preserves its draft.
Recent-session references are stored in `recent-sessions.json` in the app's
user-data directory, without credentials. Reopening a recent session requests
fresh access using its server login. If that login expires, sign in again.
App credentials are stored as plain JSON in `server-logins.json` and expire
30 days after approval. Browser sign-out does not sign the app out;
changing/resetting the account password invalidates app access. Account
passwords, browser cookies and terminal reconnect credentials are never saved
by the app. There is no silent renewal.

You can start from the app's URL field or the website's **Connect Outpost app**
button. **Connect → Outpost Desktop** also signs in if needed, then opens the
selected session. Approval happens in your browser. First use asks whether to
trust that server; accepting is remembered, declining cancels only this attempt.
There is no trusted-server list or management screen.
Use HTTPS, or HTTP on localhost for a local Outpost server / SSH port forward.
The app needs a network connection and an open terminal tab for bells.

## Run a hosted service

Set `OUTPOST_MODE=hosted`. Users sign up with a verified email, get their own
workspace and an Ed25519 SSH key that they authorize on their servers
(`/root/.ssh/authorized_keys`). Web terminal and Outpost Desktop work exactly as in local mode, connecting
to the hosted server.

```dotenv
OUTPOST_MODE=hosted
NODE_ENV=production
PUBLIC_APP_URL=https://outpost.example.com
OUTPOST_DATA_DIR=/var/lib/outpost
ENGAGE_LAB_USERNAME=…
ENGAGE_LAB_API_KEY=…
ENGAGE_LAB_FROM_EMAIL="Outpost <no-reply@example.com>"
OUTPOST_TRUST_PROXY=127.0.0.1,::1   # your reverse proxy
```

Production requires HTTPS and email delivery. Without mail settings on
loopback, development shows verification links in the UI. Put Outpost behind
an HTTPS reverse proxy that preserves the `Host` header and forwards WebSocket
upgrades for `/api/terminal`:

```nginx
proxy_http_version 1.1;
proxy_set_header Host $http_host;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_read_timeout 75s;
```

**Container:** `docker build -t outpost .` builds a hosted image serving on
port 3000 as user 1000. Mount persistent storage at `/state` and back up the
whole data directory (accounts, workspaces, SSH keys, secret). Run one
instance per data directory.

## How it works

```text
web terminal / Outpost Desktop ⇄ WebSocket ⇄ Outpost ⇄ SSH or local shell ⇄ relay ⇄ Outpost Terminal ⇄ PTY ⇄ coding tool
```

Every connection takes this one path. A dedicated `outpost-terminal` process
owns each session's PTY and terminal state on the target. Python management
operations and the disposable relay still travel through the existing SSH or
local-shell transport. The helper has no public listening port.

**Required Software → Outpost Terminal → Install** downloads the matching Linux
executable into `~/.outpost/bin`, verifies its SHA-256 checksum and installs it
atomically. x86_64 and ARM64 targets with glibc or musl are supported. The runtime
is bundled; targets need neither Node.js nor Bun. Minimal musl installations also
receive the system `libstdc++` package. Existing sessions keep
their running helper when its executable is upgraded.

The **Linux terminal service** GitHub Actions workflow is manual. Enable
**Publish** to create the versioned dependency release used by the installer.
See [terminal-service/RELEASE_NOTES.md](terminal-service/RELEASE_NOTES.md) for
upgrade instructions, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
protocol and ownership model.

## Development

```sh
npm run build:terminal   # build the target helper before runtime/browser tests
npm run check            # lint, typecheck, build, unit and Python tests
npm run test:integration # persistent PTYs: local targets and SSH in Docker
npx playwright install chromium webkit
npm run test:ui          # browser tests against a real backend
npm run test:mobile      # Android Chromium, iPhone WebKit, iPad WebKit
npm run docs:capture     # refresh README screenshots
```

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
