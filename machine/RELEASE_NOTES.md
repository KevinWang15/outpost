# Outpost machine service 2.6.2

Everything Outpost runs on a machine, as one executable. Terminal service
protocol 6, chat host protocol 3, node protocol 3.

- File publication and removal notify each attached terminal once. Closing an attachment releases its machine stream.
- Machine state locks are released automatically if the process exits.
- History search uses `mixed` for combined keyword and semantic results. Message pages count Unicode code points. Existing V3 installations must rebuild the generated history index with the matching server.

- The CLI reports enrollment as Relay enabled, Direct only or Server-managed.
- Direct-only machines import a deployment verification key offline and accept
  authenticated client requests on their HTTPS endpoint. They never establish
  an Outpost relay link. The native and browser terminals use the same policy.
- Linux installations reserve one execution account and one server/machine
  identity for the host. `outpost-terminal status` shows the owner and
  `outpost-terminal unpair` disconnects the installation before reassignment.
  Upgrade the server and machine executable together.
- Relay-enabled machines enroll with `outpost-terminal pair SERVER` and stay online
  with `outpost-terminal connect`. A client can reach a session through the
  public server when both machines are behind NAT. An advertised HTTPS endpoint
  enables direct connections. Terminal data, pasted images and published files
  travel over the selected attachment.
- `outpost-terminal node`: the machine end of the one connection Outpost keeps
  to each machine an account uses. It answers session, file, search and history
  operations, carries terminal and chat attachments and file transfers as
  streams, and forwards agents' calls to Outpost's tools to the server. It also
  serves the machine's event log, so Outpost's Logs show when sessions start,
  work, finish and stop, including while Outpost was not connected.
- `outpost-terminal serve` and `chat-serve`: a session's terminal service (its
  coding tool in a persistent PTY) and chat host (its ACP client). Both keep the
  session's activity, and the terminal service types in messages from other
  sessions, channels and schedules when the agent is idle and nobody is typing.
  Both start the coding tool with the session's instructions, model and MCP
  servers where the tool supports them; chat also selects its mode.
- `outpost-terminal mcp` and `hook`: Outpost's MCP server, with the same tools
  for every session, and the coding tools' activity hook. `publish`, `open` and
  `signal` serve programs running in a session.
- `outpost-terminal agent codex | deepseek | antigravity`: the bundled ACP adapters for chat.

Install the binary matching the Outpost server before deploying the server.
