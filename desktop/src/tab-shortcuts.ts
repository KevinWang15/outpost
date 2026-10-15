import type { WebContents } from 'electron'

/** Reserve tab navigation before a terminal or workspace page handles the key. */
export function attachTabShortcuts(contents: WebContents, cycle: (delta: 1 | -1) => void) {
  contents.on('before-input-event', (event, input) => {
    if (
      input.key !== 'Tab' ||
      !input.control ||
      input.alt ||
      input.meta ||
      input.isComposing ||
      (input.type !== 'keyDown' && input.type !== 'keyUp')
    )
      return
    // Also suppress the menu accelerator, so one press switches exactly once.
    event.preventDefault()
    if (input.type === 'keyDown') cycle(input.shift ? -1 : 1)
  })
}
