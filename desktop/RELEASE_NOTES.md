# Outpost Desktop 0.4.3 preview

Faster tab switching and a tighter terminal layout on macOS and Windows.

## What's new

- **Switch tabs on press:** pressing a tab immediately shows its terminal. Keyboard focus moves to the terminal on release so dragging still works.
- **Cleaner tab focus:** mouse presses no longer force the oversized rounded focus outline. Keyboard focus remains visible inside the tab.
- **Less empty space:** web and desktop terminals remove the extra right margin while preserving xterm's scrollbar gutter and stable terminal dimensions.

Use ⌘T on Mac or Ctrl+Shift+T on Windows to choose another session. The Settings page lists all shortcuts. Up to 32 tabs across 16 windows can stay open. Closing the app leaves remote sessions running; reconnect through your Outpost server after reopening. Local shells and extensions are not included.

**Self-hosted users:** install Desktop 0.4.3 for the tab improvements and update your Outpost server for the terminal spacing change. Reload or reopen a terminal to receive the updated page. Desktop bridge version 4 and the Linux terminal executable are unchanged; running sessions do not need to be restarted for these UI changes.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

In your browser, choose **Connect → Outpost Desktop** for a session. The app asks you to trust the server on the first connection.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.
