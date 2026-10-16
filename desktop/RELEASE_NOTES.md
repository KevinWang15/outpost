# Outpost Desktop 0.6.2 preview

Cleaner connection handling and more dependable terminal cleanup.

## What's new

- **Terminal lifecycle:** setup and cleanup have one owner, including failed initialization and asynchronous clipboard work after a tab closes.
- **Clear connection failures:** missing dependencies and other permanent setup problems show their error immediately instead of repeatedly reconnecting.
- **One desktop login path:** the app supplies terminal credentials through its preload bridge. The obsolete browser URL-token and session-storage path is removed.
- **Stricter desktop commands:** native workspace actions share a typed contract and validate arguments before changing window state.
- **Dependency installation:** batch installers no longer start interactive shell job control, and the terminal installer shows download and verification progress.
- **Current settings format:** saved desktop preferences require font size, sound, and a nullable local shell selection. An unsupported file shows its path and settings-reset instructions.

The Outpost home tab still remembers ten recent remote sessions. Reconnect credentials last 30 days and refresh after a successful reconnect; expired entries require a fresh **Connect → Outpost Desktop** from the server.

Up to 32 tabs across 16 windows can stay open. Closing a local terminal ends its shell; local shells and history do not survive quitting the app. Closing or upgrading the app leaves remote sessions running.

Use the matching Outpost server and reload open web terminals after deployment (client protocol 10). The current dependency is **Outpost Terminal 1.1.1**, installed through **Required Software → Outpost Terminal → Install**. Its service protocol remains 2; updating the executable does not restart running remote sessions. Newly started terminal services use the installed build.

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
