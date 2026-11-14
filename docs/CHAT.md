# Chat mode

Outpost has two ways to work with the same sessions:

- **Machines** (`/`): sessions by machine; each session can open the coding
  tool's own terminal interface in a persistent PTY.
- **Chat** (`/chat`, and a Chat window in Outpost Desktop): each session is a
  conversation with streamed replies, folded steps, inline permission requests
  and the agent's mode and model. Sessions can share **channels**, message each
  other, and run on **schedules**.

Both modes are views of one managed session and one native conversation (Claude
Code's transcript, Codex's rollout, Kimi's or DeepSeek's session). A
conversation started in one mode continues in the other.

## Principles

1. **The coding tool's own protocol.** Chat drives the tool through the
   [Agent Client Protocol](https://agentclientprotocol.com) (ACP v1), the
   standard editors such as Zed and JetBrains use. Outpost does not parse
   terminal output, patch the tool, or reimplement its agent.
2. **One driver per conversation.** A session runs either its terminal service
   or its chat host, never both: two processes writing one transcript would fork
   it. Viewing a session starts nothing. **Continue in chat** or **Continue in a
   terminal** ends the running driver and continues the conversation in the
   other; Connect, Start in chat and sending a message start a stopped one.
3. **The machine owns the chat**, as it owns the terminal. A chat host on the
   machine keeps the agent, its prompt queue and its history while browsers,
   SSH and the Outpost server come and go.
4. **ACP inside, Outpost envelope around it.** Payloads are ACP types. The
   envelope adds what one ACP client connection lacks: sequence numbers, many
   viewers, a prompt queue, and who a prompt came from.
5. **Outpost composes, the agent decides.** Channels, session messages and
   schedules become ordinary prompts with a short `[Outpost: …]` header, then
   what was asked, then how to answer (`backend/chat/prompts.ts`). The header
   and what was asked title the conversation. Agents use Outpost only through
   its MCP tools; their replies are their own turns.

## Components

```text
browser / Outpost Desktop chat window
        ⇅  one WebSocket per page: /api/chat (session lists, journals, actions)
Outpost server — ChatHub: links to chat hosts, channels, deliveries, schedules
        ⇅  the machine connection, as for terminals: a chat stream through the node
machine — outpost-terminal chat-serve (one per session, persistent)
        ⇅  ACP over stdio
coding tool's ACP server: claude-agent-acp · codex-acp (bundled) · kimi acp · dsh
        ⇅  the tool's own CLI and native store
```

| Piece | Code | Role |
| --- | --- | --- |
| Chat host | `machine/chat.ts` | The persistent ACP client of one session: starts the tool's ACP server, opens the native conversation and records a new one in the session, queues prompts, journals updates, answers permission requests from viewers |
| Host contract | `shared/chatHost.ts` | Envelope messages, the journal both ends apply, bounds |
| Transcript model | `shared/chatTranscript.ts` | Turns and items for display, live or replayed |
| Node | `machine/node.ts`, `machine/launch.ts` | Starts the host, enforces one driver, connects chat streams to it |
| Harness adapters | `chat`, `chatResumable`, `chatServers` in `machine/harnesses/` | How each tool serves ACP |
| Server | `backend/chat/` | Links, hub (routing), store, socket, tokens |
| Web app | `frontend/chat/` | The chat UI, also loaded by Outpost Desktop |
| Desktop | `desktop/src/chat-windows.ts`, `chat-preload.ts` | One chat window per server account |

## Coding tools over ACP

| Tool | ACP server | Installed by |
| --- | --- | --- |
| Claude Code | Official [`claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) release, run with the target's own `claude` (`CLAUDE_CODE_EXECUTABLE`) | Required software (`claude-agent-acp`, pinned in `shared/chatAgents.json`) |
| Codex | Official [`codex-acp`](https://github.com/agentclientprotocol/codex-acp), run with the target's own `codex` (`CODEX_PATH`) | Bundled in Outpost Terminal (`outpost-terminal agent codex`), fetched with an integrity pin by `scripts/vendor-agents.mjs` |
| Kimi Code | `kimi acp` | Kimi itself |
| DeepSeek Harness | `dsh --profile acp`, through `outpost-terminal agent deepseek` | DeepSeek itself |

The Claude adapter is installed rather than bundled because it depends on
Anthropic's proprietary Agent SDK; Outpost does not redistribute it. Its release
archive's own `claude` is removed after installation. Codex's adapter and its
dependencies are Apache-2.0/MIT/BSD JavaScript using only Node built-ins.

Session instructions (part of the session's configuration) are sent as ACP
`systemPrompt` in `append` mode. Claude Code and Codex advertise it; Kimi does
not, and the chat says so. The session's MCP servers follow Outpost's in
`mcpServers`; servers by URL only when the agent advertises
`mcpCapabilities.http`, and otherwise the chat names the ones it left out. After
`session/new` or `session/load` (and for **New conversation**), the host selects
the session's model and mode: the agent's `model` or `mode` select option whose
value, or name ignoring case, matches, falling back to ACP modes for the mode. A
choice the agent does not offer is reported as a warning in the chat. Like other
configuration, an edit applies when the chat host next starts; its `status`
reports the revision it runs.
The chat host advertises no file-system or terminal client capability: tools
use their own. It declares `_meta.terminal_output_delta`, the convention Codex
uses to stream command output.

## Conversations

A session's timeline lists its native conversations; the last is current. A
chat host opens the current one with `session/load` when the tool can load it
(`chatResumable`); the agent replays its history as ACP updates. A new Claude
conversation has no transcript until its first prompt, so the host starts it
with `session/new` and records the agent's id as the session's current
conversation before it accepts prompts. A restart therefore always finds the
conversation. The `new` request (**New conversation** in the session's actions)
starts another conversation the same way, like `/new` in a terminal.
**Conversations** resumes an earlier one: the chat stops, the session switches,
and the chat starts again in it.

## The chat host

`outpost-terminal chat-serve` reads its launch configuration on stdin, listens on
`~/.outpost/chats/<session>.sock` (owner-only), and outlives its viewers. After
ten minutes with no viewer, no turn, no request waiting for approval and no
unseen reply, it stops; Start in chat or the next message starts it again in
the same conversation. Its `status` reports its state and the same `SessionActivity` as
terminal sessions, so lists and badges work in both modes. **Stop coding tool**
ends either driver.

Requests (`shared/chatHost.ts`): `hello`, `prompt` (with a key: a retried key
is the same turn), `cancel`, `unqueue`, `permission`, `config`, `mode`, `new`,
`seen`, `note`, `ping`; one-shot `status`, `seen`, `stop` and `file` without
hello.

**Journal.** Entries are `queued`, `started`, `ended`, `update` (an ACP
`SessionUpdate`), `permission`/`resolved`, `history` markers and `notice`. The
host assigns sequence numbers; a viewer applies the same entries in order with
the same `ChatJournal`, so streamed text chunks and tool reports coalesce
identically on both ends. A gap means resubscribe. The journal keeps 20,000
entries or 16 MiB of UTF-8 JSON, so a snapshot always fits one 32 MiB
frame, dropping the oldest like terminal scrollback; the native
store still has the whole conversation. Tool reports and other agent data are
bounded per field; image bytes are not journaled (only their metadata).
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

**Session messages.** Outpost's MCP server (`machine/mcp.ts`) serves
`list_sessions`, `message_session` and `post_to_channel` to every session, in
chat or in a terminal (see "Outpost MCP" in ARCHITECTURE.md). The call travels
agent → MCP process → the session's node → the machine connection → hub. The
recipient works in its own chat, or in its terminal, where the message is typed
in when the agent is idle (see "Messages into terminals" in ARCHITECTURE.md);
its final message returns to the sender as a new turn. A thread allows 6
messages.

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
  their sessions and lists every chat user's sessions, which reconnects their
  machines, so agents' Outpost tool calls get answers.
- While its machine is not connected, an agent's Outpost tool call waits up to
  20 s for the node's endpoint. A call whose connection drops after it was sent
  fails with an error the agent sees; it may have run, and the agent decides
  whether to try again.
- The composer keeps one key for a draft until the server accepts it, so
  sending the same draft again is recognized: by the chat host's prompt keys in
  a session, and by the key stored with each channel post, also after a server
  restart.

**Files.** Both directions use the session's file store on its target
(`~/.outpost/files/<session>`, at most 100 files and 256 MiB, 32 MiB each);
files stay until removed. The session header's Files panel lists all of them.
Pages read files over HTTP with their chat grant
(`/api/chat/files/:target/:session`); Outpost Desktop saves them through its
save dialog.

- *From the agent.* It shares a file with Outpost's `publish_file` MCP tool (or
  `outpost publish FILE`), as in terminal mode. Publishing also tells the
  chat host, which records a `file` journal entry in the running turn. The turn
  shows a card for it, and a channel reply carries the files its turn published.
- *To the agent.* The composer uploads each attached file (any type) on send:
  `POST /api/chat/files/:target/:session?name=…` with the raw bytes, stored on
  the target. The prompt carries the file IDs, at most 8. The chat host turns
  each into an ACP `resource_link` to the stored file (`file://…/content/<name>`,
  with the file's metadata in `_meta.outpost.file`), which every ACP agent
  accepts; the agent reads it with its own tools. When the agent advertises
  `sessionCapabilities.additionalDirectories`, the session's file store is added
  to its session so those reads need no extra permission. Images up to 5 MB are
  also sent inline, read when the turn starts, if the agent accepts images.
  No upload goes through the model's context as text, and the server holds no
  prompt bytes.
- *In channels.* A post's attachments are uploaded first
  (`POST /api/chat/channels/:channel/files?name=…`, staged for an hour) and kept
  with the channel on the server (`<workspace>/chat/files/<channel>/`); members'
  published files stay in their sessions. When a member is delivered messages
  that carry files, the hub copies them into the member's own session files
  (newest first, at most 8) and the delivery's prompt links them, so members on
  other machines can read them. Its prompt names each message's files and lists
  any that could not be copied.

**Schedules.** Five-field cron in an IANA time zone (`shared/cron.ts`), fired at
most once per matching minute while the server runs. A schedule's prompt runs in
its session's own chat.

**Authorization.** Browser pages use their login cookie; the socket is subject
to the same origin checks as every route. Outpost Desktop's chat page has no
login: its preload exchanges the app bearer (main process only) for a
single-use, five-minute chat ticket (`POST /api/desktop/chat/connect`). The hello
returns a 30-day resume grant bound to the login; file uploads and reads use it.
Uploads are buffered (at most two at a time per account) before they are stored.

## Limits and known gaps

- Schedules fire only while the Outpost server runs; missed times are not caught up.
- A chat host does not survive a machine reboot or a crash of the tool; Start in
  chat or the next message starts it again and the conversation continues.
- Terminal arguments (`args`) do not apply to chat; the agent's mode and
  model are chosen in the chat instead.
- Server-side Web Push is not implemented. Phones use the
  web app; there is no native mobile app.
- A prompt whose host restarted before confirming it is reported as possibly not
  run; Outpost cannot tell whether the old process started it. A message typed in
  a session's chat is never resent automatically: if its confirmation is lost the
  page says so, and the journal shows whether it was queued. Sending the same
  draft again cannot run it twice unless the chat host also restarted.
- An agent's Outpost tool call fails if its machine is not connected within 20 s.
- File cards are journal entries, so turns replayed from the native history
  after a chat host restart show none (an attachment shows as the tool's own
  link text); the Files panel still lists the files.
- A file attached to a message is stored when the message is sent. If sending
  then fails and the draft is dropped, the file stays in the session's files
  until removed. Session-to-session messages (`message_session`) carry no files.
- ACP v1 has no client-driven steering; a message sent while a turn runs waits
  in the queue.
