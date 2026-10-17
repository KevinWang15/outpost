import type { WebContents } from 'electron'

// Native workspace presentation, independent of the server page and terminal
// protocol. A fixed, click-through overlay never changes xterm's geometry.
const dimmedCSS = `html::after {
  content: "" !important;
  position: fixed !important;
  inset: 0 !important;
  background: rgba(37, 41, 49, 0.26) !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
}`

export class PaneAppearance {
  private dimmed = false
  private key: string | null = null
  private generation = 0
  private pending = Promise.resolve()

  constructor(private contents: WebContents) {
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame || inPlace) return
      this.generation++
      this.key = null
    })
    contents.on('dom-ready', () => this.update())
  }
  setDimmed(value: boolean) {
    if (value === this.dimmed) return
    this.dimmed = value
    this.update()
  }
  private update() {
    // Serialize native CSS operations. Focus changes and navigation can finish
    // while an insertion is pending; the final requested state always wins.
    this.pending = this.pending
      .then(async () => {
        if (this.contents.isDestroyed()) return
        if (this.dimmed && this.key === null) {
          const generation = this.generation
          const key = await this.contents.insertCSS(dimmedCSS)
          if (this.contents.isDestroyed()) return
          if (generation === this.generation) this.key = key
          else await this.contents.removeInsertedCSS(key)
        } else if (!this.dimmed && this.key !== null) {
          const key = this.key
          this.key = null
          await this.contents.removeInsertedCSS(key)
        }
      })
      .catch(() => {
        // Navigation/destruction may invalidate an in-flight operation. The next
        // DOM-ready or presentation change reapplies the current desired state.
      })
  }
}
