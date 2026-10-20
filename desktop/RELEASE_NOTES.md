# Outpost Desktop 0.15.1 preview

More reliable session creation, connection recovery, and tab scrolling.

## What's new

- **Stable tab scrolling:** crowded tab bars use a slim horizontal scrollbar and respond to the mouse wheel without repeatedly changing height.
- **Reliable session picker:** newly created sessions appear immediately and stay selected even if refreshing the server list fails. Refresh and connection errors preserve the picker and offer a retry.
- **Recover interrupted creation:** retrying the same submission after a lost response recovers the created session without duplicating it. Closing the creation dialog refreshes the picker; cancelling a connection prevents a late response from opening a tab.
- **SSH reliability:** Windows backends explicitly disable SSH connection sharing. Linux and macOS backends can retry safe reads once using a fresh connection after an unambiguous sharing failure. Mutations are never automatically replayed by this recovery.

Install Desktop **0.15.1** and update your Outpost server to the matching release code for session creation. Existing server logins continue to work. The Windows-to-WSL SSH fix requires updating and restarting your local Outpost backend; updating the desktop app alone does not update that backend. No terminal-helper update is required.

## Install

- **Apple silicon Mac:** download `Outpost-0.15.1-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.15.1-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.15.1-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
