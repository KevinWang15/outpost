/* eslint-disable no-control-regex -- Terminal protocols contain literal control characters. */
// Interpret only local key sequences. Bracketed pastes and terminal replies are
// opaque: pasted text or an OSC/DCS response must never read the clipboard.
export class NativeInput {
  private pending = ''
  private mode: 'normal' | 'paste' | 'osc' | 'string' = 'normal'
  private timer?: ReturnType<typeof setTimeout>

  constructor(private write: (data: string) => void, private action: (retry: boolean) => void) {}

  push(data: string) {
    clearTimeout(this.timer)
    this.pending += data
    while (this.pending) {
      if (this.mode !== 'normal') {
        const end = this.mode === 'paste' ? /\x1b\[201~/ : this.mode === 'osc' ? /\x07|\x1b\\|[\x18\x1a]/ : /\x1b\\|[\x18\x1a]/
        const found = end.exec(this.pending)
        if (!found) {
          // Retain only a possible split terminator, even for large pastes.
          const keep = this.mode === 'paste' ? 5 : 1
          if (this.pending.length > keep) { this.write(this.pending.slice(0, -keep)); this.pending = this.pending.slice(-keep) }
          return
        }
        const length = found.index + found[0].length
        this.write(this.pending.slice(0, length)); this.pending = this.pending.slice(length); this.mode = 'normal'
        continue
      }
      const escape = this.pending.indexOf('\x1b')
      if (escape < 0) { this.flush(); return }
      if (escape > 0) { this.write(this.pending.slice(0, escape)); this.pending = this.pending.slice(escape) }
      if (this.pending.length < 2) break
      if (']P_^X'.includes(this.pending[1])) {
        this.mode = this.pending[1] === ']' ? 'osc' : 'string'
        this.write(this.pending.slice(0, 2)); this.pending = this.pending.slice(2); continue
      }
      if (this.pending[1] === '[') {
        const sequence = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.pending)?.[0]
        if (!sequence) {
          if (this.pending.length < 64) break
          this.flush(); return
        }
        this.pending = this.pending.slice(sequence.length)
        const key = /^\x1b\[19(?:;(\d+)(?::([123]))?)?~$/.exec(sequence)
        const modifiers = key ? (Number(key[1] ?? 1) - 1) & ~192 : -1
        if (key && (modifiers === 0 || modifiers === 1)) {
          // Kitty can report repeats and releases; a press owns one paste.
          if (!key[2] || key[2] === '1') this.action(modifiers === 1)
        } else if (sequence === '\x1b[9001~') this.action(false)
        else if (sequence === '\x1b[9002~') this.action(true)
        else {
          if (sequence === '\x1b[200~') this.mode = 'paste'
          this.write(sequence)
        }
      } else {
        this.write(this.pending.slice(0, 2)); this.pending = this.pending.slice(2)
      }
    }
    // An ordinary Escape key must not wait indefinitely for another byte.
    this.timer = setTimeout(() => this.flush(), 40)
  }

  private flush() { if (this.pending) this.write(this.pending); this.pending = '' }
  reset() { clearTimeout(this.timer); this.pending = ''; this.mode = 'normal' }
}
