// Coding harness registry, shared by the UI, the server and the machine adapters
// in machine/harnesses/<id>.ts; see docs/ARCHITECTURE.md → "Add a coding harness".
import { quote } from './shell'

const uuid = '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
const formatPreviewArg = (arg: string) => (/^[A-Za-z0-9_./:@=+-]+$|^<[a-z-]+>$/.test(arg) ? arg : quote(arg))

export const harnesses = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    installer: { url: 'https://claude.ai/install.sh', shell: 'bash' },
    nativeId: uuid,
    nativeIdHint: 'a UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)',
    selectionOptions: [
      '--session-id',
      '--resume',
      '-r',
      '--continue',
      '-c',
      '--fork-session',
      '--no-session-persistence',
    ],
    storageKey: 'CLAUDE_CONFIG_DIR',
    storageDirectory: '.claude',
    instructions: ['terminal', 'chat'],
    servers: ['terminal', 'chat'],
    terminal: true,
    clipboard: true,
    chatAdapter: 'claude-agent-acp',
    preview: {
      instructions: (value: string) => ['--append-system-prompt', value],
      model: (value: string) => ['--model', value],
      resume: (id: string) => ['--resume', id],
      fresh: () => ['--session-id', '<new-id>'],
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    installer: { url: 'https://chatgpt.com/codex/install.sh', shell: 'sh' },
    nativeId: uuid,
    nativeIdHint: 'a UUID (e.g. 019d0000-0000-7000-8000-000000000000)',
    selectionOptions: ['resume', '--last'],
    storageKey: 'CODEX_HOME',
    storageDirectory: '.codex',
    instructions: ['terminal', 'chat'],
    servers: ['terminal', 'chat'],
    terminal: true,
    clipboard: true,
    chatAdapter: null,
    preview: {
      instructions: (value: string) => ['-c', `developer_instructions=${JSON.stringify(value)}`],
      model: (value: string) => ['-c', `model=${JSON.stringify(value)}`],
      resume: (id: string) => ['resume', id],
      fresh: () => ['resume', '<new-id>'],
    },
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    command: 'kimi',
    installer: { url: 'https://code.kimi.com/kimi-code/install.sh', shell: 'bash' },
    nativeId: '^session_[A-Za-z0-9_-]{1,120}$',
    nativeIdHint: 'a Kimi session ID starting with "session_"',
    selectionOptions: ['--session', '-S', '--continue', '-c'],
    storageKey: 'KIMI_CODE_HOME',
    storageDirectory: '.kimi-code',
    instructions: [],
    // Terminals get Outpost's server from a plugin shared by every Kimi session.
    servers: ['chat'],
    terminal: true,
    clipboard: true,
    chatAdapter: null,
    preview: {
      instructions: null,
      model: (value: string) => ['--model', value],
      resume: (id: string) => ['--session', id],
      fresh: () => ['--session', '<new-id>'],
    },
  },
  {
    id: 'deepseek',
    label: 'DeepSeek Harness',
    command: 'dsh',
    installer: { npm: '@deepseek-ai/dsh@0.2.2-rc.1' },
    nativeId: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$',
    nativeIdHint: 'a DeepSeek session ID (letters, digits, ., _, -)',
    selectionOptions: ['--resume', '--session', '--session-id', '--profile', '--from-default-profile', '--patch'],
    storageKey: 'DSH_HOME',
    storageDirectory: '.dsh',
    instructions: [],
    servers: ['chat'],
    terminal: false,
    clipboard: false,
    chatAdapter: null,
    acpArgs: ['--profile', 'acp'],
    preview: null,
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    command: 'agy',
    installer: { url: 'https://antigravity.google/cli/install.sh', shell: 'bash' },
    nativeId: uuid,
    nativeIdHint: 'a UUID (e.g. 550e8400-e29b-41d4-a716-446655440000)',
    selectionOptions: ['--conversation', '--continue', '-c'],
    storageKey: 'ANTIGRAVITY_GEMINI_DIR',
    storageDirectory: '.gemini',
    instructions: ['chat'],
    // Terminals get Outpost's server from a plugin shared by every Antigravity session.
    servers: ['chat'],
    terminal: true,
    clipboard: false,
    chatAdapter: null,
    preview: {
      instructions: null,
      model: (value: string) => ['--model', value],
      resume: (id: string) => ['--conversation', id],
      fresh: () => [] as string[],
    },
  },
] as const

export type HarnessId = (typeof harnesses)[number]['id']
export const harnessIds = harnesses.map(harness => harness.id) as HarnessId[]
export const isHarnessId = (value: unknown): value is HarnessId =>
  typeof value === 'string' && (harnessIds as string[]).includes(value)
export const harnessDefinition = (id: HarnessId) => harnesses.find(harness => harness.id === id)!
export const harnessLabel = (id: HarnessId) => harnessDefinition(id).label
export const validNativeId = (id: HarnessId, value: string) => new RegExp(harnessDefinition(id).nativeId).test(value)
export const nativeIdHint = (id: HarnessId) => harnessDefinition(id).nativeIdHint
export const supportsTerminal = (id: HarnessId) => harnessDefinition(id).terminal

type Driver = 'terminal' | 'chat'
/** Where a session's instructions or extra MCP servers apply for this tool. */
export const appliesIn = (id: HarnessId, setting: 'instructions' | 'servers'): readonly Driver[] =>
  harnessDefinition(id)[setting]

/** Tokenize a shell argument string enough to detect explicit session-selection flags. */
function shellTokens(args: string): string[] {
  return args.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? []
}

/** Whether raw user arguments already supply a session/resume selection flag for this harness. */
export function argsSelectSession(id: HarnessId, args: string): boolean {
  const options: readonly string[] = harnessDefinition(id).selectionOptions
  for (const token of shellTokens(args)) {
    if (token === '--') break
    if (
      options.some(
        option =>
          token === option ||
          token.startsWith(`${option}=`) ||
          (option.startsWith('-') && option.length === 2 && token.startsWith(option)),
      )
    )
      return true
  }
  return false
}

/** Human-readable preview of the command Outpost runs when this session starts. */
export function previewStartCommand(
  tool: HarnessId,
  settings: { instructions: string | null; model: string | null; args: string },
  conversation: string | null,
): { command: string; note: string } {
  const def = harnessDefinition(tool)
  const extra = settings.args.trim()
  if (!def.terminal || !def.preview) {
    const acpArgs = 'acpArgs' in def ? def.acpArgs : ['acp']
    const command = [def.command, ...acpArgs].join(' ')
    const note = conversation
      ? `Runs over ACP and loads conversation ${conversation}.`
      : 'Runs over ACP and starts a new conversation automatically on next start.'
    return { command, note }
  }
  const parts: string[] = [def.command]
  const instructions = settings.instructions?.trim()
  const model = settings.model?.trim()
  if (instructions && def.preview.instructions) parts.push(...def.preview.instructions(instructions))
  if (model) parts.push(...def.preview.model(model))

  const customSelection = !conversation && argsSelectSession(tool, extra)
  if (conversation) parts.push(...def.preview.resume(conversation))
  else if (!customSelection) parts.push(...def.preview.fresh())

  const base = parts.map(formatPreviewArg).join(' ')
  const command = extra ? `${base} ${extra}` : base
  const note = conversation
    ? 'Automatically resumes this conversation on start and remembers new IDs when you /new or /resume inside the tool. Outpost MCP and hooks are attached automatically.'
    : customSelection
      ? 'Uses your session arguments directly without adding an Outpost resume flag; hooks will remember the active conversation once started.'
      : 'Allocates a fresh conversation ID automatically on next start and remembers it for future restarts. Outpost MCP and hooks are attached automatically.'
  return { command, note }
}
