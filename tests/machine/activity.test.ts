// Terminal session activity driven by OSC 7501 Program Status reports,
// plus minimal SessionStart conversation-switch hooks and on-demand reply reads.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import type { SessionActivity } from '../../shared/activity'
import {
  formatProgramStatusReply,
  formatProgramStatusReport,
  processProgramStatus,
  type ProgramStatusReport,
} from '../../shared/programStatus'
import {
  acknowledgeResting,
  isUserInput,
  readActivity,
  restingActivity,
  TerminalActivity,
} from '../../machine/activity'
import { readEvents } from '../../machine/events'
import { harness } from '../../machine/harnesses'
import { readRegistry } from '../../machine/registry'
import { Sequences } from '../../machine/sequences'
import { statePath } from '../../machine/state'
import { machine, record, register, uuid } from './fixtures'

type Tool = 'claude' | 'codex' | 'kimi' | 'antigravity'

const report = (overrides: Partial<ProgramStatusReport> & Pick<ProgramStatusReport, 'state'>): ProgramStatusReport => ({
  id: null,
  app: null,
  kind: null,
  progress: null,
  title: null,
  msg: null,
  ...overrides,
})

async function fixture(t: TestContext, tool: Tool = 'claude') {
  const home = machine(t)
  const conversation = tool === 'kimi' ? 'session_fixture' : uuid
  const session = record(home, tool, conversation)
  await register(session)
  const store = Object.values(session.storage)[0]
  const path = join(
    store,
    {
      codex: `sessions/2026/10/01/rollout-test-${uuid}.jsonl`,
      claude: `projects/project/${uuid}.jsonl`,
      kimi: 'sessions/project/session_fixture/agents/main/wire.jsonl',
      antigravity: `antigravity-cli/brain/${uuid}/.system_generated/logs/transcript_full.jsonl`,
    }[tool],
  )
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
  if (tool === 'codex') {
    const database = new DatabaseSync(join(store, 'state_5.sqlite'))
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)')
    database.prepare('INSERT INTO threads VALUES (?, ?)').run(conversation, path)
    database.close()
  }
  const changes: SessionActivity[] = []
  const start = () => {
    const activity = new TerminalActivity(session, conversation, harness(tool), value => changes.push(value))
    t.after(() => activity.exited())
    return activity
  }
  return { home, session, conversation, path, start, changes }
}

test('OSC 7501 root lifecycle: working, progress, blocked kinds, done, acknowledgement, and input', async t => {
  const { start, changes } = await fixture(t, 'claude')
  const activity = start()
  assert.equal(activity.current.state, 'idle')

  // Working + progress updates; identical heartbeats do not emit duplicate broadcasts.
  activity.reportStatus(report({ state: 'working', app: 'claude-code' }))
  assert.equal(activity.current.state, 'working')
  assert.equal(activity.current.progress, null)
  const afterStart = changes.length
  activity.reportStatus(report({ state: 'working', app: 'claude-code' }))
  assert.equal(changes.length, afterStart, 'identical working heartbeat does not spam updates')

  activity.reportStatus(report({ state: 'working', app: 'claude-code', progress: 42, msg: 'Running tests' }))
  assert.equal(activity.current.progress, 42)
  assert.equal(activity.current.detail, 'Running tests')

  // Blocked with kind + title/msg.
  activity.reportStatus(
    report({ state: 'blocked', app: 'claude-code', kind: 'permission', title: 'Bash', msg: 'Allow rm -rf build?' }),
  )
  assert.equal(activity.current.state, 'waiting')
  assert.equal(activity.current.blockedKind, 'permission')
  assert.equal(activity.current.progress, null, 'each report replaces the root record completely')
  assert.equal(activity.current.detail, 'Bash: Allow rm -rf build?')

  // Input while working/waiting does not clear active states.
  activity.input()
  assert.equal(activity.current.state, 'waiting')

  // Done creates a unique completionId; duplicate done keeps the same completionId.
  activity.reportStatus(report({ state: 'done', app: 'claude-code', msg: 'All tests passed' }))
  const first = activity.current
  assert.equal(first.state, 'finished')
  assert.ok(first.completionId)
  assert.equal(first.detail, 'All tests passed')
  assert.equal(first.blockedKind, null)

  activity.reportStatus(report({ state: 'done', app: 'claude-code', msg: 'All tests passed' }))
  assert.equal(activity.current.completionId, first.completionId, 'duplicate done keeps same completionId')

  // Acknowledge clears to idle; subsequent duplicate done does not re-alert.
  assert.equal(activity.acknowledge(first.completionId!), true)
  assert.equal(activity.current.state, 'idle')
  assert.equal(activity.current.detail, null)
  activity.reportStatus(report({ state: 'done', app: 'claude-code', msg: 'All tests passed' }))
  assert.equal(activity.current.state, 'idle', 're-emitted done after acknowledgement stays idle')

  // Next turn generates a distinct completionId; old completionId cannot clear it.
  activity.reportStatus(report({ state: 'working', app: 'claude-code' }))
  activity.reportStatus(report({ state: 'done', app: 'claude-code' }))
  const second = activity.current
  assert.equal(second.state, 'finished')
  assert.notEqual(second.completionId, first.completionId)
  assert.equal(activity.acknowledge(first.completionId!), false)
  assert.equal(activity.current.state, 'finished')

  // Typing into the terminal acknowledges the visible completion.
  activity.input()
  assert.equal(activity.current.state, 'idle')
})

test('OSC 7501 done latches across a subsequent idle until acknowledged, typed, or superseded', async t => {
  const { start, session, changes } = await fixture(t, 'codex')
  const activity = start()

  // working -> idle (without done, e.g. cancelled/Esc) stays idle.
  activity.reportStatus(report({ state: 'working', app: 'codex' }))
  activity.reportStatus(report({ state: 'idle', app: 'codex' }))
  assert.equal(activity.current.state, 'idle')
  assert.equal(activity.current.completionId, null)

  // working -> done -> idle keeps finished ("Needs you") latched with original completionId and detail.
  activity.reportStatus(report({ state: 'working', app: 'codex' }))
  activity.reportStatus(report({ state: 'done', app: 'codex', msg: 'Build green' }))
  const latched = activity.current
  assert.equal(latched.state, 'finished')
  assert.ok(latched.completionId)
  assert.equal(latched.detail, 'Build green')
  const countBeforeIdle = changes.length

  activity.reportStatus(report({ state: 'idle', app: 'codex' }))
  assert.equal(activity.current.state, 'finished')
  assert.equal(activity.current.completionId, latched.completionId)
  assert.equal(activity.current.detail, 'Build green')
  assert.equal(changes.length, countBeforeIdle, 'done -> idle does not emit spurious activity churn')

  // Acknowledging while in idle clears to idle cleanly.
  assert.equal(activity.acknowledge(latched.completionId!), true)
  assert.equal(activity.current.state, 'idle')
  assert.equal(activity.current.completionId, null)

  // A subsequent idle after acknowledgement stays idle.
  activity.reportStatus(report({ state: 'idle', app: 'codex', msg: 'Prompt ready' }))
  assert.equal(activity.current.state, 'idle')
  assert.equal(activity.current.detail, 'Prompt ready')

  // A new working/blocked/error/clear state clears an unacknowledged latched completion.
  activity.reportStatus(report({ state: 'done', app: 'codex', msg: 'First' }))
  activity.reportStatus(report({ state: 'idle', app: 'codex' }))
  assert.equal(activity.current.state, 'finished')
  activity.reportStatus(report({ state: 'clear' }))
  assert.equal(activity.current.state, 'idle')

  // Typing clears a latched done -> idle completion.
  activity.reportStatus(report({ state: 'working', app: 'codex' }))
  activity.reportStatus(report({ state: 'done', app: 'codex', msg: 'Typed clear' }))
  activity.reportStatus(report({ state: 'idle', app: 'codex' }))
  assert.equal(activity.current.state, 'finished')
  activity.input()
  assert.equal(activity.current.state, 'idle')

  // Process exit preserves an unseen latched done -> idle completion.
  activity.reportStatus(report({ state: 'working', app: 'codex' }))
  activity.reportStatus(report({ state: 'done', app: 'codex', msg: 'Ready to review' }))
  activity.reportStatus(report({ state: 'idle', app: 'codex' }))
  const persistedId = activity.current.completionId!
  activity.exited()
  assert.equal(activity.current.state, 'finished')
  assert.equal(restingActivity(session.id).state, 'finished')
  assert.equal(restingActivity(session.id).completionId, persistedId)
  assert.equal(restingActivity(session.id).detail, 'Ready to review')
})

test('OSC 7501 child records are isolated from root turn state', async t => {
  const { start } = await fixture(t, 'claude')
  const activity = start()
  activity.reportStatus(report({ state: 'working', app: 'claude-code' }))

  activity.reportStatus(report({ state: 'working', id: 'build', app: 'cargo', progress: 20 }))
  activity.reportStatus(report({ state: 'blocked', id: 'build/lint', kind: 'permission' }))
  activity.reportStatus(report({ state: 'done', id: 'subagent' }))
  activity.reportStatus(report({ state: 'clear', id: 'build' }))
  assert.equal(activity.current.state, 'working', 'child reports never hijack root state')
  assert.equal(activity.current.blockedKind, null)
  assert.equal(activity.current.progress, null)

  // Root clear resets root state cleanly.
  activity.reportStatus(report({ state: 'clear' }))
  assert.equal(activity.current.state, 'idle')
})

test('unseen completions and errors survive process exit; working/waiting become idle on exit', async t => {
  const { start, session } = await fixture(t, 'codex')
  const running = start()
  running.reportStatus(report({ state: 'working', app: 'codex' }))
  running.exited()
  assert.equal(running.current.state, 'idle')
  assert.equal(restingActivity(session.id).state, 'idle')

  // Unseen completion persists after exit and can be acknowledged while resting.
  const second = start()
  second.reportStatus(report({ state: 'working', app: 'codex' }))
  second.reportStatus(report({ state: 'done', app: 'codex', msg: 'Finished refactor' }))
  const completionId = second.current.completionId!
  second.exited()
  assert.equal(second.current.state, 'finished')
  assert.equal(restingActivity(session.id).state, 'finished')
  assert.equal(restingActivity(session.id).completionId, completionId)
  acknowledgeResting(session.id, completionId)
  assert.equal(restingActivity(session.id).state, 'idle')

  // A restarted process generates a fresh completionId that never collides with prior seen IDs.
  const third = start()
  third.reportStatus(report({ state: 'done', app: 'codex' }))
  assert.equal(third.current.state, 'finished')
  assert.notEqual(third.current.completionId, completionId)

  // Errors also persist in restingActivity after exit.
  third.reportStatus(report({ state: 'error', app: 'codex', msg: 'API quota exceeded' }))
  third.exited()
  assert.equal(restingActivity(session.id).state, 'error')
  assert.equal(restingActivity(session.id).detail, 'API quota exceeded')
})

test('Sequences + processProgramStatus stream chunked OSC 7501 reports cleanly into TerminalActivity', async t => {
  const { start } = await fixture(t, 'claude')
  const activity = start()
  const sequences = new Sequences()
  const replies: string[] = []
  let output = ''

  const wire =
    'prompt> \x1b]7501;?\x1b\\' +
    formatProgramStatusReport({ state: 'working', app: 'claude-code', progress: 60, msg: 'Indexing' }) +
    'ok'
  // Feed 3 bytes at a time to exercise escape-sequence framing across chunk boundaries.
  for (let i = 0; i < wire.length; i += 3) {
    const complete = sequences.feed(Buffer.from(wire.slice(i, i + 3)))
    if (!complete) continue
    processProgramStatus(complete, {
      output: text => {
        output += text
      },
      reply: seq => replies.push(seq),
      report: item => activity.reportStatus(item),
    })
  }
  assert.equal(output, 'prompt> ok')
  assert.deepEqual(replies, [formatProgramStatusReply('st')])
  assert.equal(activity.current.state, 'working')
  assert.equal(activity.current.progress, 60)
  assert.equal(activity.current.detail, 'Indexing')
})

test('sessionEvent tracks native conversation switches and ignores subagents, compaction, and turn state', async t => {
  const { start, session, home } = await fixture(t, 'claude')
  const other = record(home, 'claude', '22222222-2222-4222-8222-222222222222')
  await register(other)
  const activity = start()
  const cursor = readEvents(null).cursor

  // Invalid IDs, subagents and sidechains are ignored; compaction keeps the conversation.
  await activity.sessionEvent({ session_id: 'not-a-uuid', hook_event_name: 'SessionStart' })
  await activity.sessionEvent({
    session_id: other.conversations[0].id,
    hook_event_name: 'SessionStart',
    agent_id: 'subagent-1',
  })
  await activity.sessionEvent({
    session_id: other.conversations[0].id,
    hook_event_name: 'SessionStart',
    isSidechain: true,
  })
  await activity.sessionEvent({ session_id: uuid, hook_event_name: 'SessionStart', source: 'compact' })
  assert.equal(activity.currentConversation, uuid)

  // Real SessionStart switches the conversation and moves ownership in registry.json.
  await activity.sessionEvent({
    session_id: other.conversations[0].id,
    hook_event_name: 'SessionStart',
    source: 'resume',
  })
  assert.equal(activity.currentConversation, other.conversations[0].id)
  assert.equal(activity.current.state, 'idle', 'hooks never alter turn activity')
  const registry = readRegistry()
  const mine = registry.sessions.find(item => item.id === session.id)!
  const theirs = registry.sessions.find(item => item.id === other.id)!
  assert.deepEqual(
    mine.conversations.map(item => item.id),
    [uuid, other.conversations[0].id],
  )
  assert.equal(theirs.conversations[0].movedTo, session.id)

  // The move is recorded once for Logs; the ignored reports and a repeat are not.
  await activity.sessionEvent({
    session_id: other.conversations[0].id,
    hook_event_name: 'SessionStart',
    source: 'resume',
  })
  assert.deepEqual(
    readEvents(cursor).events.map(({ at: _at, ...event }) => event),
    [
      {
        type: 'conversation',
        session: session.id,
        driver: 'terminal',
        conversation: other.conversations[0].id,
        previous: uuid,
      },
    ],
  )
})

test('Antigravity: camelCase session hooks switch root conversations and ignore subagents', async t => {
  const { start, conversation } = await fixture(t, 'antigravity')
  const activity = start()
  const subagent = '33333333-3333-4333-8333-333333333333'
  const switched = '44444444-4444-4444-8444-444444444444'

  await activity.sessionEvent({ conversationId: subagent, hookEventName: 'SessionStart', hasUserInput: false })
  assert.equal(activity.currentConversation, conversation, 'subagent without direct user input is ignored')

  await activity.sessionEvent({ conversationId: switched, hookEventName: 'SessionStart', hasUserInput: true })
  assert.equal(activity.currentConversation, switched)
})

test('lastReply reads the latest complete assistant message on demand and rejects escaped symlinks', async t => {
  const { start, path } = await fixture(t, 'claude')
  const activity = start()
  assert.equal(activity.lastReply(), null)
  appendFileSync(
    path,
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-01T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'First reply' }] },
    }) + '\n',
  )
  // Append a torn line without trailing newline — must be skipped cleanly.
  appendFileSync(path, '{"type":"assistant","message":{"role":"assistant","content":"Torn')
  assert.equal(activity.lastReply(), 'First reply')

  // Codex refuses rollouts symlinked outside its pinned store.
  const codex = await fixture(t, 'codex')
  const outside = join(codex.home, 'secret.jsonl')
  writeFileSync(
    outside,
    '{"type":"response_item","payload":{"type":"message","role":"assistant","content":"SECRET"}}\n',
  )
  unlinkSync(codex.path)
  symlinkSync(outside, codex.path)
  assert.equal(codex.start().lastReply(), null)
})

test('focus reports are not input; keys and pastes are', () => {
  for (const data of ['', '\x1b[I', '\x1b[O']) assert.equal(isUserInput(Buffer.from(data)), false, JSON.stringify(data))
  for (const data of ['x', '\r', '\x1b[A', '\x1b[200~hello\x1b[201~'])
    assert.equal(isUserInput(Buffer.from(data)), true, JSON.stringify(data))
})

test('saved activity is derived: damaged or outdated files read as none', async t => {
  const { session } = await fixture(t, 'claude')
  mkdirSync(statePath('activity'), { recursive: true })
  writeFileSync(statePath('activity', `${session.id}.json`), '{"conversation":')
  assert.equal(readActivity(session.id), null)
  assert.equal(restingActivity(session.id).state, 'idle')

  // Legacy activity record missing blockedKind / progress is discarded cleanly.
  writeFileSync(
    statePath('activity', `${session.id}.json`),
    JSON.stringify({
      last: {
        state: 'error',
        updatedAt: null,
        completionId: null,
        detail: 'old',
        observation: 'current',
        observedAt: null,
      },
      seen: [],
    }),
  )
  assert.equal(readActivity(session.id), null)
  assert.equal(restingActivity(session.id).state, 'idle')
})
