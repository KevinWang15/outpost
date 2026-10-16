import type { Terminal } from '@xterm/xterm'
import { imageMediaTypes, maxImageBytes } from '../../shared/model'
import { desktop } from '../desktop'
import { touchInput } from '../browser'

/** Only text already visible in xterm; no remote history request or mode change. */
export function screenText(term: Terminal) {
  const buffer = term.buffer.active
  let text = ''
  for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row++) {
    const line = buffer.getLine(row)
    if (!line) break
    if (row > buffer.viewportY && !line.isWrapped) text += '\n'
    text += line.translateToString(!buffer.getLine(row + 1)?.isWrapped)
  }
  return text.replace(/\n+$/, '')
}

export function imageProblem(file: Blob): string | null {
  if (!(imageMediaTypes as readonly string[]).includes(file.type)) return 'That is not a PNG, JPEG, GIF, or WebP image.'
  if (!file.size || file.size > maxImageBytes) return 'Images are limited to 16 MB.'
  return null
}

/** Browser clipboard shims for the web terminal (principle 6): reads only on a
 * local paste gesture; OSC 52 lets remote programs copy to your clipboard. */
export function attachClipboard(
  term: Terminal,
  options: {
    connected: () => boolean
    pasteImage: (file: File) => void
    status: (message: string) => void
    pasteFallback?: () => void
  },
) {
  const mac = /Mac/.test(navigator.platform)
  let disposed = false,
    pendingCopy: string | null = null
  const element = term.element!
  let selecting = false,
    selectionChanged = false
  const writeClipboard = async (text: string, remote: boolean) => {
    pendingCopy = text
    try {
      // Background tabs keep the text for an explicit Copy action.
      if (!document.hasFocus()) throw new Error('inactive')
      if (desktop) {
        if (!(await desktop.copyText(text))) throw new Error('Copy unavailable')
      } else await navigator.clipboard.writeText(text)
      pendingCopy = null
      if (!disposed) options.status('Copied to your clipboard')
    } catch {
      if (!disposed) options.status(remote ? 'Text is ready to copy. Click Copy.' : 'Copy was blocked by the browser.')
    }
  }
  const nativePaste = (event: ClipboardEvent) => {
    const images = [...(event.clipboardData?.items ?? [])].filter(
      item => item.kind === 'file' && item.type.startsWith('image/'),
    )
    if (!images.length) return
    // Take the image before xterm turns the same clipboard item into text.
    event.preventDefault()
    event.stopImmediatePropagation()
    if (images.length > 1) return options.status('Paste one image at a time.')
    const file = images[0].getAsFile()
    if (file) options.pasteImage(file)
  }
  const nativeCopy = (event: ClipboardEvent) => {
    if (!term.hasSelection() || !event.clipboardData) return
    event.clipboardData.setData('text/plain', term.getSelection())
    event.preventDefault()
    event.stopImmediatePropagation()
    pendingCopy = null
    options.status('Copied to your clipboard')
  }
  // Preserve copy-on-release for xterm's local selection without sending a
  // mouse gesture or changing a mode on the remote side. Application-owned
  // mouse gestures produce no local selection and keep their own behavior.
  const selectionStart = (event: MouseEvent) => {
    selecting = event.button === 0
    selectionChanged = false
  }
  const selection = term.onSelectionChange(() => {
    if (selecting) selectionChanged = true
  })
  const selectionEnd = (event: MouseEvent) => {
    if (event.button !== 0) return
    const copy = selecting && selectionChanged && term.hasSelection()
    selecting = false
    if (copy) void writeClipboard(term.getSelection(), false)
  }
  const cancelSelection = () => {
    selecting = false
  }
  element.addEventListener('mousedown', selectionStart, true)
  // xterm finalizes selection on document mouseup; window runs afterward,
  // including when a drag finishes outside the terminal surface.
  window.addEventListener('mouseup', selectionEnd)
  window.addEventListener('blur', cancelSelection)
  element.addEventListener('paste', nativePaste, true)
  element.addEventListener('copy', nativeCopy, true)
  const osc = term.parser.registerOscHandler(52, data => {
    const separator = data.indexOf(';')
    if (!options.connected() || separator < 0 || !/^[cpqs0-7]*$/.test(data.slice(0, separator))) return true
    const encoded = data.slice(separator + 1)
    // Never answer clipboard queries; bound copies to 1 MiB.
    if (encoded === '?' || encoded.length > Math.ceil((1024 * 1024) / 3) * 4) return true
    try {
      void writeClipboard(
        new TextDecoder().decode(Uint8Array.from(atob(encoded), character => character.charCodeAt(0))),
        true,
      )
    } catch {
      /* Malformed copies must not interrupt the terminal. */
    }
    return true
  })
  return {
    canCopy() {
      return !disposed && (term.hasSelection() || pendingCopy !== null)
    },
    async copy() {
      if (disposed) return
      const text = term.hasSelection() ? term.getSelection() : pendingCopy
      if (text === null) return options.status('Select text to copy.')
      await writeClipboard(text, false)
    },
    async paste() {
      if (disposed || !options.connected()) return
      try {
        if (desktop) {
          term.focus()
          if (!(await desktop.pasteClipboard())) throw new Error('Paste unavailable')
          return
        }
        let value: string | undefined
        if (navigator.clipboard.read) {
          const items = await navigator.clipboard.read()
          if (disposed || !options.connected()) return
          const image = items.find(item => item.types.some(type => type.startsWith('image/')))
          if (image) {
            const type =
              image.types.find(type => type === 'image/png') ?? image.types.find(type => type.startsWith('image/'))!
            const data = await image.getType(type)
            if (!disposed && options.connected()) options.pasteImage(new File([data], 'clipboard-image', { type }))
            return
          }
          const text = items.find(item => item.types.includes('text/plain'))
          if (text) value = await (await text.getType('text/plain')).text()
        } else value = await navigator.clipboard.readText()
        if (disposed || !options.connected()) return
        if (value !== undefined) term.paste(value)
        term.focus()
      } catch {
        if (disposed) return
        if (touchInput()) options.pasteFallback?.()
        options.status(
          touchInput()
            ? 'Touch and hold the message box to paste, then tap Send.'
            : `Paste was blocked. Press ${mac ? 'Command+V' : 'Ctrl+V'} instead.`,
        )
      }
    },
    /** Add Ctrl+V on macOS; leave native paste shortcuts to their paste events. */
    handleKey(event: KeyboardEvent) {
      if (event.isComposing || event.altKey) return true
      const key = event.key.toLowerCase(),
        modifier = event.ctrlKey || event.metaKey
      if (mac && event.ctrlKey && !event.metaKey && !event.shiftKey && key === 'v') {
        // macOS does not produce a native paste event for Ctrl+V. Invoke the same
        // image-aware paste path as the context menu, during this user gesture.
        event.preventDefault()
        if (event.type === 'keydown' && !event.repeat) void this.paste()
        return false
      }
      if ((modifier && key === 'v') || (event.shiftKey && key === 'insert')) return false
      if (modifier && key === 'c' && (term.hasSelection() || event.metaKey || event.shiftKey)) {
        if (event.type === 'keydown' && !term.hasSelection()) {
          event.preventDefault()
          void this.copy()
        }
        return false
      }
      return true
    },
    dispose() {
      disposed = true
      element.removeEventListener('mousedown', selectionStart, true)
      window.removeEventListener('mouseup', selectionEnd)
      window.removeEventListener('blur', cancelSelection)
      selection.dispose()
      element.removeEventListener('paste', nativePaste, true)
      element.removeEventListener('copy', nativeCopy, true)
      osc.dispose()
    },
  }
}
