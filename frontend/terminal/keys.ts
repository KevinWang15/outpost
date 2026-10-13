export interface TerminalModifiers { ctrl?: boolean; alt?: boolean; shift?: boolean }

/** Encode terminal keys using the same cursor mode and modifier conventions as
 * xterm. Modified Enter uses CSI-u, as the terminal's physical Shift+Enter does. */
export function terminalKey(key: string, modifiers: TerminalModifiers = {}, applicationCursor = false): string | null {
  const modifier = 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0)
  const cursor: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' }
  if (Object.hasOwn(cursor, key)) return modifier > 1 ? `\x1b[1;${modifier}${cursor[key]}` : `\x1b${applicationCursor ? 'O' : '['}${cursor[key]}`
  const tilde: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 }
  if (Object.hasOwn(tilde, key)) return `\x1b[${tilde[key]}${modifier > 1 ? `;${modifier}` : ''}~`
  if (/^F[1-4]$/.test(key)) {
    const suffix = 'PQRS'[Number(key.slice(1)) - 1]
    return modifier > 1 ? `\x1b[1;${modifier}${suffix}` : `\x1bO${suffix}`
  }
  let data: string
  if (key === 'Enter') return modifiers.shift || modifiers.ctrl ? `\x1b[13;${modifier}u` : `${modifiers.alt ? '\x1b' : ''}\r`
  if (key === 'Tab') return modifiers.shift ? '\x1b[Z' : '\t'
  if (key === 'Escape') data = '\x1b'
  else if (key === 'Backspace') data = modifiers.ctrl ? '\b' : '\x7f'
  else {
    if (key === 'Space') key = ' '
    if ([...key].length !== 1) return null
    data = modifiers.shift ? key.toUpperCase() : key
    if (modifiers.ctrl) {
      const code = key.toUpperCase().charCodeAt(0)
      if (key === ' ') data = '\0'
      else if (key === '?') data = '\x7f'
      else if (code >= 64 && code <= 95) data = String.fromCharCode(code & 31)
      else return null
    }
  }
  return `${modifiers.alt ? '\x1b' : ''}${data}`
}
