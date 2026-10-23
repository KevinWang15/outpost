# Outpost Desktop 0.17.0 preview

Coding agents can publish files and images directly to an Outpost session for preview and download.

## What's new

- **Session files:** a badge at the terminal's top right opens a file list with thumbnails, filenames, dates, sizes, download and remove actions.
- **Image previews:** open PNG, JPEG, GIF and WebP images inside Outpost without saving them first. Other file types can be downloaded.
- **Native downloads:** choose a destination with the macOS or Windows Save dialog. File requests use the terminal's session authorization.
- **Outpost MCP:** managed Codex sessions receive a `publish_file` tool. Other managed coding tools can run `outpost-mcp publish /absolute/path/to/file` from their shell.
- **Persistent attachments:** published snapshots survive client disconnects and agent restarts. Removing one keeps the original source file; deleting the managed session removes its attachments.

The same file panel is available in the web terminal. Panels and previews do not resize the terminal viewport. Limits are **32 MiB per file**, **100 files** and **256 MiB total per session**. Local shell tabs do not have session attachments.

## Update together

Install Desktop **0.17.0** and update your Outpost server together; this release adds desktop bridge version 8. Reload existing web terminal pages after deployment, or reopen their desktop tabs.

After saving current work, restart an existing coding agent through Outpost once to load the MCP integration. Newly started agents receive it automatically. Server deployment leaves remote agent processes running, and no Outpost Terminal binary update is required.

If you run a local Outpost backend, update and restart it too; the desktop installer does not update that backend.

## Install

- **Apple silicon Mac:** download `Outpost-0.17.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.17.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.17.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
