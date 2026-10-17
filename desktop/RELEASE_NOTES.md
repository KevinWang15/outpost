# Outpost Desktop 0.7.0 preview

Direct image uploads, shared clear-screen commands, and more reliable connections.

## What's new

- **Direct images:** paste, drop, or choose an image in the terminal. Remote images upload as binary data separately from terminal input; local shells use native IPC. The saved reference is pasted once, without submitting the prompt.
- **Safe upload lifecycle:** disconnecting cancels an upload, and late results cannot paste into a replacement connection or shell. Upload notices keep the terminal viewport unchanged.
- **Clear screen:** use the terminal menu or Command+K on macOS. Remote viewers and reconnect history share the cleared buffer, without sending commands to the coding tool.
- **Connection recovery:** health checks reach the persistent terminal service, stalled attachments time out, and rapid disconnects retain their retry budget.
- **Bounded resource use:** terminal input queues have explicit limits, while large history checkpoints are compressed in yielding slices with limited concurrent restorations.
- **Mobile workspace:** long target lists scroll within their navigation, and session filters wrap on narrow screens so Connect remains tappable.

Local verification covers 166 tests across unit/runtime checks, real SSH, browser and mobile browser engines, and native Linux Electron. Windows/macOS installers are built in GitHub Actions; native clipboard and WSL behavior still need platform verification.

The Outpost home tab still remembers ten recent remote sessions. Reconnect credentials last 30 days and refresh after a successful reconnect; expired entries require a fresh **Connect → Outpost Desktop** from the server.

Up to 32 tabs across 16 windows can stay open. Closing a local terminal ends its shell; local shells and history do not survive quitting the app. Closing or upgrading the app leaves remote sessions running.

Use the matching Outpost server and reload open web terminals after deployment (client protocol 12). Install **Outpost Terminal 1.2.0** through **Required Software → Outpost Terminal → Install**. Its service protocol is 4. Updating the executable leaves running sessions on their old build: after saving ongoing work, use **Terminate → Connect** to start the new service and resume the conversation. Deploying the server does not restart target sessions automatically.

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
