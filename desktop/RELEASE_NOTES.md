# Outpost Desktop 0.15.0 preview

Move tabs and panes using consistent drag-and-drop rules.

## What's new

- **Detach inside the window:** drag a tab title over its own terminal area and release to detach the entire tab, including all its split panes.
- **Move individual panes:** drag a pane header onto another pane to rearrange the split, onto a tab bar for its own tab, or outside all windows for a separate window. Dropping a pane onto itself cancels.
- **Clear drop feedback:** a highlighted half indicates a split destination; a floating title indicates detachment. Tab-bar and valid split destinations take priority. The Outpost tab's help now explains these rules.

Install Desktop **0.15.0** for these improvements. Existing server logins continue to work. No server or terminal-helper update is required.

## Install

- **Apple silicon Mac:** download `Outpost-0.15.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.15.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.15.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
