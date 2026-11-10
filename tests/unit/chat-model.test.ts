import assert from 'node:assert/strict'
import test from 'node:test'
import { handles, mentionParts, mentions } from '../../shared/chatMentions'
import { cronMatches, describeCron, nextRun, parseCron } from '../../shared/cron'
import { channelPrompt } from '../../backend/chat/prompts'
import { promptHeaderPattern } from '../../shared/chatTranscript'
import type { Channel, ChannelMessage } from '../../shared/chatApi'

test('chat handles: unique per owner, clashes take the target name', () => {
  const result = handles([
    { targetId: 'a', sessionId: '1', name: 'API server', target: 'Workstation' },
    { targetId: 'b', sessionId: '2', name: 'API server', target: 'GPU box' },
    { targetId: 'a', sessionId: '3', name: 'Docs', target: 'Workstation' },
    { targetId: 'a', sessionId: '4', name: 'all', target: 'Workstation' },
    { targetId: 'a', sessionId: '5', name: '日本', target: 'Workstation' },
  ])
  assert.deepEqual(
    [...result.values()],
    ['api-server-workstation', 'api-server-gpu-box', 'docs', 'all-workstation', 'session'],
  )
})

test('chat mentions: known handles only, @all addresses everyone, emails are not mentions', () => {
  const known = ['coder', 'writer']
  assert.deepEqual(mentions('@coder and @writer, not @nobody', known), {
    handles: ['coder', 'writer'],
    everyone: false,
  })
  assert.deepEqual(mentions('mail me@coder.dev; @all please', known), { handles: [], everyone: true })
  assert.deepEqual(mentions('(@Coder) then @coder- again', known), { handles: ['coder'], everyone: false })
  assert.deepEqual(
    mentionParts('ask @coder now', known).map(part => part.mention),
    [null, 'coder', null],
  )
})

test('cron: fields, steps, weekday OR rule and time zones', () => {
  const weekdays = parseCron('30 9 * * 1-5')
  // 2026-11-10 is a Tuesday. 09:30 in Tokyo is 00:30 UTC.
  assert.equal(cronMatches(weekdays, new Date('2026-11-10T00:30:00Z'), 'Asia/Tokyo'), true)
  assert.equal(cronMatches(weekdays, new Date('2026-11-10T00:30:00Z'), 'UTC'), false)
  assert.equal(cronMatches(weekdays, new Date('2026-11-08T00:30:00Z'), 'Asia/Tokyo'), false)
  const either = parseCron('0 0 1 * 0')
  assert.equal(cronMatches(either, new Date('2026-11-01T00:00:00Z'), 'UTC'), true) // 1st (also a Sunday)
  assert.equal(cronMatches(either, new Date('2026-11-08T00:00:00Z'), 'UTC'), true) // Sunday
  assert.equal(cronMatches(either, new Date('2026-11-09T00:00:00Z'), 'UTC'), false)
  assert.equal(
    nextRun(parseCron('*/15 * * * *'), 'UTC', new Date('2026-11-10T10:07:30Z'))?.toISOString(),
    '2026-11-10T10:15:00.000Z',
  )
  assert.throws(() => parseCron('* * *'), /five fields/)
  assert.throws(() => parseCron('60 * * * *'), /Invalid minute/)
  assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00')
  assert.equal(describeCron('5 */4 * * *'), 'Every 4 hours at :05')
})

test('channel prompts: attributed header, newest messages within bounds', () => {
  const channel: Channel = {
    id: 'c',
    name: 'release',
    topic: '',
    createdAt: '',
    members: [
      { targetId: 't', sessionId: '1', name: 'Coder', handle: 'coder' },
      { targetId: 't', sessionId: '2', name: 'Writer', handle: 'writer' },
    ],
  }
  const message = (index: number): ChannelMessage => ({
    id: String(index),
    channelId: 'c',
    at: '',
    author: { kind: 'user' },
    text: `note ${index}`,
    mentions: [],
    root: String(index),
    hop: 0,
    turn: null,
  })
  const prompt = channelPrompt(
    channel,
    'coder',
    Array.from({ length: 40 }, (_, index) => message(index)),
  )
  assert.equal(prompt.match(promptHeaderPattern)?.[1], '#release')
  assert.match(prompt, /You are @coder in the Outpost channel #release\. Members: @coder, @writer\./)
  assert.match(prompt, /\(10 older not shown\)/)
  assert.ok(prompt.includes('the user: note 39'))
  assert.ok(!prompt.includes('note 9\n'))
})
