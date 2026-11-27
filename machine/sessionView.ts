import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { chatHost } from '../shared/chatHost'
import { supportsTerminal } from '../shared/harnesses'
import type { ChatStreamArgs, TerminalStreamArgs } from '../shared/machine'
import { terminalService, terminalSize, validScrollback } from '../shared/terminalService'
import { terminalControl } from '../shared/node/terminalFrames'
import { ChatTerminal } from './chatTerminal'
import { TerminalChat } from './terminalChat'
import { driverStatus } from './drivers'
import { startChat, startTerminal } from './launch'
import { withSessionLock, RegistryError } from './registry'
import { touchSession } from './sessions'
import { chatSocket, socketAddress, terminalSocket } from './state'

/** The first explicit start chooses the agent interface. Every subsequent view joins the same process. */
export async function openSessionView(view: 'terminal' | 'chat', args: TerminalStreamArgs | ChatStreamArgs) {
  const size = 'cols' in args ? args : null
  if (
    typeof args.start !== 'boolean' ||
    (view === 'terminal' &&
      (!size ||
        !terminalSize(size.cols, size.rows) ||
        (size.scrollback !== undefined && !validScrollback(size.scrollback))))
  )
    throw new RegistryError('Invalid session attachment.', 400)
  return withSessionLock(args.session, async record => {
    const running = await driverStatus(record.id)
    let driver = running.terminal ? 'terminal' : running.chat ? 'chat' : null
    if (!driver) {
      if (!args.start)
        throw new RegistryError('The coding tool is stopped. Start it to continue the conversation.', 410)
      driver = view === 'terminal' && supportsTerminal(record.tool) ? 'terminal' : 'chat'
      if (driver === 'terminal' && size) await startTerminal(record, size.cols, size.rows, size.scrollback)
      else await startChat(record)
    }
    if (
      (running.terminal && running.terminal.protocol !== terminalService.protocol) ||
      (running.chat && running.chat.protocol !== chatHost.protocol)
    )
      throw new RegistryError('The running session uses an incompatible machine service. Stop it and start it again.')
    await touchSession(record.id)
    let stream: Duplex
    if (view === 'chat' && running.terminal) stream = new TerminalChat(record, running.terminal.pid)
    else if (view === 'terminal' && driver === 'chat' && size)
      stream = new ChatTerminal(record.id, size.cols, size.rows)
    else {
      const socket = connect(socketAddress(driver === 'chat' ? chatSocket(record.id) : terminalSocket(record.id)))
      if (view === 'terminal' && size)
        socket.write(
          terminalControl({
            type: 'attach',
            protocol: terminalService.protocol,
            cols: size.cols,
            rows: size.rows,
            scrollback: size.scrollback,
          }),
        )
      stream = socket
    }
    return { record, stream }
  })
}
