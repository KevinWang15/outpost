# Chat mode

Outpost has two ways to work with the same sessions:

- **Terminal** (`/`): each session is the coding tool's own terminal interface in
  a persistent PTY, as before.
- **Chat** (`/chat`, and a Chat window in Outpost Desktop): each session is a
  conversation with streamed replies, folded steps, inline permission requests
  and the agent's mode and model. Sessions can share **channels**, message each
  other, and run on **schedules**.

Both modes are views of one managed session and one native conversation (Claude
Code's transcript, Codex's rollout, Kimi's session). A conversation started in
one mode continues in the other.

## Principles

1. **The coding tool's own protocol.** Chat drives the tool through the
   [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1), the
   standard editors such as Zed and JetBrains use. Outpost does not parse
   terminal output, patch the tool, or reimplement its agent.
2. **One driver per conversation.** A session runs either its terminal service
   or its chat host, never both: two processes writing one transcript would fork
   it. Opening the other mode first ends the running one; the conversation stays.
3. **The target owns the chat**, as it owns the terminal. A chat host on the
   target keeps the agent, its prompt queue and its history while browsers,
   SSH and the Outpost server come and go.
4. **ACP inside, Outpost envelope around it.** Payloads are ACP types. The
   envelope adds what one ACP client connection lacks: sequence numbers, many
   viewers, a prompt queue, and who a prompt came from.
5. **Outpost composes, the agent decides.** Channels, session messages and
   schedules become ordinary prompts with a short `[Outpost: …]` header. Agents
   use Outpost only through its MCP tools; their replies are their own turns.

## Components

```text
browser / Outpost Desktop chat window
        ⇅  one WebSocket per page: /api/chat (session lists, journals, actions)
Outpost server — ChatHub: links to chat hosts, channels, deliveries, schedules
        ⇅  same transport as terminals: SSH or local shell → runtime chat relay
target — outpost-terminal chat-serve (one per session, persistent)
        ⇅  ACP over stdio
coding tool's ACP server: claude-agent-acp · codex-acp (bundled) · kimi acp
        ⇅  the tool's own CLI and native store
```

| Piece | Code | Role |
| --- | --- | --- |
| Chat host | `terminal-service/chat.ts` | The persistent ACP client of one session: starts the tool's ACP server, opens the native conversation, queues prompts, journals updates, answers permission requests from viewers, forwards Outpost MCP calls to the server |
| Host contract | `shared/chatHost.ts` | Envelope messages, the journal both ends apply, bounds |
| Transcript model | `shared/chatTranscript.ts` | Turns and items for display, live or replayed |
| Target runtime | `runtime/outpost_chat.py`, `outpost_runtime.py` | Starts the host, enforces one driver, relays frames, records a new conversation's identity, chat settings |
| Harness adapters | `chat_command`, `chat_resumable`, `chat_mcp_servers` in `runtime/outpost_<id>.py` | How each tool serves ACP |
| Server | `backend/chat/` | Links, hub (routing), store, socket, tokens |
| Web app | `frontend/chat/` | The chat UI, also loaded by Outpost Desktop |
| Desktop | `desktop/src/chat-windows.ts`, `chat-preload.ts` | One chat window per server account |

## Coding tools over ACP

| Tool | ACP server | Installed by |
| --- | --- | --- |
| Claude Code | Official [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) release, run with the target's own `claude` (`CLAUDE_CODE_EXECUTABLE`) | Required Software (`claude-agent-acp`, pinned in `shared/chatAgents.json`) |
| Codex | Official [`codex-acp`](https://github.com/agentclientprotocol/codex-acp), run with the target's own `codex` (`CODEX_PATH`) | Bundled in Outpost Terminal (`outpost-terminal agent codex`), fetched with an integrity pin by `scripts/vendor-agents.mjs` |
| Kimi Code | `kimi acp` | Kimi itself |

The Claude adapter is installed rather than bundled because it depends on
Anthropic's proprietary Agent SDK; Outpost does not redistribute it. Its release
archive's own `claude` is removed after installation. Codex's adapter and its
dependencies are Apache-2.0/MIT/BSD JavaScript using only Node built-ins.

Session instructions (chat settings) are sent as ACP `systemPrompt` in `append`
mode. Claude Code and Codex advertise it; Kimi does not, and the chat says so.
The chat host advertises no file-system or terminal client capability: tools
use their own. It declares `_meta.terminal_output_delta`, the convention Codex
uses to stream command output.

## Conversation identity

Outpost pins each session's native conversation (`cliSessionId`). A chat host
opens it with `session/load` when it exists (`chat_resumable`); the agent replays
its history as ACP updates. A new Claude conversation has no transcript until
its first prompt, so the host starts it with `session/new` and enters the
`identity` state: the relay records the agent's id in the session registry,
then the host accepts prompts. A restart therefore always finds the conversation.

## The chat host

`outpost-terminal chat-serve` reads its launch configuration on stdin, listens on
`~/.outpost/chats/<session>.sock` (owner-only), and outlives its viewers. After
ten minutes with no viewer, no turn, no request waiting for approval and no
unseen reply, it stops; opening the chat starts it again in the same
conversation. The target runtime's `status` (SO_PEERCRED-checked, like the
terminal service) reports its state and the same `SessionActivity` as terminal
sessions, so lists and badges work in both modes. Terminate ends either driver.

Requests (`shared/chatHost.ts`): `hello` (viewer or hub), `prompt` (with a key:
a retried key is the same turn), `cancel`, `unqueue`, `permission`, `config`,
`mode`, `seen`, `note`, `answer`, `ping`; one-shot `status` and `seen` without
hello.

**Journal.** Entries are `queued`, `started`, `ended`, `update` (an ACP
`SessionUpdate`), `permission`/`resolved`, `history` markers and `notice`. The
host assigns sequence numbers; a viewer applies the same entries in order with
the same `ChatJournal`, so streamed text chunks and tool reports coalesce
identically on both ends. A gap means resubscribe. The journal keeps 20,000
entries or 16 MiB of UTF-8 JSON, so a snapshot always fits one 32 MiB relay
frame, dropping the oldest like terminal scrollback; the native
store still has the whole conversation. Tool reports and other agent data are
bounded per field; prompt images are not journaled (only their metadata).
Latest-value state (mode, config, commands, usage, title, activity) is `ChatInfo`,
replaced rather than journaled.

**Activity.** Working while a turn runs or waits in the queue, Waiting during a
permission request, Error after a failed turn or a stopped tool, Needs you after
a reply nobody has seen (channel replies are read in their channel instead).

## Server

`ChatLink` is the server's one connection to a session's chat host, shared by
every viewer and by routing. It mirrors the journal, reconnects without
restarting a stopped tool, and closes a minute after nothing needs it (no
viewer, no delivery in flight, no running turn). Like a terminal connection, it
pings a host that has sent nothing for 15 s and replaces a connection silent
for 30 s (60 s before the host's welcome); any byte counts, so a large
snapshot on a slow link is not mistaken for silence.

`ChatHub` keeps, per owner, the session list across targets (polled every 15 s
while a page is open, with live chat activity merged in), handles, channels,
deliveries, threads and schedules. State is in `<workspace>/chat/` (atomic JSON;
channel messages are append-only JSONL). Deliveries are persisted with their
composed prompt until accepted, and recovered after a server restart.

**Channels.** Members reply only when mentioned (`@handle`, or `@all`). Each
mentioned member gets one prompt with the channel messages it has not received
(at most 30 / 16 KiB, newest kept), and its turn's final message is posted back.
A reply that mentions another member passes the conversation on; chains stop
after 6 hops or 12 deliveries per user message, with a notice. A member mentioned
again while working gets the newer messages after its turn.

**Session messages.** Outpost's MCP server (`runtime/outpost_mcp.py`) adds
`list_sessions` and `message_session` in chat mode. The call travels agent →
MCP process → chat host socket → hub. The recipient works in its own chat; its
final message returns to the sender as a new turn. A thread allows 6 messages.

**Under failures.** A delivery ends in exactly one reply or one visible notice
(`tests/integration/chat-faults.test.ts` injects the faults below).

- A host welcome carries its `instance` (one per host process). A delivery
  records the instance its prompt was sent to. Prompt keys deduplicate within one
  instance, so resending to it is safe and resending to another is not.
- A request that reached a host but got no answer is *unconfirmed*, not failed.
  The host's journal `queued` entry carries the key and the turn, so the hub
  learns the turn even when the answer is lost. After a reconnect, an
  unconfirmed delivery is resent to the same instance. If the instance changed, it
  fails with a notice that the message may not have run.
- A server restart keeps deliveries as they were. On start the hub reconnects to
  their sessions and to every chat-driven session that is working, so agents'
  Outpost tool calls get answers.
- The chat host holds an agent's Outpost tool call while no server is connected
  (up to 45 s), and forwards it again if the server's connection drops before
  the answer. The hub answers a repeated call ID with the first answer;
  `message_session` also records the call ID on its delivery, so a call repeated
  across a server restart sends one message.
- The composer keeps one key for a draft until the server accepts it, so
  sending the same draft again is recognized: by the chat host's prompt keys in
  a session, and by the key stored with each channel post, also after a server
  restart.

**Schedules.** Five-field cron in an IANA time zone (`shared/cron.ts`), fired at
most once per matching minute while the server runs. A schedule's prompt runs in
its session's own chat.

**Authorization.** Browser pages use their login cookie; the socket is subject
to the same origin checks as every route. Outpost Desktop's chat page has no
login: its preload exchanges the app bearer (main process only) for a
single-use, five-minute chat ticket (`POST /api/desktop/chat/connect`). The hello
returns a 30-day resume grant bound to the login; prompt images are uploaded with
it (`POST /api/chat/images`, 5 MiB, held in memory for ten minutes).

## Limits and known gaps

- Schedules fire only while the Outpost server runs; missed times are not caught up.
- A chat host does not survive a target reboot or a crash of the tool; opening
  the chat starts it again and the conversation continues.
- Terminal-mode arguments (`args`) do not apply to chat; the agent's mode and
  model are chosen in the chat instead.
- Sessions running in a terminal cannot receive channel or session messages
  until they are opened in chat.
- Channel images and server-side Web Push are not implemented. Phones use the
  web app; there is no native mobile app.
- A prompt whose host restarted before confirming it is reported as possibly not
  run; Outpost cannot tell whether the old process started it. A message typed in
  a session's chat is never resent automatically: if its confirmation is lost the
  page says so, and the journal shows whether it was queued. Sending the same
  draft again cannot run it twice unless the chat host also restarted.
- An agent's Outpost tool call fails if no server connects within 45 s.
- ACP v1 has no client-driven steering; a message sent while a turn runs waits
  in the queue.
