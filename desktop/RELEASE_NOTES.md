# Outpost Desktop 0.19.0 preview

This preview adds a **Chat** window for Outpost's chat mode.

## What's changed

- **Chat window:** choose **Chat** on a logged-in server in the home panel. It
  opens one window per server with your sessions as conversations, channels
  where sessions reply when mentioned, session-to-session messages and
  schedules. It signs in with a single-use ticket from the app login.
- **Open in terminal:** a chat session can continue in a terminal tab of the
  workspace; the conversation is the same.
- **Files:** files an agent publishes appear in its chat; **Download** saves
  them through the save dialog.

## Update

Chat needs an Outpost server with chat mode and **Outpost Terminal 1.3.0**
on its targets (Required Software installs it). With an older server, the Chat
window cannot connect; terminal tabs work as before. Claude Code sessions in
chat also need the **Claude Code chat adapter** from Required Software. The
desktop bridge remains at **version 9**.

## Install

- **Apple silicon Mac:** download `Outpost-0.19.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.19.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.19.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
