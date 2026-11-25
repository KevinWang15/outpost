// Outpost machine service: everything Outpost runs on a machine, as one executable.
import { machineSetupLabels } from '../shared/model'
import { resolve } from 'node:path'
import { terminalService } from '../shared/terminalService'
import { serveChat } from './chat'
import { runAttachCommand, runInstallCliCommand, runListCommand, runNewCommand } from './cli'
import { command, hook } from './commands'
import { unenroll, ownership, enrollSsh, authorizeNode } from './installation'
import { enrollOutbound, runOutbound } from './outbound'
import { serveMcp } from './mcp'
import { serveNode } from './node'
import { enterState, useSessionBinding } from './state'
import { serveTerminal } from './terminal'

const usage = `Usage: outpost COMMAND
  new [DIR] [OPTIONS]  create a new session (interactive TUI or --yes) and open in Outpost
  ls                   list Outpost sessions on this machine
  attach SESSION       open an existing session in an enclosing Outpost terminal
  install-cli          install the \`outpost\` command onto PATH (~/.local/bin/outpost)
  node --socket PATH   the machine end of Outpost's connection (Outpost runs it)
  serve | chat-serve   a session's terminal service or chat host (the node runs them)
  enroll ssh SOCKET    bind this machine to the Outpost instance opening SSH
  enroll outbound URL ID enroll with a single-use code read on stdin
  connect              maintain this machine’s enrolled outbound connection
  status | unenroll    inspect ownership or release the local enrollment
  uninstall            disconnect and remove the installed executable after sessions stop
  mcp | hook           Outpost's MCP server and activity hook (coding tools run them)
  publish FILE [NAME]  share a file with the user of this session
  open URL             open a link on the user's computer
  signal TYPE JSON     send a signal to the user's terminal
  agent codex | deepseek DSH | antigravity AGY   bundled ACP adapters for chat
  --version`

const [role, ...args] = process.argv.slice(2)
const initialCwd = process.cwd()
const run = async () => {
  // Commands a coding tool runs follow their launch's binding; Outpost's own
  // processes (node, drivers) always use the state directory of their user.
  const sessionCommand = ['mcp', 'hook', 'publish', 'open', 'signal'].includes(role)
  const binding = sessionCommand ? useSessionBinding() : null
  // Every Outpost process works in the state directory, so its sockets have
  // short addresses; a file given on the command line is resolved first.
  if (role === 'publish' && args[0]) args[0] = resolve(args[0])
  if (role !== 'agent' && role !== '--version' && (!sessionCommand || binding)) enterState()
  switch (role) {
    case 'new':
    case 'create':
      return runNewCommand(args, initialCwd)
    case 'ls':
    case 'list':
      return runListCommand(args)
    case 'attach':
      return runAttachCommand(args)
    case 'install-cli':
      return runInstallCliCommand(args, initialCwd)
    case '--version':
      if (args.length) {
        if (args.length !== 2 || args[0] !== '--socket') throw Error(usage)
        const owner = authorizeNode(args[1])
        if (owner.mode !== 'ssh') throw Error('This machine uses outbound enrollment.')
      }
      return console.log(`outpost-terminal ${terminalService.version} protocol ${terminalService.protocol}`)
    case 'enroll': {
      const install = args[0] === '--install'
      if (install) args.shift()
      if (args.length === 2 && args[0] === 'ssh') return enrollSsh(args[1], install)
      if (args[0] === 'outbound' && args.length === (install ? 4 : 3)) {
        const manager = install ? args[3] : undefined
        if (manager === undefined || manager === 'systemd' || manager === 'openrc')
          return enrollOutbound(args[1], args[2], manager)
      }
      throw Error(usage)
    }
    case 'uninstall':
    case 'unenroll':
      if (args.length) throw Error(usage)
      return unenroll(role === 'uninstall')
    case 'status': {
      if (args.length) throw Error(usage)
      const owner = ownership()
      if (!owner) return console.log('Not enrolled')
      if (owner.mode === 'ssh') return console.log(`${machineSetupLabels.ssh} · ${owner.socket}`)
      const target = `${machineSetupLabels.outbound} · ${owner.origin} · ${owner.targetId}`
      return console.log(
        owner.socket === null ? `${target} · Enrollment pending. Retry the enrollment command.` : target,
      )
    }
    case 'connect':
      if (args.length) throw new Error(usage)
      return runOutbound()
    case 'node':
      if (args[0] !== '--socket' || args.length !== 2) throw new Error(usage)
      return serveNode(args[1])
    case 'serve':
      return serveTerminal()
    case 'chat-serve':
      return serveChat()
    case 'mcp':
      return serveMcp(binding)
    case 'hook':
      return binding?.driver === 'terminal' ? hook(binding.session) : undefined
    case 'publish':
    case 'open':
    case 'signal':
      if (!binding) throw new Error('Run this command inside an Outpost session.')
      return command(role, args, binding)
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
  if (role === 'hook') return // An observation failure must never veto a coding tool's action.
  console.error(`outpost: ${(error as Error).message}`)
  process.exit(1)
})
