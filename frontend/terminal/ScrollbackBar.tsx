import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, Info } from 'lucide-react'
import type { ScrollbackState } from '../../shared/protocol'

interface Props {
  state: ScrollbackState | null
  enabled: boolean
  controls: string
  onScroll: (offset: number) => void
  onLive: () => void
  onNavigate: (key: HistoryNavigation) => void
  onHelp: () => void
}

export type HistoryNavigation = 'Home' | 'PageUp' | 'PageDown' | 'End'

/** A view of tmux's scroll position. It never stores or replays terminal output. */
export default function ScrollbackBar({ state, enabled, controls, onScroll, onLive, onNavigate, onHelp }: Props) {
  const thumb = useRef<HTMLSpanElement>(null)
  const drag = useRef<{ pointer: number; grab: number; lines: number } | null>(null)
  const [preview, setPreview] = useState<{
    offset: number
    baseline: ScrollbackState | null
    dragging: boolean
  } | null>(null)
  const lines = state?.lines ?? 0
  // Keep the last requested position through pointer release until fresh server
  // metadata arrives, so a slow connection cannot snap the thumb back on release.
  const offset = Math.min(
    lines,
    preview && (preview.dragging || preview.baseline === state) ? preview.offset : (state?.offset ?? 0),
  )
  const usable = enabled && state?.available === true
  const scrollable = usable && lines > 0
  const position = lines ? 1 - offset / lines : 1
  const rows = state?.rows ?? 1
  const description = !enabled
    ? 'Connect to browse terminal history'
    : !state?.available
      ? state?.alternate
        ? 'The application controls its full-screen history'
        : 'Terminal history is unavailable'
      : !lines
        ? 'No earlier terminal output yet'
        : offset
          ? `${offset.toLocaleString()} lines above the bottom · Drag to browse history`
          : state.active
            ? 'At the bottom of saved output · Return to live output to resume'
            : 'Live output · Drag up to browse history'

  const move = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current
    if (!held || held.pointer !== event.pointerId || !scrollable) return
    const track = event.currentTarget.getBoundingClientRect()
    const travel = Math.max(1, track.height - (thumb.current?.getBoundingClientRect().height ?? 0))
    const fraction = Math.max(0, Math.min(1, (event.clientY - track.top - held.grab) / travel))
    const next = Math.round((1 - fraction) * held.lines)
    setPreview({ offset: next, baseline: state, dragging: true })
    onScroll(fraction === 0 ? -1 : next)
  }
  const release = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return
    drag.current = null
    setPreview(previous => previous && { ...previous, baseline: state, dragging: false })
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!scrollable || event.altKey || event.metaKey || event.ctrlKey) return
    const page = Math.max(1, rows - 1)
    const next = {
      ArrowUp: Math.min(lines, offset + 1),
      ArrowDown: Math.max(0, offset - 1),
      PageUp: Math.min(lines, offset + page),
      PageDown: Math.max(0, offset - page),
      Home: -1,
      End: 0,
    }[event.key]
    if (next === undefined) return
    event.preventDefault()
    setPreview({ offset: next === -1 ? lines : next, baseline: state, dragging: false })
    onScroll(next)
  }

  // Full-screen Codex exposes navigation keys, but no terminal history length
  // or position. Do not represent that unknown extent with a fake scrollbar.
  if (state?.application === 'codex' && !state.active)
    return (
      <aside className="terminal-scrollback" aria-label="Codex history controls">
        {[
          { key: 'Home', label: 'Oldest Codex history (Ctrl+Home)', Icon: ArrowUpToLine },
          { key: 'PageUp', label: 'Previous page of Codex history (Page Up)', Icon: ChevronUp },
          { key: 'PageDown', label: 'Next page of Codex history (Page Down)', Icon: ChevronDown },
          { key: 'End', label: 'Latest Codex output (Ctrl+End)', Icon: ArrowDownToLine },
        ].map(({ key, label, Icon }) => (
          <button
            key={key}
            className="icon-button terminal-scroll-live"
            title={label}
            aria-label={label}
            disabled={!enabled}
            onClick={() => onNavigate(key as HistoryNavigation)}
          >
            <Icon size={15} />
          </button>
        ))}
        <button
          className="icon-button terminal-scroll-live"
          title="About Codex history controls"
          aria-label="About Codex history controls"
          onClick={onHelp}
        >
          <Info size={15} />
        </button>
      </aside>
    )

  return (
    <aside className="terminal-scrollback" aria-label="Terminal history">
      <div
        className="terminal-scroll-track"
        role="scrollbar"
        aria-label="Terminal scrollback"
        aria-orientation="vertical"
        aria-controls={controls}
        aria-valuemin={0}
        aria-valuemax={lines}
        aria-valuenow={lines - offset}
        aria-valuetext={description}
        aria-disabled={!scrollable}
        tabIndex={scrollable ? 0 : -1}
        title={description}
        onKeyDown={key}
        onPointerDown={event => {
          if (!scrollable || event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          const bounds = thumb.current!.getBoundingClientRect()
          drag.current = {
            pointer: event.pointerId,
            grab: event.target === thumb.current ? event.clientY - bounds.top : bounds.height / 2,
            lines,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          move(event)
        }}
        onPointerMove={move}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        {scrollable && (
          <span
            ref={thumb}
            className="terminal-scroll-thumb"
            style={{
              height: `${(rows / (lines + rows)) * 100}%`,
              top: `${position * 100}%`,
              transform: `translateY(-${position * 100}%)`,
            }}
          />
        )}
      </div>
      <button
        className="icon-button terminal-scroll-live"
        title="Return to live output"
        aria-label="Return to live output"
        disabled={!usable || !state?.active}
        onClick={onLive}
      >
        <ArrowDownToLine size={15} />
      </button>
    </aside>
  )
}
