// Narration copy for the v2 film. One narrator, one take per scene.
// `cues` name moments the picture reacts to; each phrase must occur in `text`.
// `hold` is the breathing room (seconds) after the last word before the next scene.
export const narrator = { name: 'Eric', id: 'cjVigY5qzO86Huf0OWal' }

export const scenes = [
  {
    id: 'hook',
    text: 'AI agents have become part of how we code. We use Codex, Claude Code, and Kimi to build features, review changes, and explore ideas. And more and more, that work runs on remote development servers. Usually, more than one.',
    cues: { agents: 'AI agents', tools: 'Codex', claude: 'Claude Code', kimi: 'Kimi', build: 'build features', review: 'review changes', explore: 'explore ideas', servers: 'remote development servers', many: 'more than one' },
    hold: 1.1,
  },
  {
    id: 'friction',
    text: "But working over SSH comes with a few rough edges. When your connection drops, the agent in that terminal can stop with it. Pasting a screenshot into a remote terminal doesn't really work. And once sessions are spread across several servers, it gets hard to remember what's running where.",
    cues: { ssh: 'over SSH', drop: 'When your connection drops', stop: 'stop with it', paste: 'Pasting a screenshot', scatter: 'And once sessions', where: "what's running where" },
    hold: 1.3,
  },
  {
    id: 'reveal',
    text: 'Meet Outpost, the AI session manager that brings it all together. Your agents run on your servers, and they stay there. From your laptop, or your desktop, you see every session, on every server, in one place.',
    cues: { product: 'Meet Outpost', run: 'Your agents run', laptop: 'From your laptop', desktop: 'or your desktop', every: 'every session', place: 'in one place' },
    hold: 1.6,
  },
  {
    id: 'create',
    text: "Starting a session takes just a moment. Pick a server, give the session a name, and choose your agent. Then point it at a project folder, with suggestions as you type. If the agent isn't installed on that server yet, the manager can install it for you.",
    cues: { server: 'Pick a server', name: 'give the session a name', agent: 'choose your agent', folder: 'point it at a project folder', missing: "If the agent isn't installed", install: 'install it for you' },
    hold: 1.6,
  },
  {
    id: 'connect',
    text: "Click Connect, and a terminal opens on your computer, already attached to the session. You see exactly what the agent is doing, and you can pick up the conversation right away. It's like remote desktop, built for coding, with no graphical desktop needed on the server.",
    cues: { click: 'Click Connect', terminal: 'a terminal opens', see: 'You see exactly', pickup: 'pick up the conversation', remote: "It's like remote desktop", built: 'built for coding', nodesk: 'no graphical desktop' },
    hold: 1.4,
  },
  {
    id: 'persist',
    text: "Because the session lives on the server, your connection is just a window into it. Close your laptop, or lose your Wi-Fi, and the agent keeps working. Later, reconnect from the same computer, or a different one, and you're right back where you left off.",
    cues: { window: 'just a window', close: 'Close your laptop', keeps: 'the agent keeps working', later: 'Later', different: 'or a different one', back: 'right back' },
    hold: 1.6,
  },
  {
    id: 'images',
    text: "Need to show the agent a screenshot or a design? Paste the image into the manager, and send it to the session. It lands right in the agent's prompt, ready for your next instruction. No more fighting a remote clipboard.",
    cues: { paste: 'Paste the image', send: 'send it to the session', lands: 'It lands', ready: 'ready for your next', nomore: 'No more' },
    hold: 1.4,
  },
  {
    id: 'search',
    text: 'Looking for an earlier conversation? Search a server by topic, phrase, or error message, and reopen the session you need. The search runs on the server itself. Your history stays there, and only the matching snippets come back.',
    cues: { search: 'Search a server', phrase: 'phrase', error: 'error message', reopen: 'reopen the session', runs: 'The search runs', stays: 'Your history stays', snippets: 'only the matching' },
    hold: 1.4,
  },
  {
    id: 'activity',
    text: 'With several agents running at once, the manager shows you where you are needed. You can see which agents are working, which are idle, and which have finished a turn and are waiting for you. Check in, and the notice clears, so you can move on to the next one.',
    cues: { working: 'which agents are working', idle: 'which are idle', waiting: 'waiting for you', check: 'Check in', clears: 'the notice clears' },
    hold: 1.4,
  },
  {
    id: 'architecture',
    text: "And your servers stay simple. They're agentless, with no extra manager service to keep running on them. The design also leaves room to grow, including support for custom AI harnesses as your workflow evolves.",
    cues: { simple: 'servers stay simple', agentless: 'agentless', service: 'no extra manager service', grow: 'room to grow', custom: 'custom AI harnesses' },
    hold: 1.4,
  },
  {
    id: 'outro',
    text: 'Whichever computer you sit down at, your agents and conversations are right where you left them. Outpost, the AI session manager. Keep the session. Keep your flow.',
    cues: { left: 'right where you left them', name: 'Outpost, the AI', session: 'Keep the session', flow: 'Keep your flow' },
    hold: 4.2,
  },
]
