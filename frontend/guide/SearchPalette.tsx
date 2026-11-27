// Global Cmd+K / Ctrl+K documentation search palette (styled natively with Outpost tokens).
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Hash, Search } from 'lucide-react'
import { searchGuideEntries, type GuidePaletteHit, type GuideSearchItem } from './guide'

const MAX_SEARCH_RESULTS = 20

interface SearchPaletteProps {
  isOpen: boolean
  items: readonly GuideSearchItem[]
  onClose: () => void
  onSelect: (hit: GuidePaletteHit) => void
}

export function SearchPalette({ isOpen, items, onClose, onSelect }: SearchPaletteProps) {
  if (!isOpen) return null
  return <SearchPaletteDialog items={items} onClose={onClose} onSelect={onSelect} />
}

function SearchPaletteDialog({
  items,
  onClose,
  onSelect,
}: {
  items: readonly GuideSearchItem[]
  onClose: () => void
  onSelect: (hit: GuidePaletteHit) => void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const deferredQuery = useDeferredValue(query)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [onClose])

  const results = useMemo(() => {
    const trimmed = deferredQuery.trim()
    if (!trimmed) return []
    return searchGuideEntries(items, trimmed).slice(0, MAX_SEARCH_RESULTS)
  }, [deferredQuery, items])

  const clampedActiveIndex = Math.min(activeIndex, Math.max(results.length - 1, 0))

  useEffect(() => {
    if (results.length === 0) return
    itemRefs.current[clampedActiveIndex]?.scrollIntoView({ block: 'nearest' })
  }, [clampedActiveIndex, results.length])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex(i => Math.min(i + 1, Math.max(results.length - 1, 0)))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(i => Math.max(i - 1, 0))
      } else if (event.key === 'Enter') {
        const active = results[clampedActiveIndex]
        if (active) {
          event.preventDefault()
          onSelect(active)
        }
      }
    },
    [results, clampedActiveIndex, onSelect],
  )

  return createPortal(
    <div className="guide-palette-backdrop">
      <div className="guide-palette-scrim" onClick={onClose} />
      <div className="guide-palette-panel" role="dialog" aria-modal="true" aria-label="Search user guide">
        <div className="guide-palette-input-row">
          <Search size={15} aria-hidden="true" className="guide-palette-search-icon" />
          <input
            ref={inputRef}
            type="search"
            className="guide-palette-input"
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search guides, shortcuts, CLI flags, concepts…"
            aria-label="Search user guide"
          />
          <kbd className="guide-kbd">Esc</kbd>
        </div>

        <div className="guide-palette-body">
          {!query.trim() ? (
            <div className="guide-palette-empty">Type to search Outpost guides and section headings.</div>
          ) : results.length === 0 ? (
            <div className="guide-palette-empty">No guide topics match “{query.trim()}”.</div>
          ) : (
            <div className="guide-palette-list" role="listbox" aria-label="Search results">
              {results.map((hit, index) => {
                const active = index === clampedActiveIndex
                return (
                  <button
                    key={hit.item.id}
                    ref={el => {
                      itemRefs.current[index] = el
                    }}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`guide-palette-item${active ? ' active' : ''}`}
                    onMouseMove={() => {
                      if (clampedActiveIndex !== index) setActiveIndex(index)
                    }}
                    onClick={() => onSelect(hit)}
                  >
                    <span className="guide-palette-item-icon" aria-hidden="true">
                      {hit.item.kind === 'article' ? <FileText size={14} /> : <Hash size={14} />}
                    </span>
                    <span className="guide-palette-item-body">
                      <span className="guide-palette-item-title">{hit.item.title}</span>
                      <span className="guide-palette-item-crumbs">{hit.item.breadcrumbLabels}</span>
                      {hit.snippet && <span className="guide-palette-item-snippet">{hit.snippet}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
