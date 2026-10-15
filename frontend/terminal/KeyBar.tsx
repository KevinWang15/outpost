import type { TerminalModifiers } from './keys'

interface Key {
  label: string
  key: string
  title: string
  modifiers?: TerminalModifiers
}
const keys: Key[] = [
  { label: 'Esc', key: 'Escape', title: 'Escape' },
  { label: 'Tab', key: 'Tab', title: 'Tab' },
  { label: '↑', key: 'ArrowUp', title: 'Up arrow' },
  { label: '↓', key: 'ArrowDown', title: 'Down arrow' },
  { label: '←', key: 'ArrowLeft', title: 'Left arrow' },
  { label: '→', key: 'ArrowRight', title: 'Right arrow' },
  { label: '⇧↩', key: 'Enter', title: 'New line (Shift+Enter)', modifiers: { shift: true } },
  { label: '↩', key: 'Enter', title: 'Enter' },
  { label: '^C', key: 'c', title: 'Interrupt (Ctrl+C)', modifiers: { ctrl: true } },
]

/** On-screen keys for phones and tablets. Ctrl and Alt apply to the next key. */
export default function KeyBar({
  enabled,
  modifiers,
  onModifiers,
  onKey,
  onCopy,
  onPaste,
  onKeyboard,
  onSelectText,
}: {
  enabled: boolean
  modifiers: TerminalModifiers
  onModifiers: (modifiers: TerminalModifiers) => void
  onKey: (key: string, modifiers?: TerminalModifiers) => void
  onCopy: () => void
  onPaste: () => void
  onKeyboard: () => void
  onSelectText: () => void
}) {
  // Keep focus (and the phone keyboard) on the terminal while tapping keys.
  // Cancel mouse focus transfer, not pointerdown: WebKit can suppress the subsequent touch click.
  const hold = (event: React.MouseEvent) => event.preventDefault()
  return (
    <div className="key-bar" role="group" aria-label="Terminal keys">
      <button type="button" title="Show or hide keyboard" onMouseDown={hold} onClick={onKeyboard}>
        Keyboard
      </button>
      <button type="button" onMouseDown={hold} onClick={onSelectText}>
        Select text
      </button>
      {(['ctrl', 'alt'] as const).map(name => (
        <button
          key={name}
          type="button"
          disabled={!enabled}
          aria-pressed={Boolean(modifiers[name])}
          title={`${name === 'ctrl' ? 'Ctrl' : 'Alt'} for the next key`}
          onMouseDown={hold}
          onClick={() => onModifiers({ ...modifiers, [name]: !modifiers[name] })}
        >
          {name === 'ctrl' ? 'Ctrl' : 'Alt'}
        </button>
      ))}
      {keys.map(item => (
        <button
          key={item.title}
          type="button"
          disabled={!enabled}
          title={item.title}
          aria-label={item.title}
          onMouseDown={hold}
          onClick={() => onKey(item.key, item.modifiers)}
        >
          {item.label}
        </button>
      ))}
      <button type="button" title="Copy selection" onMouseDown={hold} onClick={onCopy}>
        Copy
      </button>
      <button type="button" disabled={!enabled} title="Paste from your clipboard" onMouseDown={hold} onClick={onPaste}>
        Paste
      </button>
    </div>
  )
}
