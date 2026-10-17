# Outpost Desktop 0.10.0 preview

Create remote sessions directly in Outpost Desktop, in a new tab or beside an existing pane.

## What's new

- **Create remote sessions:** choose **New session** beside a logged-in server, right-click **+ → New Outpost session…**, or choose **Split with new Outpost session…** from a tab's context menu.
- **One shared dialog:** select the Outpost server and execution target, then use the same name, coding tool, directory suggestions, directory creation, arguments, and environment fields as the web workspace.
- **Context-aware defaults:** the server row preselects its server; splitting beside a remote pane preselects that pane's server and target. Single available servers or targets are selected automatically.
- **Predictable placement:** Cancel leaves the layout unchanged. Creating a session opens it in the original tab or split destination. If opening fails after creation, the session remains available in the finder.
- **Shared authentication and policy:** creation uses the existing browser-approved account login and supports both local-mode and hosted servers. Credentials stay in the native process.
- **Finder loading feedback:** removed the duplicate “Loading sessions…” message.
- **Code cleanup:** the finder and creator share target validation, and switching targets clears old software-check results. Web and app creation share their form and server policy.

Use Desktop **0.10.0** with the matching server update to create sessions from the app. Existing server logins continue to work. Install missing target software through the Outpost web workspace before creating a session.

**Outpost Terminal 1.2.0** remains the required helper (service protocol 4; client protocol 13). This release does not require updating that helper or restarting target sessions. Closing or upgrading the app leaves remote sessions running. Local shells end when their panes or the app close.

Validation for this update includes lint, formatting, TypeScript, and web/server/desktop builds. Runtime creation-dialog and lifecycle flows have not yet been exercised end to end. GitHub Actions builds the macOS and Windows installers.

## Install

- **Apple silicon Mac:** download `Outpost-0.10.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.10.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.10.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

Open the Outpost logo tab to connect a server. You can also choose **Connect → Outpost Desktop** on the website to sign in and open a specific session. For a local shell, click **+**.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
