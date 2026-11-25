---
title: Desktop & Web Terminals
section: Core Concepts
order: 40
summary: Master Outpost Desktop split panes, search, scrollback, clipboard, image paste, and the web terminal.
---

# Desktop & Web Terminals

Every terminal-capable session can be opened in **Outpost Desktop** (native GPUI app for Windows and macOS) or directly in any modern browser via the **Web terminal**. Both attach to the exact same running process on your Linux machine.

## Outpost Desktop

Outpost Desktop combines your **local shell** (PowerShell, CMD, WSL on Windows; zsh/bash on macOS) and your **remote Outpost sessions** in one fast native workspace.

### Tabs and split panes

- **Tabs**: Open multiple remote sessions and local shells side-by-side in the tab strip. Drag tabs to reorder them or pull a tab out into its own window.
- **Splits**: Split any pane vertically or horizontally from the pane menu or keyboard shortcuts.
- **Drag panes**: Drag any pane header or tab to split another pane — a cursor-following preview pill and contextual drop overlay show exactly where the pane will land (left, right, top, bottom, or as a new tab).

### Terminal search

Press `Ctrl+F` (`Cmd+F` on macOS) to open the iTerm2-style find bar:

- Incremental highlighting across both the visible viewport and full scrollback history.
- Toggle **Case sensitive** (`Aa`), **Whole word** (`W`), and **Regex** (`.*`).
- Step through matches with `Enter` / `Shift+Enter` or the previous/next buttons; press `Esc` to close and return focus to the terminal.

### Scrollbar and scrollback

- An iTerm2-style overlay capsule scrollbar appears when scrolling or hovering near the right edge of a pane and auto-hides when idle.
- Drag the thumb for smooth scrubbing through deep scrollback histories (configurable in **Settings**, including **Unlimited scrollback**).
- Keyboard scrollback shortcuts let you jump by page, line, or straight to the top/bottom of history.

### Native ergonomics

- **Image paste**: Copy a screenshot and paste normally (`Ctrl+V` / `Cmd+V`) — Outpost uploads the image to the remote machine and passes it to the coding agent.
- **Newlines**: Press `Shift+Enter` to insert a literal newline in coding tools without submitting the prompt.
- **Clipboard (OSC 52)**: Copy inside remote tools (including `tmux` or editors) and it lands on your local clipboard.
- **Auto-open from CLI**: Running `outpost new` or `outpost attach` inside any Outpost Desktop pane (including a local WSL/SSH shell pane!) automatically opens and focuses the target session in a new tab. See [Machine CLI](05-machine-cli.md#auto-open-in-outpost).

## Web terminal

The Web terminal runs in desktop and mobile browsers (including as a standalone PWA):

- Includes a mobile **KeyBar** (`Ctrl`, `Alt`, `Esc`, `Tab`, arrows) and a multiline text composer for phone input.
- Supports session file browsing, image paste, in-terminal search, bell notifications, and **OSC 7770 auto-open** when you run `outpost new` or `outpost attach` inside a web terminal.
