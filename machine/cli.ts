// Interactive and non-interactive CLI on Outpost machines (`outpost new`, `outpost ls`,
// `outpost attach`, `outpost install-cli`). Creates sessions directly on the machine and
// emits a private OSC 7770 sequence so an enclosing Outpost terminal opens them automatically.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import { harnessIds, harnessLabel, harnesses, isHarnessId, supportsTerminal, type HarnessId } from '../shared/harnesses'
import { compareSessionsByRecency, type Session, type SessionInput, type SessionRecord } from '../shared/model'
import { encodeOpenSessionOsc } from '../shared/openSessionSignal'
import { quote } from '../shared/shell'
import { desktopEntryUrl } from '../shared/desktopAuth'
import { installation } from './installation'
import { installHelpers, which } from './launch'
import { readRegistry } from './registry'
import { createSession, listSessions } from './sessions'
import { expandHomePath, machineExecutable, writeFile } from './state'
import { runNewSessionTui, type FieldId, type NewSessionDraft } from './tui'

const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/
const mcpNamePattern = /^[A-Za-z0-9_-]{1,64}$/

export interface ParsedNewArgs {
  help: boolean
  yes: boolean
  open: boolean
  json: boolean
  dir?: string
  name?: string
  tool?: HarnessId
  createDirectory?: boolean
  copyFrom?: string
  instructions?: string
  model?: string
  mode?: string
  args?: string
  env: Record<string, string>
  mcpText?: string
}

export const newUsage = `Usage: outpost new [DIR] [OPTIONS]

Create an Outpost session on this machine and open it in Outpost.
Without --yes (in a TTY), launches an interactive terminal UI pre-filled with
sensible defaults and the current directory.

Options:
  -d, --dir <PATH>           Project directory (default: current directory)
  -n, --name <NAME>          Session name (default: directory basename)
  -t, --tool <TOOL>          Coding tool (${harnessIds.join(', ')})
      --create-dir           Create directory if it does not exist
      --no-create-dir        Do not create directory if missing
      --copy-from <SESSION>  Copy settings from an existing session (name or ID)
  -i, --instructions <TEXT>  Session instructions
  -m, --model <MODEL>        Model name override
      --mode <MODE>          Agent mode for Outpost Chat
  -a, --args <ARGS>          Extra CLI arguments (Bash syntax)
  -e, --env <KEY=VALUE>      Environment variable (repeatable)
      --mcp <JSON|@FILE>     MCP servers JSON object or @path/to/file.json
  -y, --yes                  Create non-interactively without the TUI
      --no-open              Do not send auto-open escape sequence to terminal
      --json                 Print created session as JSON
  -h, --help                 Show this help`

export function parseEnvAssignment(raw: string): [string, string] {
  const eq = raw.indexOf('=')
  if (eq <= 0) throw new Error(`Invalid --env value "${raw}". Use KEY=VALUE.`)
  const key = raw.slice(0, eq)
  const value = raw.slice(eq + 1)
  if (!envNamePattern.test(key) || key.length > 128) {
    throw new Error(`Invalid environment variable name "${key}". Use letters, digits, and underscores.`)
  }
  if (value.length > 4096 || value.includes('\0')) {
    throw new Error(`Invalid environment variable value for "${key}".`)
  }
  return [key, value]
}

/** Parse space/comma-separated KEY=VALUE entries with optional single/double quotes. */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  const trimmed = text.trim()
  if (!trimmed) return out
  const tokens: string[] = []
  let current = ''
  let quoteChar: '"' | "'" | null = null
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (quoteChar) {
      if (ch === '\\' && quoteChar === '"' && i + 1 < trimmed.length) {
        current += trimmed[++i]
      } else if (ch === quoteChar) {
        quoteChar = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === ';') {
      if (current) {
        tokens.push(current)
        current = ''
      }
    } else {
      current += ch
    }
  }
  if (quoteChar) throw new Error('Unterminated quote in environment variables.')
  if (current) tokens.push(current)
  if (tokens.length > 32) throw new Error('At most 32 environment variables are supported.')
  for (const token of tokens) {
    const [key, value] = parseEnvAssignment(token)
    out[key] = value
  }
  return out
}

export function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => (/[\s,"';]/.test(v) ? `${k}=${JSON.stringify(v)}` : `${k}=${v}`))
    .join(' ')
}

export function parseMcpText(raw: string, baseDir: string): NonNullable<SessionInput['mcpServers']> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  let jsonText = trimmed
  if (trimmed.startsWith('@')) {
    const filePath = resolvePathInput(trimmed.slice(1), baseDir)
    jsonText = readFileSync(filePath, 'utf8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(`Invalid MCP servers JSON: ${(error as Error).message}`, { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MCP servers must be a JSON object keyed by server name.')
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length > 16) throw new Error('At most 16 MCP servers are supported.')
  for (const [name, server] of entries) {
    if (name === 'outpost' || !mcpNamePattern.test(name)) {
      throw new Error(`Invalid MCP server name "${name}".`)
    }
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      throw new Error(`MCP server "${name}" must be a JSON object.`)
    }
  }
  return parsed as NonNullable<SessionInput['mcpServers']>
}

export function resolvePathInput(raw: string, initialCwd: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return initialCwd
  const expanded = expandHomePath(trimmed)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(initialCwd, expanded)
}

export function parseNewArgs(argv: readonly string[]): ParsedNewArgs {
  const args = [...argv]
  const parsed: ParsedNewArgs = { help: false, yes: false, open: true, json: false, env: {} }
  const take = (flag: string, i: number): string => {
    const val = args[i + 1]
    if (val === undefined) throw new Error(`Missing value for ${flag}.`)
    return val
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true
        break
      case '-y':
      case '--yes':
      case '--non-interactive':
        parsed.yes = true
        break
      case '--no-open':
        parsed.open = false
        break
      case '--open':
        parsed.open = true
        break
      case '--json':
        parsed.json = true
        break
      case '--create-dir':
        parsed.createDirectory = true
        break
      case '--no-create-dir':
        parsed.createDirectory = false
        break
      case '-d':
      case '--dir':
        parsed.dir = take(arg, i++)
        break
      case '-n':
      case '--name':
        parsed.name = take(arg, i++)
        break
      case '-t':
      case '--tool': {
        const value = take(arg, i++).toLowerCase()
        if (!isHarnessId(value)) {
          throw new Error(`Unknown coding tool "${value}". Expected one of: ${harnessIds.join(', ')}.`)
        }
        parsed.tool = value
        break
      }
      case '--copy-from':
        parsed.copyFrom = take(arg, i++)
        break
      case '-i':
      case '--instructions':
        parsed.instructions = take(arg, i++)
        break
      case '-m':
      case '--model':
        parsed.model = take(arg, i++)
        break
      case '--mode':
        parsed.mode = take(arg, i++)
        break
      case '-a':
      case '--args':
        parsed.args = take(arg, i++)
        break
      case '-e':
      case '--env': {
        const [k, v] = parseEnvAssignment(take(arg, i++))
        parsed.env[k] = v
        break
      }
      case '--mcp':
        parsed.mcpText = take(arg, i++)
        break
      default:
        if (arg.startsWith('--') && arg.includes('=')) {
          const eq = arg.indexOf('=')
          const flag = arg.slice(0, eq)
          const val = arg.slice(eq + 1)
          args.splice(i, 1, flag, val)
          i--
          break
        }
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}\n\n${newUsage}`)
        if (parsed.dir !== undefined) throw new Error(`Unexpected argument: ${arg}\n\n${newUsage}`)
        parsed.dir = arg
        break
    }
  }
  return parsed
}

function stripControlChars(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code >= 0x20 && code !== 0x7f) out += value[i]
  }
  return out
}

export function uniqueDefaultName(dir: string, existingNames: Iterable<string>): string {
  const taken = new Set([...existingNames].map(n => n.toLowerCase()))
  const cleanBase = stripControlChars(basename(dir)).trim().slice(0, 72) || 'session'
  if (!taken.has(cleanBase.toLowerCase())) return cleanBase
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${cleanBase}-${suffix}`.slice(0, 80)
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${cleanBase}-${Date.now()}`.slice(0, 80)
}

export function detectInstalledTools(pathEnv = process.env.PATH ?? ''): {
  installed: HarnessId[]
  missing: HarnessId[]
} {
  const installed: HarnessId[] = []
  const missing: HarnessId[] = []
  for (const h of harnesses) {
    if (which(h.command, pathEnv)) installed.push(h.id)
    else missing.push(h.id)
  }
  return { installed, missing }
}

export function pickDefaultTool(
  installed: HarnessId[],
  existing: readonly Pick<SessionRecord, 'tool' | 'createdAt'>[],
): HarnessId | null {
  if (!installed.length) return null
  // Prefer the most recently created session's tool if it's still installed.
  const newest = [...existing].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (newest && installed.includes(newest.tool)) return newest.tool
  // Otherwise prefer the first terminal-capable tool (claude -> codex -> kimi -> antigravity -> deepseek).
  return installed.find(supportsTerminal) ?? installed[0]
}

function findSessionMatch(sessions: readonly SessionRecord[], ref: string): SessionRecord | null {
  const needle = ref.trim()
  if (!needle) return null
  const lower = needle.toLowerCase()
  return (
    sessions.find(s => s.id === needle) ??
    sessions.find(s => s.name.toLowerCase() === lower) ??
    sessions.find(s => s.id.startsWith(lower)) ??
    null
  )
}

function writeTerminalOsc(sequence: string, allowStdout = true): boolean {
  if (process.env.OUTPOST_FORCE_OSC === '1') {
    process.stdout.write(sequence)
    return true
  }
  // Prefer /dev/tty so the escape sequence reaches the enclosing terminal even when stdout is piped.
  if (process.platform !== 'win32') {
    try {
      const fd = openSync('/dev/tty', 'w')
      try {
        writeSync(fd, sequence)
        return true
      } finally {
        closeSync(fd)
      }
    } catch {
      /* Not attached to a controlling TTY; fall back to stdout if TTY. */
    }
  }
  if (allowStdout && process.stdout.isTTY) {
    process.stdout.write(sequence)
    return true
  }
  return false
}

export function emitOpenSessionSequence(
  session: Pick<SessionRecord, 'id' | 'name' | 'tool'>,
  options: { allowStdout?: boolean; origin?: string; targetId?: string } = {},
): {
  sent: boolean
  origin?: string
  targetId?: string
} {
  let origin = options.origin
  let targetId = options.targetId
  if (!origin || !targetId) {
    try {
      const current = installation()
      if (current?.mode === 'outbound') {
        origin ??= current.origin
        targetId ??= current.targetId
      }
    } catch {
      /* Enrollment record unreadable or unenrolled; still emit sessionId + hostname. */
    }
  }
  const sequence = encodeOpenSessionOsc(
    {
      sessionId: session.id,
      name: session.name,
      tool: session.tool,
      origin,
      targetId,
      hostname: hostname(),
    },
    process.env,
  )
  const sent = writeTerminalOsc(sequence, options.allowStdout ?? true)
  return { sent, origin, targetId }
}

function printSessionSummary(
  session: Pick<Session, 'id' | 'name' | 'tool' | 'rootDir'>,
  verb: string,
  openInfo: { sent: boolean; origin?: string; targetId?: string } | null,
) {
  console.log(`${verb} session "${session.name}" (${harnessLabel(session.tool)}) in ${session.rootDir}`)
  console.log(`  ID: ${session.id}`)
  if (openInfo?.sent) {
    console.log('  Sent auto-open signal to Outpost terminal.')
  }
  if (openInfo?.origin && openInfo?.targetId) {
    const query = new URLSearchParams({
      target: openInfo.targetId,
      session: session.id,
      title: session.name,
    })
    console.log(`  Web: ${openInfo.origin}/terminal?${query.toString()}`)
    try {
      console.log(`  App: ${desktopEntryUrl({ server: openInfo.origin })}`)
    } catch {
      /* Ignore URL formatting issues. */
    }
  }
}

export async function runNewCommand(argv: string[], initialCwd: string) {
  const parsed = parseNewArgs(argv)
  if (parsed.help) {
    console.log(newUsage)
    return
  }

  const registry = readRegistry()
  const existingSessions = [...registry.sessions].sort(compareSessionsByRecency)
  const { installed, missing } = detectInstalledTools()
  if (!installed.length) {
    throw new Error(
      'No supported coding tools are installed on this machine. Install one (e.g. claude, codex, kimi, agy, dsh) or set up Software in Outpost.',
    )
  }

  let copiedSession: SessionRecord | null = null
  if (parsed.copyFrom) {
    copiedSession = findSessionMatch(existingSessions, parsed.copyFrom)
    if (!copiedSession) {
      throw new Error(`Could not find existing session "${parsed.copyFrom}" to copy settings from.`)
    }
  }

  const resolvedDir = resolvePathInput(parsed.dir ?? initialCwd, initialCwd)
  const dirAlreadyExists = existsSync(resolvedDir) && statSync(resolvedDir).isDirectory()

  const defaultTool =
    parsed.tool ??
    (copiedSession && installed.includes(copiedSession.tool) ? copiedSession.tool : null) ??
    pickDefaultTool(installed, existingSessions)!

  const existingNames = existingSessions.map(s => s.name)
  const defaultName = parsed.name ?? uniqueDefaultName(resolvedDir, existingNames)

  const mergedEnv: Record<string, string> = {
    ...(copiedSession?.config.env ?? {}),
    ...parsed.env,
  }
  const initialMcpText =
    parsed.mcpText ??
    (copiedSession?.config.mcpServers && Object.keys(copiedSession.config.mcpServers).length > 0
      ? JSON.stringify(copiedSession.config.mcpServers)
      : '')

  const interactive = !parsed.yes && !parsed.json && Boolean(process.stdin.isTTY && process.stdout.isTTY)

  const initialDraft: NewSessionDraft = {
    name: defaultName,
    tool: defaultTool,
    rootDir: resolvedDir,
    createDirectory: parsed.createDirectory ?? (interactive ? !dirAlreadyExists : false),
    instructions: parsed.instructions ?? copiedSession?.config.instructions ?? '',
    model: parsed.model ?? copiedSession?.config.model ?? '',
    mode: parsed.mode ?? copiedSession?.config.mode ?? '',
    args: parsed.args ?? copiedSession?.config.args ?? '',
    envText: formatEnvText(mergedEnv),
    mcpText: initialMcpText,
    copyFromId: copiedSession?.id ?? null,
  }

  const validateDraft = (draft: NewSessionDraft): { field?: FieldId; message: string } | null => {
    const trimmedName = draft.name.trim()
    if (!trimmedName || trimmedName.length > 80) {
      return { field: 'name', message: 'Session name must be between 1 and 80 characters.' }
    }
    if (existingSessions.some(s => s.name.toLowerCase() === trimmedName.toLowerCase())) {
      return { field: 'name', message: `A session named "${trimmedName}" already exists on this machine.` }
    }
    if (!installed.includes(draft.tool)) {
      return { field: 'tool', message: `${harnessLabel(draft.tool)} is not installed on this machine.` }
    }
    const dir = resolvePathInput(draft.rootDir, initialCwd)
    if (!draft.rootDir.trim()) {
      return { field: 'rootDir', message: 'Project directory is required.' }
    }
    if (!draft.createDirectory && (!existsSync(dir) || !statSync(dir).isDirectory())) {
      return {
        field: 'createDirectory',
        message: 'Directory does not exist. Check "Create dir" or enter an existing directory.',
      }
    }
    if (draft.instructions.length > 32_000) {
      return { field: 'instructions', message: 'Instructions must fit within 32,000 characters.' }
    }
    if (draft.model.trim().length > 200) {
      return { field: 'model', message: 'Model name must fit within 200 characters.' }
    }
    if (draft.mode.trim().length > 200) {
      return { field: 'mode', message: 'Agent mode must fit within 200 characters.' }
    }
    if (draft.args.length > 8192) {
      return { field: 'args', message: 'Arguments must fit within 8,192 characters.' }
    }
    try {
      parseEnvText(draft.envText)
    } catch (error) {
      return { field: 'envText', message: (error as Error).message }
    }
    try {
      parseMcpText(draft.mcpText, initialCwd)
    } catch (error) {
      return { field: 'mcpText', message: (error as Error).message }
    }
    return null
  }

  let finalDraft: NewSessionDraft | null = initialDraft
  if (interactive) {
    finalDraft = await runNewSessionTui({
      initial: initialDraft,
      initialCwd,
      installedTools: installed,
      missingTools: missing,
      existingSessions,
      defaultNameForDir: dir => uniqueDefaultName(dir, existingNames),
      validate: validateDraft,
      formatEnv: formatEnvText,
    })
    if (!finalDraft) {
      console.log('Cancelled.')
      return
    }
  } else {
    const problem = validateDraft(initialDraft)
    if (problem) throw new Error(problem.message)
  }

  const rootDir = resolvePathInput(finalDraft.rootDir, initialCwd)
  const env = parseEnvText(finalDraft.envText)
  const mcpServers = parseMcpText(finalDraft.mcpText, initialCwd)
  const input: SessionInput = {
    name: finalDraft.name.trim(),
    rootDir,
    createDirectory: finalDraft.createDirectory,
    tool: finalDraft.tool,
    instructions: finalDraft.instructions.trim() || null,
    model: finalDraft.model.trim() || null,
    mode: finalDraft.mode.trim() || null,
    args: finalDraft.args,
    env,
    mcpServers,
  }

  const session = await createSession(input)
  const openInfo = parsed.open ? emitOpenSessionSequence(session, { allowStdout: !parsed.json }) : null

  if (parsed.json) {
    console.log(JSON.stringify(session))
  } else {
    printSessionSummary(session, 'Created', openInfo)
  }
}

export async function runListCommand(argv: string[]) {
  const json = argv.includes('--json')
  const help = argv.includes('-h') || argv.includes('--help')
  if (help) {
    console.log('Usage: outpost ls [--json]\n\nList Outpost sessions on this machine.')
    return
  }
  const sessions = await listSessions()
  if (json) {
    console.log(JSON.stringify(sessions))
    return
  }
  if (!sessions.length) {
    console.log('No Outpost sessions on this machine. Run `outpost new` to create one.')
    return
  }
  const nameW = Math.min(28, Math.max(4, ...sessions.map(s => s.name.length)))
  const toolW = Math.max(4, ...sessions.map(s => s.tool.length))
  const statusW = Math.max(6, ...sessions.map(s => s.status.length))
  console.log(`${'NAME'.padEnd(nameW)}  ${'TOOL'.padEnd(toolW)}  ${'STATUS'.padEnd(statusW)}  DIRECTORY`)
  for (const s of sessions) {
    const n = s.name.length > nameW ? s.name.slice(0, nameW - 1) + '…' : s.name
    console.log(`${n.padEnd(nameW)}  ${s.tool.padEnd(toolW)}  ${s.status.padEnd(statusW)}  ${s.rootDir}`)
  }
}

export async function runAttachCommand(argv: string[]) {
  const help = argv.includes('-h') || argv.includes('--help')
  if (help || argv.length === 0) {
    console.log('Usage: outpost attach <NAME_OR_ID>\n\nAsk an enclosing Outpost terminal to open an existing session.')
    if (!help) process.exitCode = 1
    return
  }
  const ref = argv.find(a => !a.startsWith('-'))
  if (!ref) throw new Error('Specify a session name or ID.')
  const registry = readRegistry()
  const session = findSessionMatch(registry.sessions, ref)
  if (!session) throw new Error(`Session "${ref}" not found on this machine.`)
  const openInfo = emitOpenSessionSequence(session)
  printSessionSummary(session, 'Opening', openInfo)
}

export function runInstallCliCommand(argv: string[], initialCwd: string) {
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(
      'Usage: outpost install-cli [--dir PATH]\n\nInstall the `outpost` CLI wrapper onto PATH (default: ~/.local/bin or /usr/local/bin for root).',
    )
    return
  }
  let targetDir: string | null = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' || argv[i] === '-d') {
      const next = argv[++i]
      if (!next) throw new Error('Missing value for --dir.')
      targetDir = resolvePathInput(next, initialCwd)
    } else if (argv[i].startsWith('--dir=')) {
      targetDir = resolvePathInput(argv[i].slice(6), initialCwd)
    } else {
      throw new Error(`Unknown option: ${argv[i]}`)
    }
  }
  installHelpers()
  const binDir = targetDir ?? (process.getuid?.() === 0 ? '/usr/local/bin' : join(homedir(), '.local', 'bin'))
  mkdirSync(binDir, { recursive: true, mode: 0o755 })
  const wrapper = join(binDir, 'outpost')
  const content = `#!/bin/sh\nexec ${quote(machineExecutable())} "$@"\n`
  writeFile(wrapper, content, 0o755)
  console.log(`Installed Outpost CLI at ${wrapper}`)
  const pathEntries = (process.env.PATH ?? '').split(delimiter)
  if (!pathEntries.includes(binDir)) {
    console.log(`Add it to your shell PATH:\n  export PATH="${binDir}:$PATH"`)
  }
}
