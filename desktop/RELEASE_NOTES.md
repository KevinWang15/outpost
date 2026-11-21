# Outpost Desktop 1.0.0 preview

Outpost's desktop app for macOS and Windows: your sessions in tabbed windows
with splits, local terminals alongside them, and Outpost Chat in the system browser.

- **Sessions:** **Connect → Outpost Desktop** on the website, or the app's
  session finder, opens a session in a tab or split. Closing a tab disconnects;
  the session keeps running on its machine.
- Drag a tab to move its entire layout, or drag a pane header to move one terminal. Drop at a pane edge to split, on a tab strip to insert, or outside the workspace to open a window. Drag its tab to dock it again. Dragging empty title-bar space moves the window. Escape cancels the drag.
- **Local terminals:** your own shell opens at startup and with **+**. Local
  tabs work offline and end when closed.
- **Chat:** choose **Chat** next to a saved server to open its Chat page in your browser.
- **Terminal engine:** GPUI draws Alacritty cells. Managed sessions retain their history on the machine when the desktop disconnects.

## Install

- **Apple silicon Mac:** download `Outpost-1.0.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-1.0.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-1.0.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.
