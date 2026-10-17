# Outpost Desktop 0.8.0 preview

Split panes, flexible workspace organization, and more seamless connection recovery.

## What's new

- **Nested split panes:** mix local shells and remote sessions in one tab. Split side by side with Command+D on macOS or Ctrl+Shift+D on Windows; split top and bottom with Command+Shift+D or Ctrl+Alt+D.
- **Move panes freely:** drag a pane header to a terminal edge to split, to the tab bar to make a tab, or outside the window to make a new window. Move panes between windows and drag whole tabs with all their panes. Existing connections, history, and unsent drafts stay with their terminals.
- **Live drag previews:** hovering another window's tab bar shows the incoming terminals there. Pane-edge drops show the destination split. Escape cancels a move and restores the previous layout.
- **Focused pane controls:** thin adjustable dividers, subtle inactive-pane dimming, and Command+Shift+Enter / Ctrl+Shift+Enter to zoom or restore the focused pane. Header menus expose move, split, reload, and close actions.
- **Clear close behavior:** Command+W / Ctrl+Shift+W closes only the focused pane after confirmation. A tab's close button closes all its panes; Command+Shift+W / Alt+F4 closes the window. Empty tabs and windows disappear automatically. Confirmation applies only to the panes still belonging to that scope, protecting moved terminals and newly arriving sessions.
- **Consistent status and focus:** tabs remember their selected pane and summarize their remote panes' activity. Local shells have no activity badge. Pane shortcuts do not affect hidden terminals while an Outpost workspace page is open.
- **Sleep and network recovery:** reconnect after offline periods, stale connections, laptop sleep, or unlock without unnecessarily replacing healthy connections. Closed or expired sessions remain closed, and local shells keep running.

Verification includes 79 unit tests, 23 runtime tests, and 16 native Linux Electron/DOM scenarios with repeated runs. Coverage includes cross-window transfers, drag cancellation, retained drafts, real PTY resizing, close scopes, and sessions arriving during a close confirmation. Windows/macOS installers are built in GitHub Actions; physical platform verification remains necessary.

The Outpost home tab remembers ten recent remote sessions. Reconnect credentials last 30 days and refresh after a successful reconnect; expired entries require a fresh **Connect → Outpost Desktop** from the server.

Up to 32 terminal panes across 16 windows can stay open. Closing a local pane ends its shell; local shells and history do not survive quitting the app. Closing or upgrading the app leaves remote sessions running.

Use Desktop 0.8.0 with the matching server update (client protocol 13), and reload open web terminals after deployment. Older desktop previews need this update to reconnect. **Outpost Terminal 1.2.0** remains the required helper (service protocol 4); this release does not require updating the helper or restarting target sessions.

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
