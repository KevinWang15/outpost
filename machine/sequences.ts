import { StringDecoder } from 'node:string_decoder'

/** Only commit complete UTF-8/VT sequences. A checkpoint can then never split
 * a parser command. This frames sequences; xterm alone interprets them. */
export class Sequences {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private state: 'text' | 'escape' | 'csi' | 'string' | 'string-escape' = 'text'
  private osc = false

  feed(bytes: Buffer): string {
    const text = this.decoder.write(bytes)
    let complete = ''
    for (const char of text) {
      this.pending += char
      const code = char.charCodeAt(0)
      // ESC ends OSC/DCS even when the following escape is not ST. Parse that
      // escape normally; otherwise a new CSI could strand the visible output.
      if (this.state === 'string-escape') this.state = 'escape'
      if (char === '\x18' || char === '\x1a') this.state = 'text'
      else if (this.state === 'string') {
        if (char === '\x1b') this.state = 'string-escape'
        else if (char === '\x9c' || (this.osc && char === '\x07')) this.state = 'text'
      } else if (char === '\x1b') this.state = 'escape'
      else if (this.state === 'escape') {
        if (char === '[') this.state = 'csi'
        else if (']PX^_'.includes(char)) {
          this.osc = char === ']'
          this.state = 'string'
        } else if (code >= 0x30 && code <= 0x7e) this.state = 'text'
      } else if (this.state === 'csi') {
        if (code >= 0x40 && code <= 0x7e) this.state = 'text'
      } else if (char === '\x9b') this.state = 'csi'
      else if ('\x90\x98\x9d\x9e\x9f'.includes(char)) {
        this.osc = char === '\x9d'
        this.state = 'string'
      }
      if (this.pending.length > 1024 * 1024) {
        // Match a terminal's bounded parser: cancel an oversized, unterminated
        // control string without retaining an unbounded output journal.
        this.pending = '\x18'
        this.state = 'text'
      }
      if (this.state === 'text') {
        complete += this.pending
        this.pending = ''
      }
    }
    return complete
  }
}
