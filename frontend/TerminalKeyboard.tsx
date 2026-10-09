import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { TerminalModifiers } from './terminal-keyboard'

interface Key { label: string; key: string; title?: string; text?: string; modifiers?: TerminalModifiers; compact?: boolean }
const mainKeys: Key[] = [
  { label: 'Esc', key: 'Escape' }, { label: 'Tab', key: 'Tab' },
  { label: 'Ctrl+C', key: 'c', modifiers: { ctrl: true }, title: 'Interrupt (Ctrl+C)', text: '^C' },
  { label: '←', key: 'ArrowLeft', title: 'Left arrow' }, { label: '↑', key: 'ArrowUp', title: 'Up arrow', compact: true },
  { label: '↓', key: 'ArrowDown', title: 'Down arrow', compact: true }, { label: '→', key: 'ArrowRight', title: 'Right arrow' },
  { label: 'Enter', key: 'Enter', text: '↵' }, { label: 'Shift+Enter', key: 'Enter', modifiers: { shift: true }, text: '⇧ ↵' },
]
const groups: Record<string, Key[]> = {
  Navigate: [
    { label: 'Home', key: 'Home' }, { label: 'End', key: 'End' }, { label: 'Page up', key: 'PageUp', text: 'PgUp' }, { label: 'Page down', key: 'PageDown', text: 'PgDn' },
    { label: 'Insert', key: 'Insert', text: 'Ins' }, { label: 'Delete', key: 'Delete', text: 'Del' }, { label: 'Backspace', key: 'Backspace', text: '⌫' }, { label: 'Shift+Tab', key: 'Tab', modifiers: { shift: true }, text: '⇧ Tab' },
  ],
  Shortcuts: ['a', 'e', 'u', 'k', 'w', 'l', 'd', 'z'].map(key => ({ label: `Ctrl+${key.toUpperCase()}`, key, modifiers: { ctrl: true } })),
  Symbols: [...'/-_~|\\$`\'"()[]{}<>:='].map(key => ({ label: key, key })),
  'F keys': Array.from({ length: 12 }, (_, index) => ({ label: `F${index + 1}`, key: `F${index + 1}` })),
}

export default function TerminalKeyboard({ connected, canCopy, modifiers, onModifiers, onKey, onCopy, onPaste }: {
  connected: boolean; canCopy: boolean; modifiers: TerminalModifiers
  onModifiers: (modifiers: TerminalModifiers) => void
  onKey: (key: string, modifiers?: TerminalModifiers) => void
  onCopy: () => void; onPaste: () => void
}) {
  const [expanded, setExpanded] = useState(false), [group, setGroup] = useState('Navigate')
  const root = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null), id = useId()
  useEffect(() => {
    if (!expanded) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setExpanded(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [expanded])
  const keyButton = (item: Key, extra = '') => <button type="button" key={item.label} className={`${extra} ${item.key.startsWith('Arrow') || item.key === 'Enter' || item.key === 'Backspace' ? 'terminal-key-glyph' : ''}`} data-compact={Boolean(item.compact)} disabled={!connected}
    aria-label={item.label} title={item.title ?? item.label} onPointerDown={event => event.preventDefault()} onClick={() => onKey(item.key, item.modifiers)}>{item.text ?? item.label}</button>
  return <div ref={root} className="terminal-keyboard" onKeyDown={event => {
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); more.current?.focus() }
  }}>
    {expanded && <div id={id} className="terminal-keyboard-panel" role="group" aria-label="More terminal keys">
      <div className="terminal-keyboard-tabs" role="group" aria-label="Key categories">
        {Object.keys(groups).map(name => <button type="button" key={name} aria-pressed={group === name} onPointerDown={event => event.preventDefault()} onClick={() => setGroup(name)}>{name}</button>)}
      </div>
      <div className={`terminal-extra-keys ${group === 'Symbols' || group === 'F keys' ? 'terminal-symbol-keys' : ''}`}>
        {groups[group].map(item => keyButton(item))}
        {group === 'Navigate' && mainKeys.filter(item => !item.compact).map(item => keyButton(item, 'terminal-compact-key'))}
      </div>
    </div>}
    <div className="terminal-keys" role="group" aria-label="Terminal keys">
      <button type="button" data-compact="true" disabled={!canCopy} title="Copy to your clipboard" onPointerDown={event => event.preventDefault()} onClick={onCopy}>Copy</button>
      <button type="button" data-compact="true" disabled={!connected} title="Paste from your clipboard" onPointerDown={event => event.preventDefault()} onClick={onPaste}>Paste</button>
      {mainKeys.slice(0, 2).map(item => keyButton(item))}
      {(['ctrl', 'alt'] as const).map(name => <button type="button" key={name} data-compact="true" disabled={!connected} aria-pressed={Boolean(modifiers[name])}
        title={`${name === 'ctrl' ? 'Ctrl' : 'Alt'} for the next terminal key`} onPointerDown={event => event.preventDefault()}
        onClick={() => onModifiers({ ...modifiers, [name]: !modifiers[name] })}>{name === 'ctrl' ? 'Ctrl' : 'Alt'}</button>)}
      {mainKeys.slice(2).map(item => keyButton(item))}
      <button ref={more} type="button" data-compact="true" aria-label="More keys" title="More terminal keys" aria-expanded={expanded} aria-controls={expanded ? id : undefined} onPointerDown={event => event.preventDefault()} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronDown size={18} /> : <ChevronUp size={18} />}<span>More</span>
      </button>
    </div>
    <span className="sr-only" role="status">{[modifiers.ctrl && 'Ctrl', modifiers.alt && 'Alt'].filter(Boolean).join(' + ')}{(modifiers.ctrl || modifiers.alt) && ' applies to the next terminal key.'}</span>
  </div>
}
