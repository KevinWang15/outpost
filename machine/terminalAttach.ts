import type { TerminalStreamArgs } from '../shared/machine'
import { terminalService, terminalSize } from '../shared/terminalService'
import { terminalControl } from '../shared/node/terminalFrames'
import { driverStatus } from './drivers'
import { startTerminal, terminalSocket } from './launch'
import { readRegistry, RegistryError, session as findSession } from './registry'
import { touchSession } from './sessions'
export async function prepareTerminal(args: TerminalStreamArgs) {
  if (!terminalSize(args.cols, args.rows) || typeof args.start !== 'boolean')
    throw new RegistryError('Invalid terminal request', 400)
  const record = findSession(readRegistry(), args.session)
  const { terminal, chat } = await driverStatus(record.id)
  if (chat) throw new RegistryError('This session runs in chat. Choose Continue in a terminal to move it.')
  if (terminal && terminal.protocol !== terminalService.protocol)
    throw new RegistryError(
      'This session runs an older Outpost machine service. Stop it, then connect again to restart it with the current one.',
    )
  if (!terminal) {
    if (!args.start)
      throw new RegistryError('The coding tool exited. Click Reconnect to start it in the same conversation.', 410)
    await startTerminal(record, args.cols, args.rows)
  }
  await touchSession(record.id)
  const path = terminalSocket(record.id)
  const hello = terminalControl({
    type: 'attach',
    protocol: terminalService.protocol,
    cols: args.cols,
    rows: args.rows,
  })
  return { path, hello, record }
}
