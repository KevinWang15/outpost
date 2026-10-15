import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = await readFile(new URL('../../public/terminal-notifications.js', import.meta.url), 'utf8')
const origin = 'https://outpost.example'
const destination = `${origin}/terminal?target=box&session=coding`

function worker(windows: { url: string; focus(): Promise<void> }[] = []) {
  const events = new Map<string, (event: unknown) => void>()
  const opened: string[] = []
  let closed = 0,
    claimed = 0,
    skipped = 0
  runInNewContext(source, {
    URL,
    self: {
      location: { origin },
      addEventListener: (type: string, callback: (event: unknown) => void) => events.set(type, callback),
      skipWaiting: async () => {
        skipped++
      },
      clients: {
        claim: async () => {
          claimed++
        },
        matchAll: async () => windows,
        openWindow: async (url: string) => {
          opened.push(url)
        },
      },
    },
  })
  async function dispatch(type: string, url?: unknown) {
    let work: Promise<void> | undefined
    events.get(type)!({
      notification: {
        data: { url },
        close: () => {
          closed++
        },
      },
      waitUntil: (promise: Promise<void>) => {
        work = promise
      },
    })
    await work
  }
  return { dispatch, events, opened, counts: () => ({ closed, claimed, skipped }) }
}

test('notification worker activates immediately and has no caching or background-push handlers', async () => {
  const instance = worker()
  assert.deepEqual([...instance.events.keys()], ['install', 'activate', 'notificationclick'])
  await instance.dispatch('install')
  await instance.dispatch('activate')
  assert.deepEqual(instance.counts(), { closed: 0, claimed: 1, skipped: 1 })
})

test('notification clicks focus the matching session without navigating or duplicating it', async () => {
  let focused = 0
  const instance = worker([
    {
      url: `${origin}/terminal?target=other&session=coding`,
      focus: async () => {
        throw new Error('Wrong session')
      },
    },
    {
      url: `${destination}&title=Renamed`,
      focus: async () => {
        focused++
      },
    },
  ])
  await instance.dispatch('notificationclick', destination)
  assert.equal(focused, 1)
  assert.deepEqual(instance.opened, [])
  assert.equal(instance.counts().closed, 1)
})

test('a missing or concurrently closed session window opens the normal authenticated terminal URL', async () => {
  for (const windows of [
    [],
    [
      {
        url: destination,
        focus: async () => {
          throw new Error('Closed')
        },
      },
    ],
  ]) {
    const instance = worker(windows)
    await instance.dispatch('notificationclick', destination)
    assert.deepEqual(instance.opened, [destination])
  }
})

test('notification click data cannot open another origin, scheme, or application path', async () => {
  for (const url of [
    undefined,
    null,
    '',
    'https://evil.example/terminal?target=x&session=y',
    'javascript:alert(1)',
    '/terminal/desktop#token=secret',
    '/api/targets',
    '/terminal?target=x',
    'http://[',
    '//evil.example/terminal?target=x&session=y',
  ]) {
    const instance = worker()
    await instance.dispatch('notificationclick', url)
    assert.deepEqual(instance.opened, [], String(url))
    assert.equal(instance.counts().closed, 1)
  }
})
