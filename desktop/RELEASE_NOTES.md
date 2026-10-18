# Outpost Desktop 0.12.0 preview

Restore terminal keyboard focus reliably when returning to the app after switching applications on macOS.

## What's new

- **Reliable activation focus:** returning to Outpost restores the active native terminal pane, even when the title-bar controls held the previous focus.
- **Focus ownership:** normal toolbar and dialog focus remains respected; only application reactivation uses the explicit terminal focus path.

Use Desktop **0.12.0** with the existing server. No server or terminal-helper update is required. Existing server logins continue to work.

## Install

- **Apple silicon Mac:** download `Outpost-0.12.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.12.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.12.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
