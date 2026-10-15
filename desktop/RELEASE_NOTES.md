# Outpost Desktop 0.4.2 preview

Smoother connections, stable terminal layout, and reliable recovery controls on macOS and Windows.

## What's new

- **Direct connections:** remembered terminal choices skip the connection and progress dialogs. Errors or a slow launch bring back recovery controls; Connection preferences can restore the chooser.
- **Stable terminal dimensions:** image-paste notices, copy confirmations, link prompts, and send errors float over the terminal instead of resizing its viewport.
- **Usable recovery controls:** the disconnected screen stays above xterm and disables terminal input underneath it. Desktop activation preserves button focus.
- **Responsive resizing:** window and font-size changes send updates throughout a resize, including when quickly returning to the previous dimensions. Newly started coding sessions acquire a controlling terminal so the foreground process receives normal resize signals and can redraw.

Use ⌘T on Mac or Ctrl+Shift+T on Windows to choose another session. The Settings page lists all shortcuts. Up to 32 tabs across 16 windows can stay open. Closing the app leaves remote sessions running; reconnect through your Outpost server after reopening. Local shells and extensions are not included.

**Self-hosted users:** these fixes are delivered by the updated Outpost server to both web and desktop terminals. Reload or reopen a terminal to receive the updated page. Desktop bridge version 4 and the Linux terminal executable are unchanged.

**Existing sessions:** when ready to restart the coding tool, use **Terminate → Connect** once to resume the conversation with the corrected terminal setup. Reconnecting alone cannot repair the controlling-terminal setup of an already-running process. The update leaves running sessions intact.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

In your browser, choose **Connect → Outpost Desktop** for a session. The app asks you to trust the server on the first connection.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.
