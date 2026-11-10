// Agent steps: tool calls, thinking and compaction, folded into one line per run.
import { useContext, useState, type ReactNode } from 'react'
import type * as acp from '@agentclientprotocol/sdk'
import {
  ArrowRightLeft,
  Brain,
  Check,
  ChevronRight,
  CircleCheck,
  Circle,
  CircleDot,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  Minimize2,
  Search,
  ShieldQuestion,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import type { ToolView, TurnItem } from '../../shared/chatTranscript'
import { ConversationContext } from './context'

const kindIcon: Record<string, typeof Wrench> = {
  read: FileText,
  edit: FilePen,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: ArrowRightLeft,
}
const kindPhrase: Record<string, string> = {
  read: 'Reading',
  edit: 'Editing',
  delete: 'Deleting',
  move: 'Moving',
  search: 'Searching',
  execute: 'Running a command',
  think: 'Thinking',
  fetch: 'Fetching',
  switch_mode: 'Switching mode',
}
const stepPhrase = (tool: ToolView) => kindPhrase[tool.kind ?? ''] ?? 'Working'

export type StepItem = Extract<TurnItem, { type: 'tool' | 'thought' | 'compaction' }>
const firstSentence = (text: string) =>
  text
    .trim()
    .split(/(?<=[.!?])\s|\n/)[0]
    .slice(0, 160)

function Lines({ text, limit = 40 }: { text: string; limit?: number }) {
  const [all, setAll] = useState(false)
  const lines = text.replace(/\n$/, '').split('\n')
  const shown = all || lines.length <= limit ? lines : lines.slice(-limit)
  return (
    <>
      {!all && lines.length > limit && (
        <button className="link small" onClick={() => setAll(true)}>
          Show {lines.length - limit} earlier lines
        </button>
      )}
      <pre className="step-output">{shown.join('\n')}</pre>
    </>
  )
}

/** A unified line diff of an ACP diff block; large changes show old and new. */
export function Diff({ diff }: { diff: Extract<acp.ToolCallContent, { type: 'diff' }> }) {
  const before = diff.oldText?.split('\n') ?? []
  const after = diff.newText.split('\n')
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endBefore = before.length,
    endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  const a = before.slice(start, endBefore),
    b = after.slice(start, endAfter)
  const rows: { kind: ' ' | '-' | '+'; text: string }[] = []
  if (a.length * b.length <= 250_000) {
    // Longest common subsequence over the changed middle.
    const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    let i = 0,
      j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        rows.push({ kind: ' ', text: a[i++] })
        j++
      } else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j]))
        rows.push({ kind: '+', text: b[j++] })
      else rows.push({ kind: '-', text: a[i++] })
    }
  } else {
    for (const text of a) rows.push({ kind: '-', text })
    for (const text of b) rows.push({ kind: '+', text })
  }
  const context = before.slice(Math.max(0, start - 3), start).map(text => ({ kind: ' ' as const, text }))
  const trailing = before.slice(endBefore, endBefore + 3).map(text => ({ kind: ' ' as const, text }))
  const added = rows.filter(row => row.kind === '+').length,
    removed = rows.filter(row => row.kind === '-').length
  return (
    <div className="diff">
      <div className="diff-path">
        <code>{diff.path}</code>
        <span className="diff-stat">
          {added > 0 && <span className="added">+{added}</span>}{' '}
          {removed > 0 && <span className="removed">−{removed}</span>}
        </span>
      </div>
      <pre>
        {[...context, ...rows, ...trailing].slice(0, 400).map((row, index) => (
          <span key={index} className={`diff-line ${row.kind === '+' ? 'added' : row.kind === '-' ? 'removed' : ''}`}>
            {row.kind} {row.text}
            {'\n'}
          </span>
        ))}
      </pre>
    </div>
  )
}

function inputSummary(tool: ToolView) {
  const input = tool.input
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    for (const key of ['command', 'cmd', 'query', 'pattern', 'url', 'file_path', 'path'])
      if (typeof record[key] === 'string') return record[key] as string
  }
  return null
}

function ToolDetail({ tool }: { tool: ToolView }) {
  const summary = inputSummary(tool)
  const content: ReactNode[] = []
  for (const [index, block] of tool.content.entries()) {
    if (block.type === 'diff') content.push(<Diff key={index} diff={block} />)
    else if (block.type === 'content' && block.content.type === 'text')
      content.push(<Lines key={index} text={block.content.text.replace(/^```\w*\n?|\n?```$/g, '')} />)
  }
  const output =
    tool.terminal ??
    (!content.length && typeof tool.output === 'string' ? tool.output : null) ??
    (!content.length && tool.output && typeof tool.output === 'object' ? JSON.stringify(tool.output, null, 2) : null)
  return (
    <div className="step-detail">
      {summary ? (
        <pre className="step-input">{summary}</pre>
      ) : tool.input !== undefined && tool.input !== null && JSON.stringify(tool.input) !== '{}' ? (
        <pre className="step-input">{JSON.stringify(tool.input, null, 2)}</pre>
      ) : null}
      {content}
      {output && <Lines text={output} />}
      {tool.locations.length > 0 && !summary && (
        <p className="step-locations">
          {tool.locations.map(location => (
            <code key={`${location.path}:${location.line}`}>
              {location.path}
              {location.line ? `:${location.line}` : ''}
            </code>
          ))}
        </p>
      )}
    </div>
  )
}

function StatusIcon({ status }: { status: ToolView['status'] }) {
  if (status === 'completed') return <Check size={13} className="step-done" />
  if (status === 'failed') return <X size={13} className="step-failed" />
  if (status === 'in_progress') return <LoaderCircle size={13} className="spin step-running" />
  return <Circle size={11} className="step-pending" />
}

function StepRow({ item }: { item: StepItem }) {
  const [open, setOpen] = useState(false)
  if (item.type === 'compaction')
    return (
      <li className="step-row static">
        <Minimize2 size={14} />
        <span className="step-title">
          {item.status === 'failed' ? `Compaction failed: ${item.error}` : 'Compacted the conversation'}
        </span>
      </li>
    )
  if (item.type === 'thought') {
    const summary = firstSentence(item.text)
    const more = item.text.trim().length > summary.length
    return (
      <li className={`step-row thought ${open ? 'open' : ''}`}>
        <button
          className="step-head"
          disabled={!more}
          aria-expanded={more ? open : undefined}
          onClick={() => setOpen(!open)}
        >
          <Brain size={14} />
          <span className="step-title">{summary || 'Thinking'}</span>
          {more && <ChevronRight size={13} className="chevron" />}
        </button>
        {open && <p className="step-thought">{item.text.trim()}</p>}
      </li>
    )
  }
  const Icon = kindIcon[item.kind ?? ''] ?? Wrench
  return (
    <li className={`step-row ${item.status} ${open ? 'open' : ''}`}>
      <button className="step-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon size={14} />
        <span className="step-title">{item.title}</span>
        <StatusIcon status={item.status} />
        <ChevronRight size={13} className="chevron" />
      </button>
      {open && <ToolDetail tool={item} />}
    </li>
  )
}

/** One run of steps between the agent's notes. */
export function StepGroup({
  items,
  running,
  defaultOpen = false,
}: {
  items: StepItem[]
  running: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const tools = items.filter((item): item is ToolView => item.type === 'tool')
  const failed = tools.filter(tool => tool.status === 'failed').length
  const active = running
    ? ([...tools].reverse().find(tool => tool.status === 'in_progress' || tool.status === 'pending') ?? null)
    : null
  const thought = [...items].reverse().find(item => item.type === 'thought')
  const headline = active ? active.title : running && thought?.type === 'thought' ? firstSentence(thought.text) : null
  const steps = tools.length || items.length
  return (
    <div className={`step-group ${open ? 'open' : ''}`}>
      <button className="step-group-summary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {running ? (
          <LoaderCircle size={14} className="spin" />
        ) : failed ? (
          <X size={14} className="step-failed" />
        ) : (
          <CircleCheck size={14} className="step-done" />
        )}
        <span className="step-group-label">
          <strong>{running ? (active ? stepPhrase(active) : 'Working') : 'Worked'}</strong>
          <span className="muted">
            {' · '}
            {steps} {steps === 1 ? 'step' : 'steps'}
            {failed ? ` · ${failed} failed` : ''}
          </span>
          {headline && <span className="step-group-headline"> · {headline}</span>}
        </span>
        <ChevronRight size={14} className="chevron" />
      </button>
      {open && (
        <ul className="step-list">
          {items.map(item => (
            <StepRow key={item.key} item={item} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function PlanView({ entries }: { entries: acp.PlanEntry[] }) {
  const done = entries.filter(entry => entry.status === 'completed').length
  return (
    <div className="plan">
      <div className="plan-head">
        Plan{' '}
        <span className="muted">
          {done}/{entries.length}
        </span>
      </div>
      <ol>
        {entries.map((entry, index) => (
          <li key={index} className={entry.status}>
            {entry.status === 'completed' ? (
              <CircleCheck size={14} />
            ) : entry.status === 'in_progress' ? (
              <CircleDot size={14} />
            ) : (
              <Circle size={14} />
            )}
            <span>{entry.content}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function PermissionCard({ item }: { item: Extract<TurnItem, { type: 'permission' }> }) {
  const { answer, readOnly } = useContext(ConversationContext)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const tool = item.toolCall
  const input = tool.rawInput && typeof tool.rawInput === 'object' ? (tool.rawInput as Record<string, unknown>) : null
  const detail = input
    ? (['command', 'file_path', 'path', 'url'].map(key => input[key]).find(value => typeof value === 'string') as
        string | undefined)
    : undefined
  const chosen = item.options.find(option => option.optionId === item.optionId)
  const order = (kind: string) => ['allow_once', 'allow_always', 'reject_once', 'reject_always'].indexOf(kind)
  return (
    <div
      className={`permission ${item.resolved ? 'resolved' : ''}`}
      role={item.resolved ? undefined : 'group'}
      aria-label="Permission request"
    >
      <div className="permission-head">
        <ShieldQuestion size={16} />
        <span>
          <strong>{tool.title ?? 'Use a tool'}</strong>
          {detail && <code>{detail}</code>}
        </span>
      </div>
      {item.resolved ? (
        <p className="muted">
          {chosen ? `${chosen.kind.startsWith('allow') ? 'Allowed' : 'Declined'}: ${chosen.name}` : 'Cancelled'}
        </p>
      ) : readOnly ? (
        <p className="muted">Waiting for approval in the session’s chat.</p>
      ) : (
        <div className="permission-options">
          {[...item.options]
            .sort((a, b) => order(a.kind) - order(b.kind))
            .map(option => (
              <button
                key={option.optionId}
                className={`button small ${option.kind === 'allow_once' ? 'primary' : ''}`}
                disabled={busy !== null}
                onClick={() => {
                  setBusy(option.optionId)
                  setError('')
                  answer(item.id, option.optionId).catch(problem => {
                    setError((problem as Error).message)
                    setBusy(null)
                  })
                }}
              >
                {busy === option.optionId && <LoaderCircle size={13} className="spin" />}
                {option.name}
              </button>
            ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}
