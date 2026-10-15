# Outpost

![Outpost — keep the session, keep your flow.](docs/images/banner.png)

Outpost keeps your **Claude Code, Codex and Kimi Code** sessions running in tmux
on your Linux machines, and lets you come back to them from your browser or
Outpost Desktop — with paste, copy, Shift+Enter and links working as if
the agent ran on your computer.

- **One Connect button.** Choose the web terminal or Outpost Desktop for macOS and Windows. Both share the terminal UI and connection path.
- **Feels native.** Paste screenshots with your normal paste shortcut and the agent receives the image. Shift+Enter inserts a newline. Text the agent copies lands on your clipboard. Links it opens open in your browser.
- **Sessions outlive connections.** Close the tab or lose Wi-Fi; the agent keeps working. Reconnect from any computer or your phone, to the same process.
- **Local tool or hosted service.** Run it on your own computer with your SSH config, or host it for a team with accounts and per-user SSH keys.
- **Know what needs you.** Each session shows whether the agent is working, idle, or finished a turn you haven't seen.
- **Find any conversation.** Search the history on a target, including conversations started outside Outpost, and resume them as sessions.

![The Outpost workspace: a target with three sessions and their activity](docs/images/workspace.png)

## Requirements

| Where | What you need |
| --- | --- |
| Targets — where sessions run | Linux with Bash, Python 3.9+ and tmux 3.2+, reachable over SSH as root. The computer running Outpost can be a target too when it runs Linux (including WSL). Outpost can install missing software for you. |
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

Click **Connect** next to a session and choose a terminal. Your last choice is remembered.

| Choice | Opens in | Installation | Authorization |
| --- | --- | --- | --- |
| Web terminal | A regular browser window; also works on phones | None | Your Outpost browser login requests a session ticket |
| Outpost Desktop | An Electron window with its own Outpost Dock/taskbar identity | Outpost Desktop | Transfers a session ticket from your signed-in browser; no second login |

Every choice attaches to the same tmux session. Closing a client disconnects
it; the coding session keeps running. You can change clients later.

Desktop Connect brings the app forward and selects the session's tab. If that
session is already open from the same browser login, its existing tab is reused,
including its draft and live connection. Keep Outpost Desktop and your server
updated together; an incompatible terminal interface shows an update message.

### Web terminal

Opens full-window in the browser. Paste images with your normal paste shortcut
or the image button. On phones, an on-screen key bar (Esc, Tab, Ctrl, Alt,
arrows, ⇧↩, ^C) and a message box are shown. Dropped connections reconnect by
themselves.

On macOS, **Ctrl+V** also pastes an image or text with the terminal focused,
in both the browser and Outpost Desktop. **Command+V** continues to work.
The browser may ask for clipboard permission for Ctrl+V; if access is blocked,
use Command+V instead.

Use **Hide terminal toolbar** for more screen space; the small button at the
top right restores it. This preference also applies to Outpost Desktop. Connection
errors, link prompts and bell notices remain visible while the toolbar is hidden.

Right-click the terminal (or press **Shift+F10** / the **Menu** key) for **Copy**,
**Paste**, **Select all**, image upload, history navigation, and toggles for the
toolbar, message box and on-screen keys. This menu is shared by the web terminal
and Outpost Desktop on macOS and Windows. Copy uses the terminal selection;
Select all selects output currently loaded in the terminal, not the entire
remote history. History actions follow the same controls as the sidebar.
Browser clipboard access may ask for permission; if Paste is blocked, use your
normal paste shortcut. The message box keeps its usual text-editing menu.

The scrollbar on the right navigates the session's saved terminal output,
including output from before you opened this window (up to 50,000 lines).
Drag its thumb or click the track to jump through history. Use the arrow at
the bottom to **Return to live output**. **Shift+Page Up / Page Down** moves
a screen at a time; when the scrollbar has keyboard focus, **Home / End**
jumps to the oldest output or back to live output. These controls work in
both the web terminal and Outpost Desktop, including with the toolbar hidden.

While browsing history, dragging to select text copies it when you release the
mouse and keeps your scroll position. Double-clicking a word or triple-clicking
a line also copies without leaving history. Use **Return to live output** when
you are ready to resume following the session.

Outpost starts Codex in inline mode so its output enters terminal history.
An already-running full-screen Codex session keeps its original mode: its
sidebar has **Oldest**, **Previous page**, **Next page**, and **Latest** buttons
instead of a draggable thumb. **Shift+Page Up / Page Down** also works there.
To enable the draggable scrollbar, exit Codex cleanly and reconnect the same
session. Reloading the page alone does not restart Codex. Other full-screen
applications use their own scrolling controls.

When the coding tool rings the terminal bell, the page and tab title show
which session rang, and a short chime plays. Click or type in the terminal
once to enable sound. Bells received while you are away stay marked until
you return; repeated bells are limited to one chime per second.

Click the bell button in the terminal toolbar to enable desktop notifications,
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
no separate title bar. Drag the empty space between the new-tab button and
the workspace tools to move the window, even when many tabs are open.

Open two sessions, then right-click a tab and choose **Show beside current tab**.
**View → Split side by side / Split top and bottom** also pairs open sessions.
Drag the divider to resize; double-click it to reset. **View → Single pane**
returns to one session. Each tab keeps its connection, terminal buffer and
message draft while you switch or rearrange it. Up to 32 tabs across 16 windows
can stay open. Connect and notifications select the session in its owning window.

Tab icons and the session switcher follow the session list's **Activity** field:
a blue spinner means **Working**, a gray clock means **Idle**, and a ringing
bell means **Needs you**. They use the coding tool's native turn records and the
same acknowledgement state, with updates about every two seconds. Unavailable
activity shows **Unknown**; hover over the icon for details. Connection errors
take priority, and an unread terminal bell remains highlighted until you return.
The green check means connected while the first activity reading is pending.

Settings remembers text size and bell sound. The toolbar starts hidden in the
app and can be revealed from the terminal's upper corner. The same xterm.js
client handles input, image paste, scrollback and reconnects in both clients.
WebGL accelerates rendering when available, with a DOM renderer fallback.
Outpost Desktop connects to remote Outpost sessions; it does not run local shells.

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
| New tab / choose a session | ⌘T | Ctrl+Shift+T |
| New window | ⌘Shift+N | Ctrl+Shift+N |
| Cancel tab drag | Esc | Esc |
| Switch session | ⌘P | Ctrl+Shift+P |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Go to tab 1–8 / last tab | ⌘1–9 | Alt+1–9 |
| Split side by side | ⌘D | Ctrl+Shift+D |
| Focus other pane | ⌘Option+Right | Ctrl+Alt+Right |
| Larger terminal text | ⌘= or ⌘Plus | Ctrl+= or Ctrl+Plus |
| Smaller terminal text | ⌘Minus | Ctrl+Minus |
| Reset terminal text size | ⌘0 | Ctrl+0 |
| Close tab | ⌘W | Ctrl+Shift+W |
| Close window | ⌘Shift+W | Alt+F4 |

The app remembers trusted servers and opens their workspaces in your browser.
Removing a server closes its tabs across all windows. Closing multiple tabs or discarding a message
draft asks for confirmation. Hiding the message box preserves its draft.
Launch/resume tickets stay in memory; the app stores neither your account
password nor login cookies. After quitting, connect through your server again.
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
web terminal / Outpost Desktop ⇄ WebSocket ⇄ Outpost ⇄ SSH or local shell ⇄ relay ⇄ tmux ⇄ coding tool
```

Every connection takes this one path; tmux is the only place terminal state
lives, so connections are disposable. The target runtime is a Python program
sent with each operation — nothing is installed on targets besides tmux and
`~/.outpost` state. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
principles, protocols, security model and how to extend desktop capabilities or add a coding tool.

## Development

```sh
npm run check            # lint, typecheck, build, unit and Python tests
npm run test:integration # real tmux: local targets and SSH in Docker
npx playwright install chromium
npm run test:ui          # browser tests against a real backend
npm run docs:capture     # refresh README screenshots
```

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
