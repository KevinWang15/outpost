# Repeatable Onboarding Screenshot Capture

All screenshots displayed in Outpost's built-in onboarding guide (`docs/onboarding/*.png`) are generated from the real application inside a self-contained Linux GUI Docker container (`Xvfb` + Mesa Lavapipe software Vulkan + Playwright Chromium + Rust GPUI).

## Regenerating all screenshots

From the repository root (requires Docker):

```bash
npm run onboarding:capture
```

Optional flags:

- `npm run onboarding:capture -- --web-only` — regenerate only the Web UI screenshots (`web-*.png`)
- `npm run onboarding:capture -- --desktop-only` — regenerate only the Outpost Desktop screenshots (`desktop-*.png`)
- `npm run onboarding:capture -- --no-cache` — rebuild the GUI container image from scratch

## What gets generated

| File | Source | Shown in |
| --- | --- | --- |
| `web-workspace.png` | Playwright Chromium | Machines overview, software readiness, and active AI sessions |
| `web-add-machine.png` | Playwright Chromium | Add a machine wizard (SSH vs Outbound setup) |
| `web-new-session.png` | Playwright Chromium | Creating a new AI coding session in the Web UI |
| `web-connect-dialog.png` | Playwright Chromium | Connect modal (Outpost Desktop vs Web terminal) |
| `web-desktop-authorize.png` | Playwright Chromium | Browser "Connect Outpost Desktop?" approval screen |
| `desktop-connect-server.png` | Outpost Desktop (GPUI) | Entering server URL in Outpost Desktop |
| `desktop-connected.png` | Outpost Desktop (GPUI) | Connected Outpost server & recent sessions on Home |
| `desktop-create-session.png` | Outpost Desktop (GPUI) | Creating an AI session directly inside Outpost Desktop |
| `desktop-session-picker.png` | Outpost Desktop (GPUI) | Outpost sessions picker (`Ctrl+Shift+O` / `Cmd+Shift+O`) |
| `desktop-split-workspace.png` | Outpost Desktop (GPUI) | Multi-tab, split-pane AI coding workspace with live status badges |

## How the guide frames them

The guide shows every screenshot in one 16:10 frame and crops each to its subject. The crop is the `focus` value next to the screenshot in `frontend/onboarding/onboardingContent.ts`: the point that stays fixed (`x`, `y`, in percent) and how far the picture is enlarged (`zoom`). The full picture opens when a reader enlarges it. If a capture changes size or layout, check its `focus` in the running guide at `/onboarding`.

Persistent Docker volumes (`outpost-onboarding-{cargo,target,node,machine}`) cache dependencies and compiled Rust artifacts so subsequent regenerations finish quickly without touching your host `node_modules/` or `desktop/target/`.
