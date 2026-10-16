# Outpost Desktop 0.6.0 preview

Return to recent Outpost sessions directly from the app.

## What's new

- **Ten recent sessions:** click the Outpost logo to find your most recently connected remote sessions, remembered across app restarts. Local terminals are not included.
- **Quick reconnect:** click an entry, or select it with the arrow keys and press Enter. If the session is already open, Outpost switches to its existing tab and window.
- **Manage the list:** remove individual entries or clear the list without closing running sessions. Forgetting a server also removes its recent sessions and saved reconnect credentials.
- **Existing authentication:** reconnect credentials last 30 days and are refreshed after a successful reconnect. Hosted login expiry and logout still apply. Expired entries show a connection error; use **Connect → Outpost Desktop** in your server for a fresh connection.

Recent-session metadata and reconnect credentials are saved as plain JSON in `recent-sessions.json` in the app's user-data directory. Account passwords, login cookies, terminal contents, and drafts are not saved.

Up to 32 tabs across 16 windows can stay open. Closing a local terminal ends its shell; local shells and history do not survive quitting the app. Closing or upgrading the app leaves remote sessions running.

**Update both app and server:** this release uses desktop bridge version 6. Install Desktop 0.6.0 and update your Outpost server together. The Linux terminal executable is unchanged, and remote sessions do not need to be restarted. Connect your sessions once after updating to populate the recent list.

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
