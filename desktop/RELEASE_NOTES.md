# Outpost Desktop 0.18.2 preview

This preview changes tab spinner rendering to address reported visual wobble.

## What's changed

- **Tab spinners:** connecting and working indicators now rotate their fixed 16×16 HTML wrapper instead of the SVG itself. This aims to make rotation look steadier when tab layout falls between device pixels.
- Stale activity indicators and reduced-motion settings still stop the animation. Bell animations keep their existing behavior.

The Windows visual result still needs confirmation. Browser geometry tests verify that the icon center remains fixed throughout rotation, including fractional tab positions.

## Update

Install Desktop **0.18.2** to try this change. No server deployment, Outpost Terminal binary update, or coding-agent restart is required. The desktop bridge remains at **version 9**.

## Install

- **Apple silicon Mac:** download `Outpost-0.18.2-mac-arm64.dmg`.
- **Intel Mac:** download `Outpost-0.18.2-mac-x64.dmg`.
- **Windows x64:** download `Outpost-0.18.2-windows-x64.exe`.

On macOS, drag Outpost to Applications and open it once. These previews have no Developer ID signature or notarization; after the first launch attempt, use **System Settings → Privacy & Security → Open Anyway** if macOS blocks the app. Windows may show **SmartScreen → More info → Run anyway**. `SHA256SUMS` lists the artifact checksums.

Use **Help → Check for updates** to open a newer release. Preview updates install manually.
