import type { Input, WebContents } from 'electron'

/** Shared by native menu accelerators and the workspace's shortcut guide. */
export function tabActionShortcuts(platform: string) {
  const modifier = platform === 'darwin' ? 'Cmd+' : 'Ctrl+Shift+'
  const shortcut = (label: string, key: string) => {
    const accelerator = modifier + key
    return { label, accelerator, keys: accelerator.replace('Cmd+', '⌘') }
  }
  return {
    newTab: shortcut('New local terminal tab', 'T'),
  }
}

/** Pane menus and both shortcut guides use this same platform mapping. */
export function paneActionShortcuts(platform: string) {
  const mac = platform === 'darwin'
  const shortcut = (label: string, accelerator: string) => ({
    label,
    accelerator,
    keys: accelerator.replace('Cmd+', '⌘').replace('Alt+', mac ? 'Option+' : 'Alt+'),
  })
  return {
    splitColumns: shortcut('Split side by side', mac ? 'Cmd+D' : 'Ctrl+Shift+D'),
    splitRows: shortcut('Split top and bottom', mac ? 'Cmd+Shift+D' : 'Ctrl+Alt+D'),
    zoom: shortcut('Zoom / restore pane', mac ? 'Cmd+Shift+Enter' : 'Ctrl+Shift+Enter'),
    close: shortcut('Close focused pane', mac ? 'Cmd+W' : 'Ctrl+Shift+W'),
    next: shortcut('Focus other pane', mac ? 'Cmd+Alt+Right' : 'Ctrl+Alt+Right'),
  }
}
export type PaneAction = keyof ReturnType<typeof paneActionShortcuts>

function matches(input: Input, accelerator: string) {
  const parts = accelerator.toLowerCase().split('+')
  const key = parts.pop()!
  return (
    input.key.toLowerCase().replace(/^arrow/, '') === key &&
    !!input.control === parts.includes('ctrl') &&
    !!input.meta === parts.includes('cmd') &&
    !!input.alt === parts.includes('alt') &&
    !!input.shift === parts.includes('shift')
  )
}

/** Reserve workspace gestures before either the chrome or a terminal gets input.
 * Pointer capture does not move keyboard focus out of a native terminal view. */
export function attachWorkspaceShortcuts(
  contents: WebContents,
  actions: { cycle(delta: 1 | -1): void; cancelDrag(): boolean; pane(action: PaneAction): void },
  platform = process.platform,
) {
  let escapeCaptured = false
  const panes = Object.entries(paneActionShortcuts(platform)) as [PaneAction, { accelerator: string }][]
  contents.on('before-input-event', (event, input) => {
    if (input.isComposing || (input.type !== 'keyDown' && input.type !== 'keyUp')) return
    if (input.key === 'Escape') {
      if (input.type === 'keyDown' && !input.control && !input.alt && !input.meta)
        escapeCaptured = actions.cancelDrag() || escapeCaptured
      if (escapeCaptured) {
        event.preventDefault()
        if (input.type === 'keyUp') escapeCaptured = false
        return
      }
    }
    const pane = panes.find(([, shortcut]) => matches(input, shortcut.accelerator))
    if (pane) {
      // xterm consumes Enter before Electron's menu fallback can see it. Reserve
      // every pane accelerator consistently, using the menu's shared definition.
      event.preventDefault()
      if (input.type === 'keyDown' && !input.isAutoRepeat) actions.pane(pane[0])
      return
    }
    if (input.key !== 'Tab' || !input.control || input.alt || input.meta) return
    // Also suppress the menu accelerator, so one press switches exactly once.
    event.preventDefault()
    if (input.type === 'keyDown') actions.cycle(input.shift ? -1 : 1)
  })
}
