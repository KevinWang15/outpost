import { memo, useContext, useState } from 'react'
import { ChevronRight, Hash, Image, ImageOff, MessageSquareReply, Timer } from 'lucide-react'
import type * as acp from '@agentclientprotocol/sdk'
import { linkedFile } from '../../shared/chatHost'
import { promptHeaderPattern, type TurnItem, type TurnView } from '../../shared/chatTranscript'
import type { HarnessId } from '../../shared/harnesses'
import { Markdown } from '../ui/Markdown'
import { Avatar } from './Avatar'
import { MentionHandlesContext } from './context'
import { elapsed } from './format'
import { PermissionCard, PlanView, StepGroup, type StepItem } from './Steps'
import { TurnFile } from './Files'

type Segment =
  { kind: 'steps'; key: string; items: StepItem[] } | { kind: 'item'; key: string; item: Exclude<TurnItem, StepItem> }

function segments(items: TurnItem[]): Segment[] {
  const out: Segment[] = []
  for (const item of items) {
    if (item.type === 'tool' || item.type === 'thought' || item.type === 'compaction') {
      const last = out.at(-1)
      if (last?.kind === 'steps') last.items.push(item)
      else out.push({ kind: 'steps', key: item.key, items: [item] })
    } else out.push({ kind: 'item', key: item.key, item })
  }
  return out
}

function Item({ item }: { item: Exclude<TurnItem, StepItem> }) {
  const handles = useContext(MentionHandlesContext)
  switch (item.type) {
    case 'text':
      return <Markdown text={item.text} mentions={handles} />
    case 'plan':
      return <PlanView entries={item.entries} />
    case 'permission':
      return <PermissionCard item={item} />
    case 'notice':
      return <p className={`turn-notice ${item.level}`}>{item.text}</p>
    case 'image':
      return item.data ? (
        <img className="turn-image" alt="" src={`data:${item.mimeType};base64,${item.data}`} />
      ) : (
        <span className="chip">
          <ImageOff size={12} /> Image
        </span>
      )
    case 'link':
      return (
        <p>
          <code>{item.name}</code>
        </p>
      )
    case 'file':
      return <TurnFile file={item.file} />
  }
}

/** The agent's part of a turn: notes, steps, plans and requests in order.
 * `steps` leaves out its final message, for views that show it already. */
export function Reply({ turn, open = false, steps = false }: { turn: TurnView; open?: boolean; steps?: boolean }) {
  const all = segments(turn.items)
  const last = all.at(-1)
  const parts = steps && last?.kind === 'item' && last.item.type === 'text' ? all.slice(0, -1) : all
  // The current run of steps is the last one; a permission or plan after it
  // does not end it, but the agent's next note does.
  let current = -1
  if (turn.status === 'running')
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index]
      if (part.kind === 'steps') {
        current = index
        break
      }
      if (part.item.type === 'text') break
    }
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'steps' ? (
          <StepGroup key={part.key} items={part.items} running={index === current} defaultOpen={open} />
        ) : (
          <Item key={part.key} item={part.item} />
        ),
      )}
    </>
  )
}

/** Session files a prompt attached, as cards. */
function PromptFiles({ prompt }: { prompt: acp.ContentBlock[] }) {
  const files = prompt.flatMap(block => linkedFile(block) ?? [])
  if (!files.length) return null
  return (
    <div className="file-cards">
      {files.map(file => (
        <TurnFile key={file.id} file={file} />
      ))}
    </div>
  )
}

function PromptText({ prompt }: { prompt: acp.ContentBlock[] }) {
  return (
    <>
      {prompt.map((block, index) => {
        if (block.type === 'text') return <p key={index}>{block.text}</p>
        // Replayed history keeps no image bytes.
        if (block.type === 'image')
          return (
            <span key={index} className="chip">
              <Image size={12} /> Image
            </span>
          )
        return null
      })}
      <PromptFiles prompt={prompt} />
    </>
  )
}

const originIcon = (turn: TurnView) =>
  turn.origin?.kind === 'channel' || turn.label?.startsWith('#') ? (
    <Hash size={13} />
  ) : turn.origin?.kind === 'schedule' || turn.label?.startsWith('Scheduled') ? (
    <Timer size={13} />
  ) : (
    <MessageSquareReply size={13} />
  )

/** A prompt Outpost composed for a channel, another session or a schedule. */
function ComposedPrompt({ turn }: { turn: TurnView }) {
  const [open, setOpen] = useState(false)
  const text = turn.prompt.map(block => (block.type === 'text' ? block.text : '')).join('\n')
  const body = text.replace(promptHeaderPattern, '')
  const summary = turn.origin && 'summary' in turn.origin ? turn.origin.summary : null
  return (
    <div className="composed">
      <button className="composed-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {originIcon(turn)}
        <strong>{turn.label}</strong>
        {summary && <span className="composed-summary">{summary}</span>}
        <ChevronRight size={13} className="chevron" />
      </button>
      {open && <pre className="composed-body">{body}</pre>}
      <PromptFiles prompt={turn.prompt} />
    </div>
  )
}

/** A turn renders again only when an entry changed it (its revision). */
export const Turn = memo(
  function Turn({
    turn,
    sessionId,
    sessionName,
    sessionTool,
  }: {
    turn: TurnView
    sessionId: string
    sessionName: string
    sessionTool: HarnessId
  }) {
    const composed = turn.label !== null
    const footer =
      turn.status === 'running'
        ? null
        : turn.status === 'cancelled'
          ? 'Stopped'
          : turn.status === 'error'
            ? turn.error || 'The turn failed.'
            : null
    return (
      <article className={`turn ${turn.status}`}>
        {composed ? (
          <ComposedPrompt turn={turn} />
        ) : turn.prompt.length > 0 ? (
          <div className="prompt">
            <PromptText prompt={turn.prompt} />
          </div>
        ) : null}
        {(turn.items.length > 0 || turn.status === 'running') && (
          <div className="reply">
            <div className="reply-avatar">
              <Avatar id={sessionId} name={sessionName} tool={sessionTool} />
            </div>
            <div className="reply-body">
              <Reply turn={turn} />
              {turn.status === 'running' && !turn.items.length && <p className="thinking">Thinking…</p>}
              {footer && <p className={`turn-footer ${turn.status}`}>{footer}</p>}
              {turn.status === 'done' &&
                turn.startedAt &&
                turn.endedAt &&
                new Date(turn.endedAt).getTime() - new Date(turn.startedAt).getTime() >= 2000 && (
                  <p className="turn-meta">{elapsed(turn.startedAt, turn.endedAt)}</p>
                )}
            </div>
          </div>
        )}
      </article>
    )
  },
  (before, after) =>
    before.turn.id === after.turn.id &&
    before.turn.revision === after.turn.revision &&
    before.sessionId === after.sessionId &&
    before.sessionName === after.sessionName &&
    before.sessionTool === after.sessionTool,
)
