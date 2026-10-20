# Outpost Desktop 0.16.0 preview

More reliable activity badges for Codex, Claude Code, and Kimi across desktop and web terminals.

## What's new

- **Follow the active conversation:** native lifecycle hooks track conversation changes inside the coding agent, so activity does not stay attached to the original conversation.
- **Clear activity states:** desktop tabs and the web session list share Working, Waiting for you, Idle, completion, and error states. Permission prompts and failed turns are no longer reported as ordinary idle activity.
- **Long conversation support:** incremental transcript tracking preserves activity detection through large outputs without repeatedly rescanning the full conversation.
- **Resilient updates:** brief observation failures show the last known state for up to 15 seconds, with a visible stale indication, before reporting that activity is unavailable.
- **Reliable alerts:** delayed events and acknowledgements cannot clear newer completions or recreate an alert that was already acknowledged.

## Update together

Install Desktop **0.16.0** and update your Outpost server to the matching release code. This release changes the desktop bridge contract; an older desktop app will ask you to update when connecting to the new server. Reload existing web terminal pages after deployment.

After finishing or saving current work, restart each existing managed agent session once to load the new lifecycle hooks. Reconnecting a client alone does not install hooks into an already-running agent. New sessions load the hooks automatically. Server deployment leaves remote agent processes running.

If you run a local Outpost backend, update and restart it too; the desktop installer does not update that backend. No terminal-helper update is required.

## Install

- **Apple silicon Mac:** download `Outpost-0.16.0-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.16.0-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.16.0-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
