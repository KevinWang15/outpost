/** One definition for the terminal context menu and key handling. */
export function clearScreenShortcut(mac: boolean) {
  return {
    label: 'Clear screen',
    keys: mac ? '⌘K' : 'Ctrl+Shift+K',
    matches(event: {
      key: string
      metaKey: boolean
      ctrlKey: boolean
      altKey: boolean
      shiftKey: boolean
      isComposing: boolean
    }) {
      return (
        !event.isComposing &&
        event.key.toLowerCase() === 'k' &&
        !event.altKey &&
        (mac ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && event.shiftKey && !event.metaKey)
      )
    },
  }
}
