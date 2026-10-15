# Outpost Desktop 0.3.1 preview

Arrange your coding sessions across tabbed windows on macOS and Windows.

## What's new

- **Live merge previews:** hover a tab over another window's tab bar to see its live terminal there. An empty source window disappears during the preview. Release to keep the move; moving away or pressing Escape restores the original selections, split panes and panels.
- **Stable drag labels:** the floating tab label keeps a fixed size, including on Windows displays with scaling, and disappears while the destination is previewing the tab.
- **Dark startup:** the matching server update keeps new terminal tabs dark during initial loading and error screens.
- **Move tabs between windows:** drag a tab outside the tab bar and release to give it a window, or drop it into another Outpost window's tab bar to merge. Connections, drafts and terminal buffers stay with the tab. Moving the last tab into another window closes its empty source window.
- **Drag feedback:** a tab preview and insertion marker show where the tab will land. Hover at the edges to scroll a long tab bar; Escape cancels. Right-click also offers **Move tab to new window** and **Move tab to window**.
- **New window:** use ⌘Shift+N on macOS or Ctrl+Shift+N on Windows. Menus apply to the focused window; Connect and notifications find an existing session across all windows.
- **Connect selects your session:** new connections become the active tab; connecting again to an open session selects its existing tab and keeps its connection and draft.
- **Clear update errors:** incompatible desktop/server interfaces show an update message. Failed browser opens show an error and keep the link available to copy.
- **Tabs:** drag to reorder, double-click to rename, and right-click for tab actions. Background tabs stay connected.
- **Integrated title bar:** tabs and native macOS/Windows window controls share one row. Empty space beside the tabs moves the window; tab dragging still reorders sessions.
- **Terminal context menu:** right-click terminal output for copy, paste, image upload, history navigation and display controls. The same menu is available in the browser; Shift+F10 or the Menu key opens it from the keyboard.
- **Mac paste shortcut:** Ctrl+V pastes images or text into the terminal alongside ⌘V, in both desktop and browser clients.
- **Split view:** show two open sessions side by side or top and bottom. Drag the divider to resize; double-click to reset. Return to a single pane without closing either session.
- **Session switcher:** search open tabs by name or server with ⌘P on Mac or Ctrl+Shift+P on Windows.
- **Attention:** inactive tabs show bell indicators. Clicking a system notification opens the correct session.
- **Preferences:** text size and bell sound are saved locally. The terminal toolbar starts hidden for more room.
- **Draft protection:** message-box drafts survive hiding the composer. Closing or reloading a tab asks before discarding a draft; closing multiple tabs also asks for confirmation.
- **Recovery:** a terminal that fails to load or crashes has its own reload action. Other tabs keep running.

Use ⌘T on Mac or Ctrl+Shift+T on Windows to choose another session. The Settings page lists all shortcuts. Up to 32 tabs across 16 windows can stay open. Closing the app leaves remote sessions running; reconnect through your Outpost server after reopening. Local shells and extensions are not included.

Update your Outpost server alongside this preview; desktop and server changes are released together.

## Install

- **Apple silicon Mac:** download the `mac-arm64.dmg` file.
- **Intel Mac:** download the `mac-x64.dmg` file.
- **Windows x64:** download the `windows-x64.exe` installer.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

In your browser, choose **Connect → Outpost Desktop** for a session. The app asks you to trust the server on the first connection.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually. Closing or upgrading the app leaves remote sessions running.
