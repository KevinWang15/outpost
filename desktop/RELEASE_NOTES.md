# Outpost Desktop 0.17.1 preview

The active tab's blue underline now meets the bottom of the title bar, including when tabs overflow. The accompanying server update improves coding-agent activity reporting.

## What's new

- **Title-bar alignment:** removed the empty scrollbar lane below tabs. The slim horizontal scrollbar overlays the tabs above the active underline, without changing the title-bar height.
- **Activity reporting:** native Codex and Claude lifecycle hooks now take priority over secondary status sources. Late completion events preserve acknowledged alerts, and matching transcript completions recover missed events. Kimi activity continues to use its main-agent event stream.
- **Faster activity updates:** the server watches lifecycle and acknowledgement changes directly, with periodic refresh as a fallback. Status reporting makes no model calls and adds no conversation context.
- **Agent file publishing:** managed Codex, Claude Code and Kimi Code sessions receive the Outpost MCP integration through their own harness adapters.

## Updating

Install Desktop **0.17.1** for the title-bar fix. Update your Outpost server for the activity-reporting improvements. This release keeps desktop bridge version 8 and requires no Outpost Terminal binary update.

Existing agents already using the managed hooks receive the activity-reporting improvements after reconnecting. After saving current work, restart an older coding-agent session through Outpost once if it was started before the hook or MCP integration was installed. Newly started agents receive the integration automatically. Server deployment leaves remote agent processes running.

If you run a local Outpost backend, update and restart it too; the desktop installer does not update that backend.

## Install

- **Apple silicon Mac:** download `Outpost-0.17.1-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.17.1-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.17.1-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

## Notifications and updates

Enable **Outpost** in system notification settings. Focus / Do Not Disturb can suppress alerts. Sound starts after your first interaction with the terminal.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
