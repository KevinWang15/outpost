---
title: Machines & Setup
section: Getting Started
order: 20
summary: Enroll Linux machines over SSH or outbound tunnel, manage coding tools, and cleanly unenroll hosts.
---

# Machines & Setup

A **machine** is any Linux host (including WSL2) where Outpost runs the `outpost-terminal` machine service. Your source code, credentials, and agent transcripts stay on that machine.

## Choosing a connection method

Open [Machines](/) and click **Add a machine**:

| Method | Best when | How it works |
| --- | --- | --- |
| **Connect over SSH** | The Outpost server can reach the Linux host over SSH (directly or via a bastion/jump host). | Outpost installs `~/.outpost/bin/outpost-terminal` over SSH and opens SSH connections only when managing or attaching to sessions. |
| **Run setup on the machine** (Outbound) | The machine is behind NAT or a firewall and cannot accept inbound SSH, but can make outbound HTTPS requests to Outpost. | Run the one-time setup `curl` command on the machine. It installs a systemd or OpenRC service that maintains an authenticated outbound tunnel back to Outpost. |

> [!NOTE]
> In **Local mode**, Outpost automatically seeds your local Linux/WSL host on first run so you can create sessions right away.

## Software inspection and setup

Select a machine to view its **Software** panel:

- Outpost inspects the machine's login `PATH` and marks each supported coding tool (**Claude Code**, **Codex**, **Kimi Code**, **Antigravity CLI**, **DeepSeek Harness**) as available or missing.
- Click **Set up** next to any missing tool to install it using its official installer (or offline archives if `OUTPOST_TOOL_ASSET_DIR` is configured on the server).
- Open **View setup log** to inspect installation output and diagnostics.

## Checking status and removing a machine

On the Linux machine itself, inspect the active enrollment with:

```bash
~/.outpost/bin/outpost-terminal status
```

To cleanly move or remove a machine:

1. Run unenrollment as the original Linux execution user:
   ```bash
   # Releases enrollment and removes the outbound service, keeping your sessions and files
   ~/.outpost/bin/outpost-terminal unenroll

   # Or stop all sessions first and remove the binary too
   ~/.outpost/bin/outpost-terminal uninstall
   ```
2. Click **Remove machine** from the machine's **…** menu in [Machines](/). This closes connections and revokes any outbound credentials even if the machine is offline.

> [!IMPORTANT]
> Enrollment automatically creates `~/.outpost/bin/outpost`. To invoke `outpost` from any shell on the machine, see [Installing the Machine CLI](05-machine-cli.md#installing-the-cli).
