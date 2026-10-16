import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { browserUrl } from '../../shared/signals'
import { openBrowserTab } from './browser'

/** Own both OSC 8 hyperlinks and detected URLs. A link gesture must not also
 * reach the terminal application, which could independently open the browser
 * before the user answers the hyperlink confirmation. */
export function attachTerminalLinks(terminal: Terminal, blocked: (url: string) => void) {
  const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!
  const mac = /Mac/.test(navigator.platform)
  let hovered: string | null = null
  let ownedGesture = false
  let disposed = false
  const forceSelection = (event: MouseEvent) =>
    event.shiftKey || (mac && terminal.options.macOptionClickForcesSelection && event.altKey)
  const hover = (_event: MouseEvent, uri: string) => {
    hovered = uri
  }
  const leave = (_event: MouseEvent, uri: string) => {
    if (hovered === uri) hovered = null
  }
  const activate = (event: MouseEvent, uri: string, confirm: boolean) => {
    if (event.button !== 0 || forceSelection(event) || terminal.hasSelection()) return
    event.preventDefault()
    if (ownedGesture) event.stopImmediatePropagation()
    ownedGesture = false
    let url: string
    try {
      url = browserUrl({ url: uri })
    } catch {
      return
    }
    // OSC 8 can display a label unrelated to its destination. Show the actual
    // URL and return on cancellation, without calling either browser opener.
    if (confirm && !window.confirm(`Do you want to navigate to ${url}?`)) return
    void openBrowserTab(url).then(opened => {
      if (!disposed && !opened) blocked(url)
    })
  }
  const previous = terminal.options.linkHandler
  terminal.options.linkHandler = { activate: (event, uri) => activate(event, uri, true), hover, leave }
  const web = new WebLinksAddon((event, uri) => activate(event, uri, false), { hover, leave })
  terminal.loadAddon(web)

  // Linkifier records the press on .xterm-screen before these bubbling
  // listeners. Consume application mouse gestures before they reach xterm's
  // PTY mouse reporter on the parent element. Ordinary local selection still
  // receives its press/release, including drags starting on URL text.
  const down = (event: MouseEvent) => {
    ownedGesture = Boolean(
      hovered && event.button === 0 && !forceSelection(event) && terminal.modes.mouseTrackingMode !== 'none',
    )
    if (!ownedGesture) return
    event.preventDefault()
    event.stopPropagation()
    terminal.clearSelection()
    terminal.focus()
  }
  const move = (event: MouseEvent) => {
    if (ownedGesture) event.stopPropagation()
  }
  const end = () => {
    ownedGesture = false
  }
  screen.addEventListener('mousedown', down)
  screen.addEventListener('mousemove', move)
  window.addEventListener('mouseup', end)
  window.addEventListener('blur', end)
  return () => {
    disposed = true
    screen.removeEventListener('mousedown', down)
    screen.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', end)
    window.removeEventListener('blur', end)
    terminal.options.linkHandler = previous
    web.dispose()
  }
}
