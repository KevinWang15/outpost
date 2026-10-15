# Outpost Desktop 0.4.1 preview

More reliable Codex activity indicators and better tab-icon alignment on macOS and Windows.

## What's new

- **Reliable Codex activity:** the updated Outpost server observes Codex's live daemon status. Reconnecting to an ongoing turn no longer hides Working, and reverted conversations use their current transcript. Session lists and app tabs share the same detector.
- **Separate completion acknowledgements:** marking a completion as seen cannot hide active work. Missing live status and unresolved review activity show Unknown. Hover over an icon for details, including approval/input waits.
- **Aligned tab icons:** the clock, spinner and bell sit more evenly alongside tab titles, with their animations preserved.

Use ⌘T on Mac or Ctrl+Shift+T on Windows to choose another session. The Settings page lists all shortcuts. Up to 32 tabs across 16 windows can stay open. Closing the app leaves remote sessions running; reconnect through your Outpost server after reopening. Local shells and extensions are not included.

**Self-hosted users:** update your Outpost server to receive the activity fixes. The icon alignment ships in the desktop app. Desktop bridge version 4 is unchanged from 0.4.0; there is no Linux terminal executable update in this release.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

In your browser, choose **Connect → Outpost Desktop** for a session. The app asks you to trust the server on the first connection.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.
