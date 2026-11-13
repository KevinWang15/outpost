// Starting a session's driver: the terminal service (the tool's own terminal
// interface in a PTY) or the chat host (its ACP server). Both get the same
// binding and the same Outpost MCP servers.
import { spawn, spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { SessionRecord } from '../shared/model'
import { quote, shellJoin } from '../shared/shell'
import type { Launch, McpServer } from './harnesses/harness'
import { harness } from './harnesses'
import { current, readRegistry, RegistryError } from './registry'
import { machineExecutable, state, statePath, writeFile } from './state'
import { driverStatus } from './drivers'

type Driver = 'terminal' | 'chat'
export const terminalSocket = (session: string) => `terminals/${session}.sock`
export const chatSocket = (session: string) => `chats/${session}.sock`

/** The launch's binding, read by every Outpost process the tool starts. */
const binding = (session: SessionRecord, driver: Driver) => ({
  OUTPOST_SESSION_ID: session.id,
  OUTPOST_STATE_DIRECTORY: state.directory,
  OUTPOST_DRIVER: driver,
})

const servers = (session: SessionRecord, driver: Driver): McpServer[] => [
  { name: 'outpost', command: machineExecutable(), args: ['mcp'], env: binding(session, driver) },
]

export function which(command: string, path = process.env.PATH ?? '') {
  for (const directory of path.split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      /* Not here. */
    }
  }
  return null
}

/** Helpers on the session's PATH: `outpost publish FILE` and the BROWSER program. */
function installHelpers() {
  const executable = machineExecutable()
  const helpers = {
    outpost: `#!/bin/sh\nexec ${quote(executable)} "$@"\n`,
    'outpost-browser': `#!/bin/sh\nexec ${quote(executable)} open "$@"\n`,
  }
  for (const [name, content] of Object.entries(helpers)) {
    const path = statePath('bin', name)
    try {
      if (readFileSync(path, 'utf8') === content) continue
    } catch {
      /* Missing. */
    }
    writeFile(path, content, 0o700)
  }
}

function environmentFor(session: SessionRecord) {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) environment[key] = value
  delete environment.TMUX
  delete environment.TMUX_PANE
  return { ...environment, ...session.config.env, ...session.storage }
}

/** Everything a driver needs to run the session's coding tool. */
export function prepare(session: SessionRecord, driver: Driver) {
  if (!existsSync(session.rootDir) || !statSync(session.rootDir).isDirectory())
    throw new RegistryError('Session root directory no longer exists')
  const conversation = current(session)
  if (conversation.movedTo) {
    const owner = readRegistry().sessions.find(item => item.id === conversation.movedTo)
    throw new RegistryError(
      `This conversation moved to ${owner?.name ?? 'another session'}. Choose what to resume in this session.`,
    )
  }
  const adapter = harness(session.tool)
  const environment = environmentFor(session)
  const executable = which(adapter.command, environment.PATH)
  if (!executable)
    throw new RegistryError(
      `${adapter.command} is not on the login PATH. Check Required Software and your shell startup files.`,
    )
  installHelpers()
  const launch: Launch = {
    session,
    conversation: conversation.id,
    executable,
    environment: { ...environment, ...binding(session, driver) },
    servers: servers(session, driver),
    hook: [machineExecutable(), 'hook'],
  }
  return { adapter, launch }
}

/** Bash runs the launch so the user's arguments keep their shell syntax; the
 * guard refuses arguments that would select another conversation. */
function launchScript(launch: Launch, options: string[]) {
  const { session } = launch
  const adapter = harness(session.tool)
  const exports = { ...session.config.env, ...session.storage, ...binding(session, 'terminal') }
  const patterns = adapter.selectionOptions
    .map(option => (option.length === 2 ? `${quote(option)}*` : `${quote(option)}|${quote(`${option}=`)}*`))
    .join('|')
  const guard = patterns
    ? `for argument in "$@"; do
  case "$argument" in
    --) break ;;
    ${patterns}) printf '%s\\n' ${quote('Outpost controls the coding tool conversation. Remove conversation-selection arguments and resume one from Outpost instead.')} >&2; exit 64 ;;
  esac
done`
    : ':'
  return [
    `cd -- ${quote(session.rootDir)}`,
    `export PATH=${quote(statePath('bin'))}:"$PATH"`,
    `export -- COLORTERM=truecolor BROWSER=${quote(statePath('bin', 'outpost-browser'))}`,
    `export -- ${Object.entries(exports)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(' ')}`,
    `launch_coding_tool() {\n${guard}\nexec ${quote(launch.executable)} ${shellJoin([...options, ...adapter.resume(session, launch.conversation)])} "$@"\n}`,
    `launch_coding_tool ${session.config.args}`,
  ].join(' &&\n')
}

/** Spawn a daemon that outlives the node, feeding its configuration on stdin. */
async function daemon(
  role: string,
  configuration: object,
  log: string,
  ready: () => Promise<boolean>,
  failure: string,
) {
  mkdirSync(statePath('logs'), { recursive: true, mode: 0o700 })
  const output = openSync(log, 'w', 0o600)
  const child = spawn(machineExecutable(), [role], {
    detached: true,
    stdio: ['pipe', output, output],
    env: process.env,
  })
  child.stdin!.end(JSON.stringify(configuration))
  let exited = false
  child.on('exit', () => (exited = true))
  child.unref()
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await ready()) return
    if (exited) {
      const tail = readFileSync(log, 'utf8').split('\n').filter(Boolean)
      const own = tail.filter(line => line.startsWith('outpost: ')).at(-1)
      throw new RegistryError(`${failure}: ${own?.slice(9) ?? tail.slice(-3).join(' ').slice(-2000)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  child.kill()
  throw new RegistryError(`${failure}: it did not become ready. Open Required Software to reinstall Outpost Terminal.`)
}

export async function startTerminal(session: SessionRecord, cols: number, rows: number) {
  const { adapter, launch } = prepare(session, 'terminal')
  if (!adapter.terminal)
    throw new RegistryError('This coding tool has no terminal interface. Open this session in Outpost Chat.')
  const bash = which('bash', launch.environment.PATH)
  if (!bash) throw new RegistryError('Bash is missing on this machine. Open Required Software to install it.')
  // The PTY child needs its own session and the PTY as controlling terminal.
  const setsid = which('setsid', launch.environment.PATH)
  if (!setsid) throw new RegistryError('setsid (util-linux) is missing on this machine. Install it first.')
  if (spawnSync(bash, ['-n', '-c', `exec "$1" ${session.config.args}`]).status !== 0)
    throw new RegistryError('The session arguments are not valid Bash syntax. Edit the session to fix them.')
  const options = await adapter.mcp(launch)
  let problem: string | null = null
  try {
    options.push(...(await adapter.hooks(launch)))
  } catch (error) {
    // Optional activity integration must never make a terminal unusable.
    problem = `Activity tracking could not start: ${(error as Error).message}`.slice(0, 2000)
  }
  mkdirSync(statePath('terminals'), { recursive: true, mode: 0o700 })
  rmSync(statePath(terminalSocket(session.id)), { force: true })
  const environment = { ...launch.environment, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  await daemon(
    'serve',
    {
      socket: terminalSocket(session.id),
      session: session.id,
      revision: session.config.revision,
      conversation: launch.conversation,
      problem,
      command: [setsid, '-c', bash, '-c', launchScript(launch, options)],
      cwd: session.rootDir,
      env: environment,
      cols,
      rows,
    },
    statePath('logs', `${session.id}.log`),
    async () => (await driverStatus(session.id)).terminal !== null,
    'The terminal could not start',
  )
}

export async function startChat(session: SessionRecord) {
  const { adapter, launch } = prepare(session, 'chat')
  const chat = adapter.chat(launch.executable)
  mkdirSync(statePath('chats'), { recursive: true, mode: 0o700 })
  rmSync(statePath(chatSocket(session.id)), { force: true })
  await daemon(
    'chat-serve',
    {
      socket: chatSocket(session.id),
      session: session.id,
      revision: session.config.revision,
      command: chat.command,
      cwd: session.rootDir,
      env: {
        ...launch.environment,
        ...chat.env,
        PATH: `${statePath('bin')}${delimiter}${launch.environment.PATH ?? ''}`,
      },
      resume: adapter.chatResumable(session, launch.conversation) ? launch.conversation : null,
      mcpServers: await adapter.chatServers(launch),
      instructions: session.config.instructions,
    },
    statePath('logs', `${session.id}.chat.log`),
    async () => (await driverStatus(session.id)).chat !== null,
    'The chat could not start',
  )
}
