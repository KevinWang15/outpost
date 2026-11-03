# Outpost Desktop 0.18.1 preview

Terminal search keeps its navigation position separate from text selected for copying.

## What's fixed

- **Ctrl+C interrupts the terminal:** on Windows, returning focus to the terminal while search is open lets Ctrl+C reach the running program when no text is manually selected. Search highlights no longer turn the shortcut into Copy.
- **Independent search navigation:** Next/Previous continue from the active match across focus changes and live output. Searching does not replace or clear text you selected to copy.
- **Live output and scrollback:** the search cursor follows its match as old scrollback is trimmed. If the match is removed, the buffer changes, or resizing changes the column count, navigation restarts from a valid position.

These fixes also apply to the web terminal after updating the server and reloading terminal pages.

## Update

Install Desktop **0.18.1** for the fix in local terminals, and update your Outpost server for managed remote terminals. The desktop bridge remains at **version 9**, compatible with Desktop 0.18.0.

No coding-agent restart or Outpost Terminal binary update is required. Server deployment preserves remote terminal processes. If you run a local Outpost backend, update and restart it too; the desktop installer does not update that backend.

## Install

- **Apple silicon Mac:** download `Outpost-0.18.1-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.18.1-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.18.1-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
