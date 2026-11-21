// Stands in for `outpost-terminal node`: prints login noise, the marker and
// hello, then answers `echo` calls, asks the server one agent call on `ask`,
// and says its event log grew on `grow`.
import { machineProtocol, nodeMagic, type MachineMessage } from '../../shared/machine'
import { FrameDecoder, terminalControl } from '../../shared/node/terminalFrames'
import { terminalService } from '../../shared/terminalService'

const send = (message: MachineMessage) => process.stdout.write(terminalControl(message))
process.stdout.write('Welcome to the machine!\n')
process.stdout.write(nodeMagic)
send({ type: 'hello', version: terminalService.version, protocol: machineProtocol, pid: process.pid })
const decoder = new FrameDecoder()
const open = new Set<number>()
let pending: number | undefined
process.stdin.on('data', (bytes: Buffer) => {
  for (const frame of decoder.feed(bytes)) {
    const message = JSON.parse(frame.payload.toString()) as MachineMessage
    if (message.type === 'open') {
      if ((message.args as { hold?: boolean }).hold) pending = message.stream
      else {
        open.add(message.stream)
        send({ type: 'opened', stream: message.stream, data: null })
      }
      continue
    }
    if (message.type === 'close' && open.delete(message.stream)) send({ type: 'close', stream: message.stream })
    if (message.type !== 'call') continue
    if (message.op === 'release-open' && pending !== undefined) {
      open.add(pending)
      send({ type: 'opened', stream: pending, data: null })
      pending = undefined
      send({ type: 'result', id: message.id, ok: true, data: null })
      continue
    }
    if (message.op === 'open-count') {
      send({ type: 'result', id: message.id, ok: true, data: open.size })
      continue
    }
    if (message.op === 'echo') send({ type: 'result', id: message.id, ok: true, data: message.args })
    else if (message.op === 'ask')
      send({ type: 'call', id: 'agent-1', op: 'agent', args: { session: 's', tool: 'list_sessions', arguments: {} } })
    else if (message.op === 'grow') {
      send({ type: 'events' })
      send({ type: 'result', id: message.id, ok: true, data: null })
    } else if (message.op === 'exit') process.exit(0)
    else send({ type: 'result', id: message.id, ok: false, error: { message: 'Session not found', status: 404 } })
  }
})
process.stdin.on('end', () => process.exit(0))
