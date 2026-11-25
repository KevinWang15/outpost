// Zero-dependency ANSI raw-mode interactive TUI for `outpost new`.
// Runs in the alternate screen buffer and always restores terminal state on exit.
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { harnessLabel, type HarnessId } from '../shared/harnesses'
import type { LaunchSettings, SessionRecord } from '../shared/model'

export interface NewSessionDraft {
  name: string
  tool: HarnessId
  rootDir: string
  createDirectory: boolean
  instructions: string
  model: string
  mode: string
  args: string
  envText: string
  mcpText: string
  copyFromId: string | null
}

export interface NewSessionTuiOptions {
  initial: NewSessionDraft
  initialCwd: string
  installedTools: HarnessId[]
  missingTools: HarnessId[]
  existingSessions: SessionRecord[]
  defaultNameForDir: (dir: string) => string
  validate: (draft: NewSessionDraft) => { field?: FieldId; message: string } | null
  formatEnv: (env: Record<string, string>) => string
}

export type FieldId =
  | 'name'
  | 'tool'
  | 'rootDir'
  | 'createDirectory'
  | 'copyFrom'
  | 'instructions'
  | 'advanced'
  | 'model'
  | 'mode'
  | 'args'
  | 'envText'
  | 'mcpText'
  | 'submit'

const ESC = '\x1b'
const RESET = `${ESC}[0m`
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const FG = `${ESC}[38;5;252m`
const MUTED = `${ESC}[38;5;244m`
const BORDER = `${ESC}[38;5;239m`
const ACCENT = `${ESC}[38;5;75m`
const ACCENT_BG = `${ESC}[48;5;24m`
const GREEN = `${ESC}[38;5;114m`
const AMBER = `${ESC}[38;5;214m`
const RED = `${ESC}[38;5;203m`
const INVERT_ACCENT = `${ESC}[1;30;48;5;75m`

function resolveDir(raw: string, cwd: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return homedir() + trimmed.slice(1)
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
}

function dirExists(raw: string, cwd: string): boolean {
  const path = resolveDir(raw, cwd)
  if (!path) return false
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  const chars = [...text]
  if (chars.length <= max) return text
  if (max === 1) return '…'
  return chars.slice(0, max - 1).join('') + '…'
}

function visibleLength(ansi: string): number {
  let len = 0
  let inEsc = false
  for (let i = 0; i < ansi.length; i++) {
    const ch = ansi[i]
    if (inEsc) {
      if (ch === 'm' || ch === 'K' || ch === 'H') inEsc = false
      continue
    }
    if (ch === '\x1b') {
      inEsc = true
      continue
    }
    len++
  }
  return len
}

function padBoxLine(content: string, innerWidth: number): string {
  const used = visibleLength(content)
  const pad = Math.max(0, innerWidth - used)
  return `${BORDER}│${RESET} ${content}${' '.repeat(pad)} ${BORDER}│${RESET}`
}

function renderTextInput(value: string, cursor: number, width: number, focused: boolean, placeholder: string): string {
  const chars = [...value]
  const clamped = Math.max(0, Math.min(cursor, chars.length))
  if (!chars.length && !focused) {
    return `${DIM}${truncate(placeholder, width)}${RESET}`
  }
  const viewWidth = Math.max(4, width)
  let start = 0
  if (clamped >= viewWidth) start = clamped - viewWidth + 1
  const slice = chars.slice(start, start + viewWidth)
  if (!focused) {
    const prefix = start > 0 ? '…' : ''
    return `${FG}${truncate(prefix + slice.join(''), viewWidth)}${RESET}`
  }
  const rel = clamped - start
  const before = slice.slice(0, rel).join('')
  const at = slice[rel] ?? ' '
  const after = slice.slice(rel + 1).join('')
  const placeholderTail = !chars.length && placeholder ? `${DIM}${truncate(placeholder, viewWidth - 1)}${RESET}` : ''
  return `${FG}${before}${ESC}[7m${at}${ESC}[27m${FG}${after}${placeholderTail}${RESET}`
}

interface ParsedKey {
  type:
    | 'char'
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'home'
    | 'end'
    | 'tab'
    | 'backtab'
    | 'enter'
    | 'backspace'
    | 'delete'
    | 'escape'
    | 'ctrl-c'
    | 'ctrl-s'
    | 'ctrl-a'
    | 'ctrl-e'
    | 'ctrl-u'
    | 'ctrl-k'
    | 'ctrl-w'
    | 'paste'
  text?: string
}

function parseKeys(chunk: string): ParsedKey[] {
  const keys: ParsedKey[] = []
  let i = 0
  while (i < chunk.length) {
    // Bracketed paste block
    if (chunk.startsWith('\x1b[200~', i)) {
      const end = chunk.indexOf('\x1b[201~', i + 6)
      const pasted = end === -1 ? chunk.slice(i + 6) : chunk.slice(i + 6, end)
      keys.push({ type: 'paste', text: pasted })
      i = end === -1 ? chunk.length : end + 6
      continue
    }
    const ch = chunk[i]
    if (ch === '\x1b') {
      const rest = chunk.slice(i)
      if (rest.startsWith('\x1b[A') || rest.startsWith('\x1bOA')) {
        keys.push({ type: 'up' })
        i += 3
        continue
      }
      if (rest.startsWith('\x1b[B') || rest.startsWith('\x1bOB')) {
        keys.push({ type: 'down' })
        i += 3
        continue
      }
      if (rest.startsWith('\x1b[C') || rest.startsWith('\x1bOC')) {
        keys.push({ type: 'right' })
        i += 3
        continue
      }
      if (rest.startsWith('\x1b[D') || rest.startsWith('\x1bOD')) {
        keys.push({ type: 'left' })
        i += 3
        continue
      }
      if (rest.startsWith('\x1b[Z')) {
        keys.push({ type: 'backtab' })
        i += 3
        continue
      }
      if (rest.startsWith('\x1b[H') || rest.startsWith('\x1bOH') || rest.startsWith('\x1b[1~')) {
        keys.push({ type: 'home' })
        i += rest.startsWith('\x1b[1~') ? 4 : 3
        continue
      }
      if (rest.startsWith('\x1b[F') || rest.startsWith('\x1bOF') || rest.startsWith('\x1b[4~')) {
        keys.push({ type: 'end' })
        i += rest.startsWith('\x1b[4~') ? 4 : 3
        continue
      }
      if (rest.startsWith('\x1b[3~')) {
        keys.push({ type: 'delete' })
        i += 4
        continue
      }
      if (rest.length === 1) {
        keys.push({ type: 'escape' })
        i += 1
        continue
      }
      // Skip unrecognized CSI/SS3 escape sequence safely.
      if (rest.startsWith('\x1b[')) {
        let j = 2
        while (j < rest.length && ((rest[j] >= '0' && rest[j] <= '9') || rest[j] === ';' || rest[j] === '?')) j++
        if (
          j < rest.length &&
          ((rest[j] >= 'A' && rest[j] <= 'Z') || (rest[j] >= 'a' && rest[j] <= 'z') || rest[j] === '~')
        ) {
          i += j + 1
          continue
        }
      } else if (rest.startsWith('\x1bO') && rest.length >= 3) {
        const c = rest[2]
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
          i += 3
          continue
        }
      }
      keys.push({ type: 'escape' })
      i += 1
      continue
    }
    const code = ch.charCodeAt(0)
    if (code === 3) keys.push({ type: 'ctrl-c' })
    else if (code === 19) keys.push({ type: 'ctrl-s' })
    else if (code === 1) keys.push({ type: 'ctrl-a' })
    else if (code === 5) keys.push({ type: 'ctrl-e' })
    else if (code === 21) keys.push({ type: 'ctrl-u' })
    else if (code === 11) keys.push({ type: 'ctrl-k' })
    else if (code === 23) keys.push({ type: 'ctrl-w' })
    else if (code === 9) keys.push({ type: 'tab' })
    else if (code === 13 || code === 10) keys.push({ type: 'enter' })
    else if (code === 127 || code === 8) keys.push({ type: 'backspace' })
    else if (code >= 32) {
      const cp = chunk.codePointAt(i)!
      const str = String.fromCodePoint(cp)
      keys.push({ type: 'char', text: str })
      i += str.length
      continue
    }
    i += 1
  }
  return keys
}

export async function runNewSessionTui(options: NewSessionTuiOptions): Promise<NewSessionDraft | null> {
  const { stdin, stdout } = process
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error('Interactive mode requires a TTY. Pass --yes to create non-interactively.')
  }

  const draft: NewSessionDraft = { ...options.initial }
  let nameTouched = false
  let createDirTouched = false
  let advancedOpen = Boolean(
    draft.model.trim() || draft.mode.trim() || draft.args.trim() || draft.envText.trim() || draft.mcpText.trim(),
  )
  let error = ''
  const cursors: Record<string, number> = {
    name: [...draft.name].length,
    rootDir: [...draft.rootDir].length,
    instructions: [...draft.instructions].length,
    model: [...draft.model].length,
    mode: [...draft.mode].length,
    args: [...draft.args].length,
    envText: [...draft.envText].length,
    mcpText: [...draft.mcpText].length,
  }

  const visibleFields = (): FieldId[] => {
    const list: FieldId[] = ['name', 'tool', 'rootDir', 'createDirectory']
    if (options.existingSessions.length > 0) list.push('copyFrom')
    list.push('instructions', 'advanced')
    if (advancedOpen) list.push('model', 'mode', 'args', 'envText', 'mcpText')
    list.push('submit')
    return list
  }

  let focused: FieldId = 'name'

  const isTextField = (
    id: FieldId,
  ): id is 'name' | 'rootDir' | 'instructions' | 'model' | 'mode' | 'args' | 'envText' | 'mcpText' =>
    ['name', 'rootDir', 'instructions', 'model', 'mode', 'args', 'envText', 'mcpText'].includes(id)

  const applyCopyFrom = (sessionId: string | null) => {
    draft.copyFromId = sessionId
    const source = sessionId ? options.existingSessions.find(s => s.id === sessionId) : null
    const cfg: Partial<LaunchSettings> = source?.config ?? {}
    draft.instructions = cfg.instructions ?? ''
    draft.model = cfg.model ?? ''
    draft.mode = cfg.mode ?? ''
    draft.args = cfg.args ?? ''
    draft.envText = options.formatEnv(cfg.env ?? {})
    draft.mcpText = cfg.mcpServers && Object.keys(cfg.mcpServers).length > 0 ? JSON.stringify(cfg.mcpServers) : ''
    if (source && options.installedTools.includes(source.tool)) {
      draft.tool = source.tool
    }
    for (const key of ['instructions', 'model', 'mode', 'args', 'envText', 'mcpText'] as const) {
      cursors[key] = [...draft[key]].length
    }
    if (draft.model || draft.mode || draft.args || draft.envText || draft.mcpText) {
      advancedOpen = true
    }
  }

  const syncFromDir = () => {
    const exists = dirExists(draft.rootDir, options.initialCwd)
    if (!createDirTouched) draft.createDirectory = !exists
    if (!nameTouched && draft.rootDir.trim()) {
      const nextName = options.defaultNameForDir(resolveDir(draft.rootDir, options.initialCwd))
      if (nextName) {
        draft.name = nextName
        cursors.name = [...draft.name].length
      }
    }
  }

  const render = () => {
    const cols = Math.max(52, Math.min(stdout.columns || 80, 96))
    const inner = cols - 4
    const labelW = 16
    const inputW = Math.max(18, inner - labelW - 3)
    const fields = visibleFields()
    if (!fields.includes(focused)) focused = 'advanced'

    const lines: string[] = []
    const topBar = '─'.repeat(Math.max(0, inner + 2))
    lines.push(`${BORDER}╭${topBar}╮${RESET}`)
    lines.push(
      padBoxLine(
        `${BOLD}${ACCENT}Outpost${RESET} ${BOLD}${FG}New session${RESET}  ${MUTED}${truncate(options.initialCwd, Math.max(10, inner - 22))}${RESET}`,
        inner,
      ),
    )
    lines.push(`${BORDER}├${topBar}┤${RESET}`)

    const row = (id: FieldId, label: string, body: string) => {
      const active = focused === id
      const marker = active ? `${ACCENT}▸${RESET}` : ' '
      const lbl = active ? `${BOLD}${ACCENT}${label.padEnd(labelW)}${RESET}` : `${MUTED}${label.padEnd(labelW)}${RESET}`
      lines.push(padBoxLine(`${marker} ${lbl} ${body}`, inner))
    }

    // Name
    const dup = options.existingSessions.some(s => s.name.toLowerCase() === draft.name.trim().toLowerCase())
    const nameBadge = dup ? ` ${RED}exists${RESET}` : ''
    const nameW = Math.max(12, inputW - (dup ? 7 : 0))
    row(
      'name',
      'Name',
      renderTextInput(draft.name, cursors.name, nameW, focused === 'name', 'Refactor billing') + nameBadge,
    )

    // Tool selector
    const toolPills = options.installedTools
      .map(id => {
        const selected = draft.tool === id
        const label = harnessLabel(id)
        if (selected && focused === 'tool') return `${INVERT_ACCENT} ${label} ${RESET}`
        if (selected) return `${ACCENT_BG}${BOLD}${FG} ${label} ${RESET}`
        return `${MUTED}${label}${RESET}`
      })
      .join('  ')
    row('tool', 'Coding tool', toolPills || `${RED}No coding tools installed${RESET}`)
    if (options.missingTools.length > 0 && focused === 'tool') {
      const missingText = `Not installed: ${options.missingTools.map(harnessLabel).join(', ')}`
      lines.push(padBoxLine(`  ${' '.repeat(labelW)} ${DIM}${truncate(missingText, inputW)}${RESET}`, inner))
    }

    // Directory
    const exists = dirExists(draft.rootDir, options.initialCwd)
    const dirStatus = draft.rootDir.trim() ? (exists ? ` ${GREEN}exists${RESET}` : ` ${AMBER}new${RESET}`) : ''
    const dirW = Math.max(12, inputW - (dirStatus ? 7 : 0))
    row(
      'rootDir',
      'Directory',
      renderTextInput(draft.rootDir, cursors.rootDir, dirW, focused === 'rootDir', '/path/to/project') + dirStatus,
    )

    // Create directory checkbox
    const box = draft.createDirectory ? `${ACCENT}[x]${RESET}` : `${MUTED}[ ]${RESET}`
    row('createDirectory', 'Create dir', `${box} ${FG}Create directory if it does not exist${RESET}`)

    // Copy settings from (optional)
    if (options.existingSessions.length > 0) {
      const currentCopy = draft.copyFromId ? options.existingSessions.find(s => s.id === draft.copyFromId) : null
      const copyLabel = currentCopy
        ? `${FG}${truncate(`${currentCopy.name} · ${harnessLabel(currentCopy.tool)}`, Math.max(12, inputW - 6))}${RESET}`
        : `${DIM}None (start empty)${RESET}`
      const arrows = focused === 'copyFrom' ? `${ACCENT}‹ ${RESET}${copyLabel}${ACCENT} ›${RESET}` : copyLabel
      row('copyFrom', 'Copy settings', arrows)
    }

    // Instructions
    row(
      'instructions',
      'Instructions',
      renderTextInput(
        draft.instructions,
        cursors.instructions,
        inputW,
        focused === 'instructions',
        'Optional role or rules…',
      ),
    )

    // Collapsible advanced disclosure
    const advSummaryParts: string[] = []
    if (draft.model.trim()) advSummaryParts.push(`model=${draft.model.trim()}`)
    if (draft.mode.trim()) advSummaryParts.push(`mode=${draft.mode.trim()}`)
    if (draft.args.trim()) advSummaryParts.push('args')
    if (draft.envText.trim()) advSummaryParts.push('env')
    if (draft.mcpText.trim()) advSummaryParts.push('mcp')
    const advSummary = advSummaryParts.length ? ` ${ACCENT}(${advSummaryParts.join(', ')})${RESET}` : ''
    const chevron = advancedOpen ? '▾' : '▸'
    const advTitle = focused === 'advanced' ? `${BOLD}${ACCENT}` : `${MUTED}`
    lines.push(
      padBoxLine(
        `${focused === 'advanced' ? `${ACCENT}▸${RESET}` : ' '} ${advTitle}${chevron} Model, mode, args, env & MCP${RESET}${advSummary}`,
        inner,
      ),
    )

    if (advancedOpen) {
      row('model', '  Model', renderTextInput(draft.model, cursors.model, inputW, focused === 'model', 'Tool default'))
      row('mode', '  Chat mode', renderTextInput(draft.mode, cursors.mode, inputW, focused === 'mode', 'Tool default'))
      row('args', '  Arguments', renderTextInput(draft.args, cursors.args, inputW, focused === 'args', '--verbose'))
      row(
        'envText',
        '  Environment',
        renderTextInput(draft.envText, cursors.envText, inputW, focused === 'envText', 'KEY=value FOO="bar baz"'),
      )
      row(
        'mcpText',
        '  MCP JSON',
        renderTextInput(
          draft.mcpText,
          cursors.mcpText,
          inputW,
          focused === 'mcpText',
          '{"docs":{"type":"http","url":"…"}}',
        ),
      )
    }

    lines.push(padBoxLine('', inner))
    const submitLabel =
      focused === 'submit'
        ? `${INVERT_ACCENT}  Create & open in Outpost  ${RESET}`
        : `${ACCENT_BG}${BOLD}${FG}  Create & open in Outpost  ${RESET}`
    lines.push(padBoxLine(`  ${submitLabel}   ${MUTED}Esc to cancel${RESET}`, inner))

    if (error) {
      lines.push(padBoxLine(`${RED}✗ ${truncate(error, inner - 2)}${RESET}`, inner))
    }

    lines.push(`${BORDER}├${topBar}┤${RESET}`)
    lines.push(
      padBoxLine(
        `${MUTED}${truncate('↑↓/Tab Navigate · ←→/Space Toggle · Enter Create · Ctrl+S Submit · Esc Cancel', inner)}${RESET}`,
        inner,
      ),
    )
    lines.push(`${BORDER}╰${topBar}╯${RESET}`)

    stdout.write(`${ESC}[2J${ESC}[H${lines.join('\r\n')}\r\n`)
  }

  return await new Promise<NewSessionDraft | null>(resolvePromise => {
    let finished = false
    const wasRaw = Boolean(stdin.isRaw)

    const cleanup = () => {
      stdin.off('data', onData)
      stdout.off('resize', onResize)
      process.off('SIGINT', onCancel)
      process.off('SIGTERM', onCancel)
      try {
        stdout.write(`${ESC}[?2004l${ESC}[?25h${ESC}[?1049l`)
      } catch {
        /* ignore */
      }
      if (stdin.isTTY) {
        try {
          stdin.setRawMode(wasRaw)
        } catch {
          /* ignore */
        }
      }
      stdin.pause()
    }

    const done = (result: NewSessionDraft | null) => {
      if (finished) return
      finished = true
      cleanup()
      resolvePromise(result)
    }

    const onCancel = () => done(null)
    const onResize = () => {
      if (!finished) render()
    }

    const attemptSubmit = () => {
      const problem = options.validate(draft)
      if (problem) {
        error = problem.message
        if (problem.field) {
          if (['model', 'mode', 'args', 'envText', 'mcpText'].includes(problem.field)) {
            advancedOpen = true
          }
          focused = problem.field
        }
        render()
        return
      }
      done(draft)
    }

    const stepFocus = (delta: number) => {
      const fields = visibleFields()
      const idx = fields.indexOf(focused)
      const next = (idx + delta + fields.length) % fields.length
      focused = fields[next]
    }

    const cycleTool = (delta: number) => {
      if (options.installedTools.length <= 1) return
      const idx = Math.max(0, options.installedTools.indexOf(draft.tool))
      draft.tool = options.installedTools[(idx + delta + options.installedTools.length) % options.installedTools.length]
    }

    const cycleCopyFrom = (delta: number) => {
      const choices: (string | null)[] = [null, ...options.existingSessions.map(s => s.id)]
      const idx = Math.max(0, choices.indexOf(draft.copyFromId))
      applyCopyFrom(choices[(idx + delta + choices.length) % choices.length])
    }

    const insertText = (
      field: 'name' | 'rootDir' | 'instructions' | 'model' | 'mode' | 'args' | 'envText' | 'mcpText',
      text: string,
    ) => {
      const clean = text.replace(/[\r\n]+/g, ' ')
      const chars = [...draft[field]]
      const pos = Math.max(0, Math.min(cursors[field], chars.length))
      const inserted = [...clean]
      chars.splice(pos, 0, ...inserted)
      draft[field] = chars.join('')
      cursors[field] = pos + inserted.length
      if (field === 'name') nameTouched = true
      if (field === 'rootDir') syncFromDir()
    }

    const onData = (buf: Buffer | string) => {
      const keys = parseKeys(typeof buf === 'string' ? buf : buf.toString('utf8'))
      for (const key of keys) {
        error = ''
        if (key.type === 'ctrl-c' || key.type === 'escape') {
          done(null)
          return
        }
        if (key.type === 'ctrl-s') {
          attemptSubmit()
          if (finished) return
          continue
        }
        if (key.type === 'up' || key.type === 'backtab') {
          stepFocus(-1)
          continue
        }
        if (key.type === 'down' || key.type === 'tab') {
          stepFocus(1)
          continue
        }
        if (key.type === 'enter') {
          if (focused === 'advanced') {
            advancedOpen = !advancedOpen
            continue
          }
          attemptSubmit()
          if (finished) return
          continue
        }

        if (focused === 'tool') {
          if (key.type === 'left') cycleTool(-1)
          else if (key.type === 'right' || (key.type === 'char' && key.text === ' ')) cycleTool(1)
          continue
        }
        if (focused === 'createDirectory') {
          if (key.type === 'left' || key.type === 'right' || (key.type === 'char' && key.text === ' ')) {
            createDirTouched = true
            draft.createDirectory = !draft.createDirectory
          }
          continue
        }
        if (focused === 'copyFrom') {
          if (key.type === 'left') cycleCopyFrom(-1)
          else if (key.type === 'right' || (key.type === 'char' && key.text === ' ')) cycleCopyFrom(1)
          continue
        }
        if (focused === 'advanced') {
          if (key.type === 'left' || key.type === 'right' || (key.type === 'char' && key.text === ' ')) {
            advancedOpen = !advancedOpen
          }
          continue
        }
        if (focused === 'submit') {
          if (key.type === 'char' && key.text === ' ') {
            attemptSubmit()
            if (finished) return
          }
          continue
        }

        if (isTextField(focused)) {
          const chars = [...draft[focused]]
          const pos = Math.max(0, Math.min(cursors[focused], chars.length))
          if (key.type === 'left') cursors[focused] = Math.max(0, pos - 1)
          else if (key.type === 'right') cursors[focused] = Math.min(chars.length, pos + 1)
          else if (key.type === 'home' || key.type === 'ctrl-a') cursors[focused] = 0
          else if (key.type === 'end' || key.type === 'ctrl-e') cursors[focused] = chars.length
          else if (key.type === 'backspace') {
            if (pos > 0) {
              chars.splice(pos - 1, 1)
              draft[focused] = chars.join('')
              cursors[focused] = pos - 1
              if (focused === 'name') nameTouched = true
              if (focused === 'rootDir') syncFromDir()
            }
          } else if (key.type === 'delete') {
            if (pos < chars.length) {
              chars.splice(pos, 1)
              draft[focused] = chars.join('')
              if (focused === 'name') nameTouched = true
              if (focused === 'rootDir') syncFromDir()
            }
          } else if (key.type === 'ctrl-u') {
            chars.splice(0, pos)
            draft[focused] = chars.join('')
            cursors[focused] = 0
            if (focused === 'name') nameTouched = true
            if (focused === 'rootDir') syncFromDir()
          } else if (key.type === 'ctrl-k') {
            chars.splice(pos)
            draft[focused] = chars.join('')
            if (focused === 'name') nameTouched = true
            if (focused === 'rootDir') syncFromDir()
          } else if (key.type === 'ctrl-w') {
            let cut = pos
            while (cut > 0 && chars[cut - 1] === ' ') cut--
            while (cut > 0 && chars[cut - 1] !== ' ') cut--
            chars.splice(cut, pos - cut)
            draft[focused] = chars.join('')
            cursors[focused] = cut
            if (focused === 'name') nameTouched = true
            if (focused === 'rootDir') syncFromDir()
          } else if (key.type === 'char' && key.text) {
            insertText(focused, key.text)
          } else if (key.type === 'paste' && key.text) {
            insertText(focused, key.text)
          }
        }
      }
      if (!finished) render()
    }

    stdin.setRawMode(true)
    stdin.resume()
    stdout.write(`${ESC}[?1049h${ESC}[?25l${ESC}[?2004h`)
    stdin.on('data', onData)
    stdout.on('resize', onResize)
    process.on('SIGINT', onCancel)
    process.on('SIGTERM', onCancel)
    render()
  })
}
