# Outpost Desktop 0.3.2 preview

More room for your terminal and clearer tab status on macOS and Windows.

## What's new

- **Compact title bar:** the tab strip is 36px tall, down from 48px, with smaller controls and matching drag previews. Native window controls, terminal bounds and drag destinations use the same height.
- **More terminal space:** the bottom status bar is removed. Terminals, split panes and workspace panels extend to the bottom edge, reclaiming another 28px.
- **Ringing bell:** a yellow animated bell replaces the attention dot. It pauses between rings and clears when you return to the session. Animations respect the system's reduced-motion preference.
- **Clear connection indicators:** tabs and the session switcher show a green check for connected, a blue spinner while connecting and a gray cross for disconnected. Hover descriptions and accessible tab labels explain both connection and attention state.
- **Visible action errors:** workspace errors appear in a native dialog above the terminal. Drag destinations keep their insertion markers, highlighted tab and live terminal preview.

Use ⌘T on Mac or Ctrl+Shift+T on Windows to choose another session. The Settings page lists all shortcuts. Up to 32 tabs across 16 windows can stay open. Closing the app leaves remote sessions running; reconnect through your Outpost server after reopening. Local shells and extensions are not included.

This preview works with the current Outpost server. Install the desktop update to get the new layout and indicators.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

In your browser, choose **Connect → Outpost Desktop** for a session. The app asks you to trust the server on the first connection.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.
