---
title: Chat, Schedules & Logs
section: Tools & Workflows
order: 60
summary: Collaborate across sessions in Chat channels, automate runs with schedules, search history via MCP, and stream Logs to webhooks.
---

# Chat, Schedules & Logs

Beyond raw terminals, Outpost provides a structured **Chat** workspace, scheduled prompts, cross-machine history recall, and an audit **Logs** feed with webhook delivery.

## Outpost Chat and Channels

Open [Chat](/chat) from the sidebar to converse with any session in a clean turn-by-turn UI:

- Switch models, adjust agent modes, inspect tool calls, attach files, and approve permissions right from Chat.
- Sessions in the Chat sidebar are ordered by most recently used so active conversations stay at the top.
- Create **Channels** with multiple sessions from one or more machines and coordinate them using `@handles` (for example `@backend` or `@all`).
- Manage a session's conversations (resume, move back, or start a new conversation) directly from the session header menu.

## Schedules

Attach recurring or one-shot **Schedules** to a session from its menu (**Schedule**):

- Prompts are delivered automatically on the configured cadence.
- For terminal sessions, message delivery respects the session's **Delivery** setting (`auto` waits for the agent to finish its current turn before typing, or `manual` queues messages until you deliver them).

## Cross-machine history recall (Outpost MCP)

Outpost automatically exposes a built-in `outpost` MCP server to your coding agents. Agents can search indexed transcripts across all of your machines and tools (Claude Code, Codex, Kimi Code, Antigravity CLI, and DeepSeek Harness) using keyword, semantic, or mixed search and read surrounding turns.

## Logs and webhooks

Open [Logs and webhooks](/logs) to monitor:

- **Agent status** — when sessions start, work, finish turns, or fail.
- **Messages** — deliveries across sessions, channels, and schedules.
- **Sessions & Machines** — lifecycle events, setup runs, and connectivity errors.
- **Webhooks** — forward selected log events to Slack, Discord, or any custom HTTP endpoint in real time.
