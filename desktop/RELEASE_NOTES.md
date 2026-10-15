# Outpost Desktop 0.2 preview

Your coding sessions now share one tabbed workspace on macOS and Windows.

## What's new

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

Use ⌘T on Mac or Ctrl+Shift+T on Windows to choose another session. The Settings page lists all shortcuts. Up to 32 tabs can stay open. Closing the app leaves remote sessions running; reconnect through your Outpost server after reopening. Local shells and extensions are not included.

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
