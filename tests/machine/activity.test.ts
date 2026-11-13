// A terminal session's activity from its tool's transcript and hooks, without the tool.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { type TestContext } from 'node:test'
import type { SessionActivity } from '../../shared/activity'
import {
  acknowledgeResting,
  isUserInput,
  readActivity,
  restingActivity,
  TerminalActivity,
} from '../../machine/activity'
import { harness } from '../../machine/harnesses'
import { readRegistry } from '../../machine/registry'
import { statePath } from '../../machine/state'
import { reverseRecords } from '../../machine/stores'
import { machine, record, register, uuid } from './fixtures'

const tools = ['claude', 'codex', 'kimi'] as const
type Tool = (typeof tools)[number]
type State = 'working' | 'finished' | 'idle'
const time = (second = 0) => `2026-10-01T00:00:0${second}Z`

/** A native record for a main-turn state, as each tool writes it. */
function event(tool: Tool, state: State, second = 0): Record<string, unknown> {
  if (tool === 'codex')
    return {
      type: 'event_msg',
      timestamp: time(second),
      payload: {
        type: { working: 'task_started', finished: 'task_complete', idle: 'turn_aborted' }[state],
        turn_id: 'turn',
      },
    }
  if (tool === 'claude') {
    if (state === 'idle')
      return {
        type: 'user',
        timestamp: time(second),
        message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      }
    return {
      type: state === 'working' ? 'user' : 'assistant',
      timestamp: time(second),
      message: {
        role: state === 'working' ? 'user' : 'assistant',
        stop_reason: state === 'working' ? null : 'end_turn',
        content: 'PRIVATE_TURN_CONTENT',
      },
    }
  }
  return {
    type: state === 'working' ? 'turn.prompt' : 'turn.ended',
    time: Date.parse(time(second)),
    agentId: 'main',
    turnId: 0,
    reason: state === 'finished' ? 'completed' : 'cancelled',
  }
}

/** A session of `tool` with an empty transcript, and its activity. */
async function fixture(t: TestContext, tool: Tool) {
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
  const append = (value: Record<string, unknown>, complete = true) =>
    appendFileSync(path, JSON.stringify(value) + (complete ? '\n' : ''))
  return { home, session, conversation, path, start, append, changes }
}

/** The state after reading what the tool wrote. */
const current = (activity: TerminalActivity) => (activity.refresh(), activity.current)

test('a turn finishes once; seeing it clears it and a new turn is a new completion', async t => {
  for (const tool of tools)
    await t.test(tool, async t => {
      const { start, append, session } = await fixture(t, tool)
      const activity = start()
      assert.equal(current(activity).state, 'idle')
      append(event(tool, 'working'))
      assert.equal(current(activity).state, 'working')
      append(event(tool, 'finished', 1))
      const first = current(activity)
      assert.equal(first.state, 'finished')
      assert.ok(first.completionId)
      assert.deepEqual(
        current(activity),
        { ...first, observedAt: activity.current.observedAt },
        'reading is not seeing',
      )
      assert.equal(activity.acknowledge(first.completionId!), true)
      assert.equal(current(activity).state, 'idle')
      append(event(tool, 'working', 2))
      append(event(tool, 'finished', 3))
      const second = current(activity)
      assert.equal(second.state, 'finished')
      assert.notEqual(second.completionId, first.completionId)
      assert.equal(activity.acknowledge(first.completionId!), false, 'an old completion cannot clear a new one')
      assert.equal(current(activity).state, 'finished')
      activity.input()
      assert.equal(current(activity).state, 'idle')
      assert.ok(!JSON.stringify(readActivity(session.id)).includes('PRIVATE_TURN_CONTENT'))
    })
})

test('input while working does not see a reply that is still being written', async t => {
  for (const tool of tools)
    await t.test(tool, async t => {
      const { start, append, path } = await fixture(t, tool)
      const activity = start()
      append(event(tool, 'working'))
      activity.input()
      assert.equal(current(activity).state, 'working')
      append(event(tool, 'finished', 1), false)
      activity.input()
      assert.equal(current(activity).state, 'working', 'a torn record is not read')
      appendFileSync(path, '\n')
      assert.equal(current(activity).state, 'finished')
    })
})

test('a restart does not replay an old reply or treat an old prompt as a turn', async t => {
  for (const tool of tools)
    await t.test(tool, async t => {
      const { start, append } = await fixture(t, tool)
      append(event(tool, 'finished'))
      assert.equal(current(start()).state, 'idle', 'a reply from before the launch was seen')
      append(event(tool, 'working', 1))
      const restarted = start()
      assert.equal(current(restarted).state, 'idle', 'a prompt left from before the launch is not running')
      append(event(tool, 'working', 2))
      assert.equal(current(restarted).state, 'working')
    })
})

test('subagent replies are not the main turn; an interrupt ends it', async t => {
  const ignored: Record<Tool, Record<string, unknown>> = {
    codex: { type: 'event_msg', timestamp: time(1), payload: { type: 'agent_message', message: 'task_complete' } },
    claude: { ...event('claude', 'finished', 1), isSidechain: true },
    kimi: { ...event('kimi', 'finished', 1), agentId: 'subagent' },
  }
  for (const tool of tools)
    await t.test(tool, async t => {
      const { start, append } = await fixture(t, tool)
      const activity = start()
      append(event(tool, 'working'))
      append(ignored[tool])
      assert.equal(current(activity).state, 'working')
      append(event(tool, 'idle', 2))
      assert.equal(current(activity).state, 'idle')
    })
  const claude = harness('claude')
  assert.equal(claude.activity({ type: 'assistant', message: { stop_reason: 'tool_use' } })?.state, 'working')
  assert.equal(claude.activity({ type: 'user', message: { content: [{ type: 'tool_result' }] } })?.state, 'working')
  assert.equal(claude.activity({ type: 'system', subtype: 'api_error' })?.state, 'error')
  assert.equal(claude.activity({ type: 'assistant', isApiErrorMessage: true, message: {} })?.state, 'error')
})

test('Claude: a prompt flushed after its reply does not hide the reply or a later error', async t => {
  const { start, append } = await fixture(t, 'claude')
  const activity = start()
  append(event('claude', 'finished', 1))
  append(event('claude', 'working', 0))
  const first = current(activity)
  assert.equal(first.state, 'finished')
  activity.acknowledge(first.completionId!)
  append(event('claude', 'working', 2))
  assert.equal(current(activity).state, 'working')
  append(event('claude', 'finished', 3))
  assert.equal(current(activity).state, 'finished')
  append({ type: 'system', subtype: 'api_error', timestamp: time(5) })
  append(event('claude', 'working', 4))
  assert.equal(current(activity).state, 'error')
  assert.equal(current(start()).state, 'error', 'also when read backwards at launch')
})

test('Claude: a reply after a record larger than the backward window is found', async t => {
  const { start, append } = await fixture(t, 'claude')
  append(event('claude', 'working'))
  append({ type: 'attachment', payload: 'x'.repeat(4 * 1024 * 1024) })
  const activity = start()
  append(event('claude', 'finished', 1))
  assert.equal(current(activity).state, 'finished')
})

test('Codex: a huge record after a reply does not hide it at launch', async t => {
  const { start, append, session } = await fixture(t, 'codex')
  const running = start()
  append(event('codex', 'working'))
  append(event('codex', 'finished', 1))
  append({ type: 'response_item', payload: 'x'.repeat(4 * 1024 * 1024) })
  assert.equal(current(running).state, 'finished')
  running.exited()
  // The unseen reply survives the driver.
  assert.equal(restingActivity(session.id).state, 'finished')
  acknowledgeResting(session.id, restingActivity(session.id).completionId!)
  assert.equal(restingActivity(session.id).state, 'idle')
})

test('a replaced transcript is a new file: its reply was not seen', async t => {
  const { start, append, path } = await fixture(t, 'claude')
  const activity = start()
  append(event('claude', 'finished'))
  assert.equal(current(activity).state, 'finished')
  activity.input()
  assert.equal(current(activity).state, 'idle')
  const replacement = `${path}.new`
  writeFileSync(replacement, JSON.stringify(event('claude', 'finished', 1)) + '\n')
  renameSync(replacement, path)
  assert.equal(current(activity).state, 'finished')
})

test("Codex: a rollout linked from outside the tool's store is not read", async t => {
  const { start, path, home } = await fixture(t, 'codex')
  const outside = join(home, 'secret.jsonl')
  writeFileSync(outside, JSON.stringify(event('codex', 'working')) + '\n')
  unlinkSync(path)
  symlinkSync(outside, path)
  assert.equal(current(start()).state, 'idle')
})

test('an exited tool is not working, but its unseen reply stays', async t => {
  const { start, append } = await fixture(t, 'kimi')
  const activity = start()
  append(event('kimi', 'working'))
  assert.equal(current(activity).state, 'working')
  activity.exited()
  assert.equal(activity.current.state, 'idle')
})

test('hooks: turns, late events, subagents and compaction', async t => {
  const { start, append, conversation } = await fixture(t, 'claude')
  const activity = start()
  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    activity.hookEvent({ session_id: conversation, hook_event_name: event, ...extra })
  await hook('UserPromptSubmit')
  assert.equal(activity.current.state, 'working')
  await hook('Notification', { notification_type: 'permission_prompt' })
  assert.equal(activity.current.state, 'waiting')
  await hook('PreToolUse')
  await hook('Stop', { agent_id: 'subagent-1' })
  assert.equal(activity.current.state, 'working', 'a subagent stopping is not the reply')
  await hook('PostToolUseFailure', { is_interrupt: false })
  assert.equal(activity.current.state, 'working', 'a failed tool is handled within the turn')
  await hook('Stop')
  const finished = activity.current
  assert.equal(finished.state, 'finished')
  await hook('Stop')
  assert.equal(activity.current.completionId, finished.completionId, 'a late Stop is the same reply')
  await hook('SessionEnd')
  assert.equal(activity.current.state, 'finished', 'ending the session keeps the unseen reply')
  await hook('SessionStart', { source: 'compact' })
  assert.equal(activity.current.completionId, finished.completionId)
  await activity.hookEvent({ session_id: 'not-an-id', hook_event_name: 'UserPromptSubmit' })
  assert.equal(activity.current.state, 'finished')
  // A newer native completion in the same turn recovers a missed Stop.
  await hook('UserPromptSubmit')
  assert.equal(activity.current.state, 'working')
  await new Promise(resolve => setTimeout(resolve, 5))
  append({ ...event('claude', 'finished'), timestamp: new Date().toISOString() })
  assert.equal(current(activity).state, 'finished')
})

test('hooks: a cancelled tool ends the turn', async t => {
  const { start, conversation } = await fixture(t, 'claude')
  const activity = start()
  await activity.hookEvent({ session_id: conversation, hook_event_name: 'UserPromptSubmit' })
  await activity.hookEvent({ session_id: conversation, hook_event_name: 'PostToolUseFailure', is_interrupt: true })
  assert.equal(activity.current.state, 'idle')
})

test('hooks: another conversation selected in the tool becomes current and moves to this session', async t => {
  const { start, session, home } = await fixture(t, 'claude')
  const other = record(home, 'claude', '22222222-2222-4222-8222-222222222222')
  await register(other)
  const activity = start()
  await activity.hookEvent({ session_id: other.conversations[0].id, hook_event_name: 'SessionStart', source: 'resume' })
  assert.equal(activity.currentConversation, other.conversations[0].id)
  const registry = readRegistry()
  const mine = registry.sessions.find(item => item.id === session.id)!
  const theirs = registry.sessions.find(item => item.id === other.id)!
  assert.deepEqual(
    mine.conversations.map(item => item.id),
    [uuid, other.conversations[0].id],
  )
  assert.equal(theirs.conversations[0].movedTo, session.id)
  // A late event from the conversation left behind changes nothing.
  await activity.hookEvent({ session_id: uuid, hook_event_name: 'Stop' })
  assert.equal(activity.current.state, 'idle')
})

test('focus reports are not input; keys and pastes are', () => {
  for (const data of ['', '\x1b[I', '\x1b[O']) assert.equal(isUserInput(Buffer.from(data)), false, JSON.stringify(data))
  for (const data of ['x', '\r', '\x1b[A', '\x1b[200~hello\x1b[201~'])
    assert.equal(isUserInput(Buffer.from(data)), true, JSON.stringify(data))
})

test('saved activity is derived: a damaged file reads as none', async t => {
  const { session } = await fixture(t, 'claude')
  mkdirSync(statePath('activity'), { recursive: true })
  writeFileSync(statePath('activity', `${session.id}.json`), '{"conversation":')
  assert.equal(readActivity(session.id), null)
  assert.equal(restingActivity(session.id).state, 'idle')
})

test("hooks: the transcript's late copy of a seen reply is not a new one", async t => {
  const { start, append, conversation } = await fixture(t, 'claude')
  const activity = start()
  await activity.hookEvent({ session_id: conversation, hook_event_name: 'UserPromptSubmit' })
  await activity.hookEvent({ session_id: conversation, hook_event_name: 'Stop' })
  activity.acknowledge(activity.current.completionId!)
  await new Promise(resolve => setTimeout(resolve, 5))
  append({ ...event('claude', 'finished'), timestamp: new Date().toISOString() })
  assert.equal(current(activity).state, 'idle')
  await activity.hookEvent({ session_id: conversation, hook_event_name: 'Stop' })
  assert.equal(current(activity).state, 'idle', 'a duplicate Stop does not alert again')
})

test('Kimi: resolving one approval leaves another one waiting', async t => {
  const { start, append, path } = await fixture(t, 'kimi')
  const at = Date.parse(time())
  const record = (type: string, id: string) => ({ type, id, agentId: 'main', turnId: 0, time: at })
  const activity = start()
  append(event('kimi', 'working'))
  append(record('interaction.request', 'one'))
  append(record('interaction.request', 'two'))
  assert.equal(current(activity).state, 'waiting')
  append(record('interaction.resolved', 'two'))
  assert.equal(current(activity).state, 'waiting', 'one approval is still open')
  const end = statSync(path).size
  assert.equal(harness('kimi').marker(reverseRecords(path, end))?.activity.state, 'waiting', 'also read backwards')
  append(record('interaction.resolved', 'one'))
  assert.equal(current(activity).state, 'working')
  append({ ...event('kimi', 'finished', 1), agentId: 'agent-1' })
  assert.equal(current(activity).state, 'working', "a subagent's end is not the turn's")
  append({ ...event('kimi', 'idle', 2), reason: 'failed' })
  assert.equal(current(activity).state, 'error')
})

test('Codex: review mode is reported as untracked work until it exits', async t => {
  const { start, append } = await fixture(t, 'codex')
  const activity = start()
  append({ type: 'event_msg', timestamp: time(), payload: { type: 'entered_review_mode' } })
  assert.equal(current(activity).state, 'unknown')
  assert.match(activity.current.detail!, /cannot track/)
  append({ type: 'event_msg', timestamp: time(1), payload: { type: 'exited_review_mode' } })
  assert.equal(current(activity).state, 'idle')
  append({ ...event('codex', 'finished', 2), payload: { type: 'task_complete', turn_id: 't', error: 'quota' } })
  assert.equal(current(activity).state, 'error')
})
