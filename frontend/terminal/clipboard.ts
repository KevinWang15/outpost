import type { Terminal } from '@xterm/xterm'
import { imageMediaTypes, maxImageBytes } from '../../shared/model'
import { desktop } from '../desktop'

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
  },
) {
  let disposed = false,
    pendingCopy: string | null = null
  const element = term.element!
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
    async copy() {
      const text = pendingCopy ?? (term.hasSelection() ? term.getSelection() : null)
      if (text === null) return options.status('Select text to copy.')
      await writeClipboard(text, false)
    },
    async paste() {
      if (!options.connected()) return
      try {
        if (desktop) {
          term.focus()
          if (!(await desktop.pasteClipboard())) throw new Error('Paste unavailable')
          return
        }
        if (navigator.clipboard.read) {
          const items = await navigator.clipboard.read()
          const image = items.find(item => item.types.some(type => type.startsWith('image/')))
          if (image) {
            const type =
              image.types.find(type => type === 'image/png') ?? image.types.find(type => type.startsWith('image/'))!
            return options.pasteImage(new File([await image.getType(type)], 'clipboard-image', { type }))
          }
          const text = items.find(item => item.types.includes('text/plain'))
          if (text) term.paste(await (await text.getType('text/plain')).text())
        } else term.paste(await navigator.clipboard.readText())
        term.focus()
      } catch {
        options.status('Paste was blocked. Use your paste shortcut instead.')
      }
    },
    /** Let the browser deliver Cmd/Ctrl+V as a paste event instead of sending ^V. */
    handleKey(event: KeyboardEvent) {
      if (event.isComposing || event.altKey) return true
      const key = event.key.toLowerCase(),
        modifier = event.ctrlKey || event.metaKey
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
      element.removeEventListener('paste', nativePaste, true)
      element.removeEventListener('copy', nativeCopy, true)
      osc.dispose()
    },
  }
}
