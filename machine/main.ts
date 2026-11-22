// Outpost machine service: everything Outpost runs on a machine, as one executable.
import { machineSetupLabels } from '../shared/model'
import { resolve } from 'node:path'
import { terminalService } from '../shared/terminalService'
import { serveChat } from './chat'
import { command, hook } from './commands'
import { unpair, installation, installManaged, authorizeNode } from './installation'
import { pairTarget, runConnector, installDirect } from './connector'
import { serveMcp } from './mcp'
import { serveNode } from './node'
import { enterState, useBinding } from './state'
import { serveTerminal } from './terminal'

const usage = `Usage: outpost-terminal COMMAND
  node --socket PATH   the machine end of Outpost's connection (Outpost runs it)
  serve | chat-serve   a session's terminal service or chat host (the node runs them)
  pair SERVER          enroll with a single-use ${machineSetupLabels.paired} pairing code
  pair --managed PATH  bind a server-managed installation to its node socket
  pair --direct        enroll a direct-only machine with the server’s offline enrollment JSON
  connect              serve this installation using its configured network policy
  status | unpair      inspect ownership or disconnect locally and release it for reinstallation
  uninstall            disconnect and remove the managed executable after sessions stop
  mcp | hook           Outpost's MCP server and activity hook (coding tools run them)
  publish FILE [NAME]  share a file with the user of this session
  open URL             open a link on the user's computer
  signal TYPE JSON     send a signal to the user's terminal
  agent codex | deepseek DSH | antigravity AGY   bundled ACP adapters for chat
  --version`

const [role, ...args] = process.argv.slice(2)
const run = async () => {
  // Commands a coding tool runs follow their launch's binding; Outpost's own
  // processes (node, drivers) always use the state directory of their user.
  if (['mcp', 'hook', 'publish', 'open', 'signal'].includes(role)) useBinding()
  // Every Outpost process works in the state directory, so its sockets have
  // short addresses; a file given on the command line is resolved first.
  if (role === 'publish' && args[0]) args[0] = resolve(args[0])
  if (role !== 'agent' && role !== '--version') enterState()
  switch (role) {
    case '--version':
      if (args.length) {
        if (args.length !== 2 || args[0] !== '--managed') throw Error(usage)
        const owner = authorizeNode(args[1])
        if (owner.mode !== 'ssh') throw Error('This installation is paired through its connector.')
      }
      return console.log(`outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}`)
    case 'pair':
      if (args.length === 2 && args[0] === '--managed') return installManaged(args[1])
      if (args.length !== 1) throw new Error(usage)
      return args[0] === '--direct' ? installDirect() : pairTarget(args[0])
    case 'uninstall':
    case 'unpair':
      if (args.length) throw Error(usage)
      return unpair(role === 'uninstall')
    case 'status': {
      if (args.length) throw Error(usage)
      const r = installation()
      console.log(
        !r
          ? 'Not enrolled'
          : r.mode === 'ssh'
            ? 'Server-managed · ' + r.socket
            : (r.mode === 'direct' ? machineSetupLabels.direct : machineSetupLabels.paired) +
              ' · ' +
              r.origin +
              ' · ' +
              r.targetId,
      )
      return
    }
    case 'connect':
      if (args.length) throw new Error(usage)
      return runConnector()
    case 'node':
      if (args[0] !== '--socket' || args.length !== 2) throw new Error(usage)
      return serveNode(args[1])
    case 'serve':
      return serveTerminal()
    case 'chat-serve':
      return serveChat()
    case 'mcp':
      return serveMcp()
    case 'hook':
      return hook()
    case 'publish':
    case 'open':
    case 'signal':
      return command(role, args)
    case 'agent':
      if (args[0] === 'codex' && args.length === 1) {
        // The bundled adapter reads its own argv; give it none.
        process.argv.splice(2)
        await import('./vendor/codex-acp.js')
        return
      }
      if (args[0] === 'deepseek' && args.length === 2) return (await import('./agents/deepseek')).deepseekAgent(args[1])
      if (args[0] === 'antigravity' && args.length === 2)
        return (await import('./agents/antigravity')).antigravityAgent(args[1])
      throw new Error(usage)
    default:
      throw new Error(usage)
  }
}
await run().catch(error => {
  console.error(`outpost: ${(error as Error).message}`)
  process.exit(1)
})
