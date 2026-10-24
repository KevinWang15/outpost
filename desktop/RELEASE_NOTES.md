# Outpost Desktop 0.18.0 preview

Browse session files in a full-window viewer, with fewer repeated image transfers.

## What's new

- **Full-window file viewer:** click any session file to open it. The desktop viewer covers the whole window, including split panes, without resizing terminals or changing PTY dimensions.
- **Browse files:** use the previous/next buttons or **← / →** keys to cycle through files. **Esc** closes the viewer. Removing the selected file advances to its neighbor.
- **File details and actions:** filename, date and size stay at the top left; download, remove and close stay at the top right. PNG, JPEG, GIF and WebP use the available space for preview. Other formats show **Preview not supported**, with download and remove still available.
- **Shared file cache:** thumbnails, previews and downloads reuse original bytes. Concurrent reads of the same file share one transfer. Each session retains up to 64 MiB of original bytes and 4 MiB of thumbnails; evicted files may be fetched again.
- **Recovery and cleanup:** failed previews have a retry action. Removal evicts cached content, stale list responses cannot undo a completed removal, and closing a session clears its cache.

The web terminal uses the same viewer UI. File contents are cached in memory, and HTTP authorization remains scoped to the managed session. Downloading on macOS or Windows still uses the native Save dialog.

## Update together

Install Desktop **0.18.0** and update your Outpost server together. This release introduces **desktop bridge version 9**; older desktop builds must be updated before reloading their terminal pages against the new server.

Reload web terminal pages after deployment. Server deployment preserves remote agent processes. No coding-agent restart or Outpost Terminal binary update is required for these file-viewer changes.

If you run a local Outpost backend, update and restart it too; the desktop installer does not update that backend.

## Install

- **Apple silicon Mac:** download `Outpost-0.18.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.18.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.18.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
