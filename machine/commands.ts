// Commands the coding tool runs inside a session. Each reads the launch's
// binding from its environment; none can name another session.
import { publish } from './files'
import { request } from './drivers'
import { chatSocket, terminalSocket } from './launch'
import type { SessionBinding } from './state'

async function input(limit: number) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += chunk.length
    if (size > limit) return null
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** `outpost-terminal hook`: a native lifecycle hook. It must never block or
 * fail the tool's action, and passes on only what activity tracking reads. */
export async function hook(session: string) {
  const raw = await input(16 * 1024 * 1024)
  if (!raw) return
  const payload = JSON.parse(raw.toString('utf8'))
  const kept = Object.fromEntries(
    [
      'session_id',
      'hook_event_name',
      'agent_id',
      'isSidechain',
      'source',
      'turn_id',
      'notification_type',
      'is_interrupt',
      'conversationId',
      'hookEventName',
      'terminationReason',
    ]
      .filter(key => key in payload)
      .map(key => [key, payload[key]]),
  )
  if ('lastUserInput' in payload)
    kept.hasUserInput = typeof payload.lastUserInput === 'string' && payload.lastUserInput.length > 0
  await request(terminalSocket(session), { type: 'hook', payload: kept }, 2000)
}

async function signal(session: string, type: string, payload: unknown) {
  if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024) throw new Error('Signals must fit within 32 KiB.')
  const result = await request<{ ok: boolean; message?: string }>(
    terminalSocket(session),
    { type: 'signal', signal: { type, payload } },
    15_000,
  )
  if (!result) throw new Error('No terminal client is connected to this session.')
  if (!result.ok) throw new Error(result.message ?? 'Outpost did not accept the signal.')
}

/** Tell the session's driver about a stored file, as a hint to refresh. */
export async function filesChanged(session: string, driver: SessionBinding['driver'], file: unknown) {
  await request(
    driver === 'chat' ? chatSocket(session) : terminalSocket(session),
    driver === 'chat' ? { type: 'file', file } : { type: 'files' },
    2000,
  ).catch(() => {})
}

export async function command(name: 'open' | 'signal' | 'publish', args: string[], binding: SessionBinding) {
  if (name === 'open') {
    if (args.length !== 1) throw new Error('Usage: outpost open URL')
    return signal(binding.session, 'browser.open', { url: args[0] })
  }
  if (name === 'signal') {
    if (args.length !== 2) throw new Error('Usage: outpost signal TYPE JSON')
    return signal(binding.session, args[0], JSON.parse(args[1]))
  }
  if (args.length < 1 || args.length > 2) throw new Error('Usage: outpost publish FILE [NAME]')
  const file = await publish(binding.session, args[0], args[1])
  await filesChanged(binding.session, binding.driver, file)
  console.log(JSON.stringify({ stored: true, file }))
}
