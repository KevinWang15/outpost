# Outpost Desktop 0.5.0 preview

Local shells and terminal search, alongside your persistent remote sessions.

## What's new

- **Local terminal tabs:** click **+**, or press **⌘T** on macOS / **Ctrl+Shift+T** on Windows, to open a shell on your computer. Local terminals work offline, without an Outpost server.
- **Shell profiles:** macOS uses your login shell. Windows offers installed PowerShell profiles, Command Prompt, and WSL's default distribution. Right-click **+** or use **File → New terminal with profile** to choose a shell; Settings remembers your default.
- **One terminal workspace:** local and remote tabs share splits, drag-to-window, resizing, clipboard support, image paste, and notifications. The Outpost logo opens your servers and sessions.
- **Find in terminal:** **⌘F** / **Ctrl+F** opens a search box at the top-left. Search highlights matches in the loaded screen and scrollback, with a count and case toggle. **Enter** / **Shift+Enter** navigate; **Esc** closes. Search also appears in the Edit menu and terminal context menu, and works in the web terminal.
- **Stable viewport:** search floats over the terminal without changing its dimensions, and reconnects preserve focus in local controls.

Up to 32 tabs across 16 windows can stay open. Closing a local terminal ends its shell; local shells and history do not survive quitting the app. Closing or upgrading the app leaves remote sessions running; reconnect through your Outpost server after reopening.

**Self-hosted users:** update the server and Desktop together. This release uses desktop bridge version 5; older app/server combinations show an update message. The Linux terminal executable is unchanged and remote sessions do not need to be restarted.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

In your browser, choose **Connect → Outpost Desktop** for a session. The app asks you to trust the server on the first connection.

For a local shell, open Outpost directly or click **+** in an existing window.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.
