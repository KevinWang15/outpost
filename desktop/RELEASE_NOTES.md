# Outpost Desktop 0.16.1 preview

Find highlights stay aligned with terminal text while scrolling and during application redraws.

## What's new

- **Responsive Find:** highlights update with text, without the previous 200 ms delay during TUI redraws, in local and remote terminals.
- **Correct scrolling:** native scrollback and applications that redraw their own scrolling views keep highlights aligned without moving your scroll position.
- **Reliable reconnection:** restoring a remote terminal or clearing its screen refreshes search results immediately.
- **Efficient history search:** unchanged scrollback remains cached, including correct invalidation when the 10,000-line history limit trims older lines.

Find searches the current terminal buffer and its scrollback. History retained only inside an application becomes searchable when that application displays it.

## Update together

Install Desktop **0.16.1** for local terminals and update your Outpost server for remote terminals and the web client. Reload existing web terminal pages after deployment, or reopen their desktop tabs. No agent-session restart or terminal-helper update is required for these search fixes. Server deployment leaves remote agent processes running.

If you run a local Outpost backend, update and restart it too; the desktop installer does not update that backend.

## Install

- **Apple silicon Mac:** download `Outpost-0.16.1-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.16.1-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.16.1-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
