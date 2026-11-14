# Outpost Terminal 2.2.0

Everything Outpost runs on a machine, as one executable. Terminal service
protocol 5, chat host protocol 3, node protocol 2.

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
- `outpost-terminal agent codex | deepseek`: the bundled ACP adapters for chat.

Install the binary matching the Outpost server before deploying the server.
