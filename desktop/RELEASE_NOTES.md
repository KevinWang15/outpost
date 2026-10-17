# Outpost Desktop 0.9.0 preview

Browser sign-in to multiple Outpost servers, with all your remote sessions available from the app.

## What's new

- **Multiple server logins:** enter a server URL in the Outpost tab, or use the website's **Connect Outpost app** button. Sign in and approve app access in your system browser. The app never handles your account password or browser cookies.
- **One server list:** the Outpost tab shows **Logged-in Outpost servers**, with connection status, refresh, and sign-out controls. App access lasts 30 days; expired access requires signing in again.
- **First-use trust:** an unfamiliar server asks for confirmation before connecting. Acceptance is remembered independently of login. Cancelling stops that attempt without saving a refusal. There is no separate trusted-server list.
- **Find all remote sessions:** right-click **+ → Outpost terminal…** for a new tab, or a tab's **Split with Outpost terminal…** to add a remote pane. Search sessions across all logged-in servers by name, target, tool, directory, or server. Use arrow keys and Enter, click a result, or press Escape to cancel.
- **Shared connection behavior:** website handoffs, recent-session shortcuts, and the finder request access through the same server login. An already-open session reuses its pane; selecting it for a split moves that pane while preserving its connection and draft.
- **Cleaner login lifecycle:** pending browser sign-ins are separate from saved accounts. Cancellation, expiry, sign-out, concurrent requests, and app shutdown have explicit ownership. An unavailable server does not prevent other servers from signing in.
- **Pane appearance:** split-pane headers fill their bounds beside the divider.

Use Desktop **0.9.0** with the matching server update. After installing, connect your servers through browser sign-in. The previous credential-bearing app links and saved terminal credentials have been removed. Recent-session shortcuts now store references without credentials.

**Outpost Terminal 1.2.0** remains the required helper (service protocol 4; client protocol 13). This release does not require updating that helper or restarting target sessions. Closing or upgrading the app leaves remote sessions running. Local shells end when their panes or the app close.

Validation for this update includes lint, formatting, TypeScript, and web/server/desktop builds. Runtime multi-server SSO flows have not yet been exercised end to end. GitHub Actions builds the macOS and Windows installers.

## Install

- **Apple silicon Mac:** download `Outpost-0.9.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.9.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.9.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. Only proceed with a release you trust. `SHA256SUMS` lists the artifact checksums.

Open the Outpost logo tab to connect a server. You can also choose **Connect → Outpost Desktop** on the website to sign in and open a specific session. For a local shell, click **+**.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
