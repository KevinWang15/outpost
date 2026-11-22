# Outpost v3 connectivity verification · 22 November 2026

All six combinations of deployment mode and machine route passed on `c91bee59dd1e`. Each combination ran in three fresh Docker environments. One interrupted the machine connection, one replaced the workspace and then interrupted the viewer connection, and one ran the official Codex CLI through both the terminal and ACP. [Tested revision](https://github.com/KevinWang15/outpost/commit/c91bee59dd1e1ca58783dc31584baae656de5c23) · [Per-route measurements and release image digest](2026-11-22-connectivity.json)

## Reconnect time

The table shows the time until a terminal viewer automatically reattached after the network started silently dropping packets on its existing TCP connection. Traffic in both directions was dropped while new connections could still fetch workspace health. The client recovered through its normal heartbeat and retry logic. Median recovery time across the six runs was **52.8 seconds**.

| Machine route | Local tool | Hosted | Network condition |
| --- | ---: | ---: | --- |
| Direct SSH | 56.5 s | 52.5 s | The target could accept SSH. New target-initiated TCP connections were blocked. |
| SSH through a bastion | 54.1 s | 51.2 s | The target was reachable only through the jump host. New target-initiated TCP connections were blocked. |
| Run setup on the machine | 53.0 s | 51.2 s | The target initiated the connection from behind NAT. The local workspace used a reachable machine-only TLS endpoint. In hosted mode the viewer and target were behind separate NAT routers. |

## What survived interruption

- **Machine connection.** After the link came back, the terminal and ACP processes had the same Linux process IDs and start times. The pending ACP turn received one approval. The client resumed a 283,405-byte MCP download at the saved offset and verified its SHA-256 digest. The machine also received a 196,992-byte pasted PNG intact. A channel mention and a scheduled prompt each produced a retrievable file with all interactive viewers closed.
- **Workspace process.** Docker killed and removed the workspace container. Its replacement mounted the saved workspace data and, in local mode, the SSH home. The terminal reattached automatically. The original client credentials still worked. Retrying the pending channel post returned the original message ID. The machine recorded one provider invocation and one approval, and the channel displayed one agent reply.
- **Outbound enrollment.** The server committed the initial enrollment before its response was dropped. Running the same installer command again completed enrollment. Removing the enrollment prevented reconnection.

## Other environments and clients

- The unmodified Linux `codex-cli 0.171.0` and Outpost's bundled ACP adapter completed 12 user turns, one terminal turn and one ACP turn per combination. A deterministic loopback model answered the prompts. Its request log recorded one user-turn request per prompt.
- An IPv6-only target behind a bastion accepted terminal input and a pasted image. Both SSH hops used IPv6. Local bastion and hosted outbound also passed the machine interruption checks with MTU 1280, 40 ms delay, 5 ms jitter, and 0.7% configured random packet loss in each direction.
- An Ubuntu 24.04.5 arm64 VM powered off and booted with a different kernel boot ID. Its systemd service reconnected and reopened the saved session. The installed Mac Desktop 1.3.1 helper pasted a PNG, then previewed and saved the identical file returned by the agent through MCP. This check exercised the helper's image operation directly.
- All 56 Linux integration tests and 29 focused machine connection and terminal client tests passed. [Integration tests](../../tests/integration) · [Terminal client tests](../../tests/unit/terminal-socket.test.ts)
