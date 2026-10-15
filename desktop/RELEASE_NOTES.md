# Outpost Desktop preview

The macOS and Windows app shares Outpost's web terminal, with its own Dock/taskbar identity, native notifications, clipboard support and browser links. Choose **Connect → Outpost Desktop** in your Outpost workspace. The app asks you to trust the server on the first connection.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. A bell from a background terminal opens a notification; clicking it returns to that session. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.

This first preview provides individual terminal windows. Tabs, split panes and local shells are not included.
