# Outpost Desktop 1.2.0 preview

Outpost Desktop connects to sessions on your machines and opens local shells alongside them in tabs and split panes.

- An open terminal can share an agent with Chat. Sessions started in Chat open an interactive transcript with prompts and approvals, including DeepSeek Harness on server-connected machines.
- **Sessions:** **Connect → Outpost Desktop** on the website, or the app's
  session finder, opens a session in a tab or split. Closing a tab disconnects;
  the session keeps running on its machine.
- Drag a tab to move its entire layout, or drag a pane header to move one terminal. Drop at a pane edge to split, on a tab strip to insert, or outside the workspace to open a window. Drag its tab to dock it again. Dragging empty title-bar space moves the window. Escape cancels the drag.
- **Local terminals:** your own shell opens at startup and with **+**. Local
  tabs work offline and end when closed.
- **Machines:** choose **Machines ↗** next to a signed-in server to manage its machines in your browser. Chat is available in that workspace’s sidebar.
- Direct attachments use the HTTPS address saved on the machine. A fresh terminal can connect directly while the machine’s relay link is down.
- **Terminal engine:** GPUI draws Alacritty cells. Managed sessions retain their history on the machine when the desktop disconnects.

## Install

- **Apple silicon Mac:** download `Outpost-1.2.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-1.2.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-1.2.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.
