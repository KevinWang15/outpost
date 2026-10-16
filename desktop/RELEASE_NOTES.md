# Outpost Desktop 0.5.1 preview

Terminal search placement, a shortcut guide, and confirmation before closing tabs.

## What's new

- **Search at the top-right:** **⌘F** / **Ctrl+F** opens terminal search at the top-right, leaving room for the floating toolbar button. The search box still floats over the terminal without resizing it, in web, remote desktop, and local shell tabs.
- **Shortcut guide on the home page:** click the Outpost logo or choose **Help → Outpost guide and shortcuts**. The guide documents **⌘T / ⌘W** on macOS and **Ctrl+Shift+T / Ctrl+Shift+W** on Windows for creating a local terminal tab and closing the current tab.
- **Confirm before closing:** closing a tab always asks for confirmation, with **Cancel** selected by default. The prompt explains whether a local shell will end or a remote session will keep running, and includes any unsent message. Closing a window or quitting also asks when terminal tabs remain.
- **Simpler home page:** removed its Back/Esc control. Click a terminal tab to return; Escape still dismisses transient panels and cancels tab dragging.

Up to 32 tabs across 16 windows can stay open. Closing a local terminal ends its shell; local shells and history do not survive quitting the app. Closing or upgrading the app leaves remote sessions running; reconnect through your Outpost server after reopening.

**Self-hosted users:** install Desktop 0.5.1 for the shortcut guide, close confirmations, and local search placement. Update your server and reload remote terminals for the new search placement there. Desktop bridge version 5 and the Linux terminal executable are unchanged from 0.5.0; remote sessions do not need to be restarted.

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
