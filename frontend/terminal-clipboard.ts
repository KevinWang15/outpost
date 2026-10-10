import type { Terminal } from '@xterm/xterm'

export interface TerminalClipboardState { canCopy: boolean; message: string }

// OSC 52 carries remote copy requests. Clipboard reads only happen on a local
// Paste action; a remote application must never be able to query the clipboard.
export function attachTerminalClipboard(term: Terminal, options: {
  connection: () => WebSocket | null
  beforePaste: () => void
  pasteImage: (file: File) => void
  onChange: (state: TerminalClipboardState) => void
}) {
  let disposed = false, pendingCopy: string | null = null, revision = 0, message = ''
  const element = term.element!
  const update = (value = message) => {
    message = value
    if (!disposed) options.onChange({ canCopy: term.hasSelection() || pendingCopy !== null, message })
  }
  const copyText = async (text: string, remote = false) => {
    const current = ++revision
    pendingCopy = text
    try {
      // Background tabs keep the text for an explicit Copy action.
      if (!document.hasFocus() || document.visibilityState === 'hidden') throw new Error('Document inactive')
      await navigator.clipboard.writeText(text)
      if (!disposed && current === revision) { pendingCopy = null; update('Copied to your clipboard.') }
    } catch {
      if (!disposed && current === revision) update(remote ? 'Remote text is ready. Click Copy to put it on your clipboard.' : 'Copy was blocked. Allow clipboard access, then click Copy again.')
    }
  }
  const copy = () => {
    const text = pendingCopy ?? (term.hasSelection() ? term.getSelection() : null)
    if (text !== null) return copyText(text)
    update('Select text in the terminal to copy.')
  }
  const paste = async () => {
    const connection = options.connection()
    if (!connection) return
    try {
      let text = ''
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read()
        if (disposed || connection !== options.connection()) return
        const images = items.filter(item => item.types.some(type => type.startsWith('image/')))
        if (images.length > 1) { update('Paste one image at a time.'); return }
        const image = images[0]
        if (image) {
          const type = image.types.find(type => type === 'image/png') ?? image.types.find(type => type.startsWith('image/'))!
          const blob = await image.getType(type)
          if (!disposed && connection === options.connection()) {
            options.beforePaste(); update(''); options.pasteImage(new File([blob], 'clipboard-image', { type }))
          }
          return
        }
        const item = items.find(item => item.types.includes('text/plain'))
        if (item) text = await (await item.getType('text/plain')).text()
      } else text = await navigator.clipboard.readText()
      if (disposed || connection !== options.connection()) return
      options.beforePaste(); update(''); term.paste(text); term.focus()
    } catch {
      if (!disposed && connection === options.connection()) update('Paste was blocked. Use your paste shortcut in the terminal or the text box below.')
    }
  }
  const nativePaste = (event: ClipboardEvent) => {
    options.beforePaste(); update('')
    const images = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    if (!images.length) return
    // Capture before xterm turns the same clipboard item into a text paste.
    event.preventDefault(); event.stopImmediatePropagation()
    if (images.length > 1) { update('Paste one image at a time.'); return }
    const file = images[0].getAsFile()
    if (file) options.pasteImage(file)
    else update('Could not read the clipboard image. Copy it again and retry.')
  }
  const nativeCopy = (event: ClipboardEvent) => {
    if (!term.hasSelection() || !event.clipboardData) return
    event.clipboardData.setData('text/plain', term.getSelection())
    event.preventDefault(); event.stopImmediatePropagation()
    ++revision; pendingCopy = null; update('Copied to your clipboard.')
  }
  element.addEventListener('paste', nativePaste, true)
  element.addEventListener('copy', nativeCopy, true)
  const selection = term.onSelectionChange(() => {
    if (term.hasSelection()) { ++revision; pendingCopy = null }
    update()
  })
  const osc = term.parser.registerOscHandler(52, data => {
    if (!options.connection()) return true
    const separator = data.indexOf(';')
    if (separator < 0 || !/^[cpqs0-7]*$/.test(data.slice(0, separator))) return true
    const encoded = data.slice(separator + 1)
    // Bound decoded text to 1 MiB and consume queries without replying.
    if (encoded === '?' || encoded.length > Math.ceil(1024 * 1024 / 3) * 4) return true
    try {
      const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
      if (bytes.length <= 1024 * 1024) void copyText(new TextDecoder().decode(bytes), true)
    } catch { /* Malformed clipboard output must not interrupt the terminal. */ }
    return true
  })
  return {
    copy, paste,
    reset() { ++revision; pendingCopy = null; update('') },
    handleKeyEvent(event: KeyboardEvent) {
      if (event.isComposing || event.altKey) return true
      const key = event.key.toLowerCase(), modifier = event.ctrlKey || event.metaKey
      // Let the browser dispatch its native paste event, without sending Ctrl+V
      // to the remote application or requiring Clipboard API read permission.
      if ((modifier && key === 'v') || (event.shiftKey && key === 'insert')) return false
      if (modifier && key === 'c') {
        if (term.hasSelection() && !event.shiftKey) return false
        if (event.shiftKey || event.metaKey) {
          event.preventDefault()
          if (event.type === 'keydown') void copy()
          return false
        }
      }
      return true
    },
    dispose() {
      disposed = true; pendingCopy = null
      element.removeEventListener('paste', nativePaste, true)
      element.removeEventListener('copy', nativeCopy, true)
      selection.dispose(); osc.dispose()
    },
  }
}
