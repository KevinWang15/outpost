# Outpost Desktop 0.4.0 preview

Shared session activity, reliable tab shortcuts and smoother history browsing on macOS and Windows.

## What's new

- **Tab navigation:** Ctrl+Tab and Ctrl+Shift+Tab cycle through the current window's tabs in order, wrapping at either end. Native key handling reserves these shortcuts even when the terminal or a workspace panel has focus. Both platforms use Control.
- **Shared activity indicators:** tabs and the session switcher show Working, Idle, Needs you or Unknown using the same native coding-tool records and acknowledgement state as the server's session list. Unread terminal bells remain highlighted. Hover over an icon for details.
- **Stable workspace controls:** activity refreshes preserve keyboard focus, session-switcher selection and indicator animations. Workspace pages highlight their own toolbar button, and toolbar icons use consistent SVG sizing and alignment.
- **Text size shortcuts:** Ctrl+= on Windows and Command+= on macOS increase terminal text size, alongside the existing Plus shortcut. Minus decreases it and 0 resets it.
- **Native scrollback:** the terminal keeps up to 10,000 lines and restores its screen and history on reconnect. Selecting text does not pause the remote process.

Use ⌘T on Mac or Ctrl+Shift+T on Windows to choose another session. The Settings page lists all shortcuts. Up to 32 tabs across 16 windows can stay open. Closing the app leaves remote sessions running; reconnect through your Outpost server after reopening. Local shells and extensions are not included.

**Update the Outpost server and desktop app together.** This preview uses desktop bridge version 4 for shared activity metadata. Older server pages or desktop apps are incompatible with the new bridge. Self-hosted users should update their server from the same source revision as this release.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

In your browser, choose **Connect → Outpost Desktop** for a session. The app asks you to trust the server on the first connection.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.
