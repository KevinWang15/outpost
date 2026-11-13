// Commands the coding tool runs inside a session. Each reads the launch's
// binding from its environment; none can name another session.
import { harnessIds } from '../shared/harnesses'
import { publish } from './files'
import { request } from './drivers'
import { chatSocket, terminalSocket } from './launch'

function binding() {
  const session = process.env.OUTPOST_SESSION_ID
  const driver = process.env.OUTPOST_DRIVER
  if (!session || !/^[0-9a-f-]{36}$/.test(session) || (driver !== 'terminal' && driver !== 'chat')) return null
  return { session, driver } as const
}

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
export async function hook() {
  const bound = binding()
  if (!bound || bound.driver !== 'terminal') return
  try {
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
      ]
        .filter(key => key in payload)
        .map(key => [key, payload[key]]),
    )
    await request(terminalSocket(bound.session), { type: 'hook', payload: kept }, 2000)
  } catch {
    /* Observation failures surface in Outpost, never in the tool. */
  }
}

async function signal(type: string, payload: unknown) {
  const bound = binding()
  if (!bound) throw new Error('Run this inside an Outpost session.')
  if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024) throw new Error('Signals must fit within 32 KiB.')
  const result = await request<{ ok: boolean; message?: string }>(
    terminalSocket(bound.session),
    { type: 'signal', signal: { type, payload } },
    15_000,
  )
  if (!result) throw new Error('No Outpost terminal is connected to this session.')
  if (!result.ok) throw new Error(result.message ?? 'Outpost did not accept the signal.')
}

/** Tell the session's driver about a stored file, as a hint to refresh. */
export async function filesChanged(session: string, driver: 'terminal' | 'chat', file: unknown) {
  await request(
    driver === 'chat' ? chatSocket(session) : terminalSocket(session),
    driver === 'chat' ? { type: 'file', file } : { type: 'files' },
    2000,
  ).catch(() => {})
}

export async function command(name: string, args: string[]) {
  if (name === 'open') {
    if (args.length !== 1) throw new Error('Usage: outpost open URL')
    return signal('browser.open', { url: args[0] })
  }
  if (name === 'signal') {
    if (args.length !== 2) throw new Error('Usage: outpost signal TYPE JSON')
    return signal(args[0], JSON.parse(args[1]))
  }
  if (name === 'publish') {
    const bound = binding()
    if (!bound) throw new Error('Run this inside an Outpost session.')
    if (args.length < 1 || args.length > 2) throw new Error('Usage: outpost publish FILE [NAME]')
    const file = await publish(bound.session, args[0], args[1])
    await filesChanged(bound.session, bound.driver, file)
    console.log(JSON.stringify({ stored: true, file }))
    return
  }
  throw new Error(`Unknown command. Coding tools: ${harnessIds.join(', ')}`)
}
