# Outpost Desktop 0.6.1 preview

Smoother terminal output, more reliable sizing, and consistent link confirmation.

## What's new

- **Responsive output:** adjacent terminal writes are batched, and output buffering is bounded so a slow viewer does not stop the remote session.
- **Reliable screen dimensions:** terminal geometry is refreshed after font, display scale, visibility, and focus changes. The active viewer controls the remote screen size when several clients share a session.
- **Smoother reconnection:** compact history snapshots stream in short batches while the remote process keeps running.
- **Link confirmation:** cancelling an embedded hyperlink's confirmation prevents it from opening. Link clicks are handled once, without also sending the click to the terminal application.
- **Local shell tabs:** session activity badges are hidden for local shells.

The Outpost home tab still remembers ten recent remote sessions. Reconnect credentials last 30 days and refresh after a successful reconnect; expired entries require a fresh **Connect → Outpost Desktop** from the server.

Up to 32 tabs across 16 windows can stay open. Closing a local terminal ends its shell; local shells and history do not survive quitting the app. Closing or upgrading the app leaves remote sessions running.

**Update app, server, and terminal helper together:** this release requires Outpost Terminal 1.1.0 (terminal service protocol 2) and the matching Outpost server. On each target, use **Required Software → Outpost Terminal → Install**. Existing remote terminal services keep running with their original protocol; finish or save their work, then explicitly **Terminate** and **Connect** those sessions to use the new helper. Installing the helper or updating the app does not restart them automatically.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

In your browser, choose **Connect → Outpost Desktop** for a session. The app asks you to trust the server on the first connection.

For a local shell, open Outpost directly or click **+** in an existing window.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.
