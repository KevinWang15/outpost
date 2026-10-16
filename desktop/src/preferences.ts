import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TerminalPreferences } from '../../shared/desktop'

export const defaultPreferences: TerminalPreferences = { fontSize: 13.5, sound: true }
export function validPreferences(value: unknown): value is TerminalPreferences {
  if (!value || typeof value !== 'object') return false
  const item = value as TerminalPreferences
  return Number.isFinite(item.fontSize) && item.fontSize >= 10 && item.fontSize <= 28 && typeof item.sound === 'boolean'
}

/** Presentation only. Credentials, terminal content and drafts are never persisted. */
export class Preferences {
  value = { ...defaultPreferences }
  localShell: string | null = null
  private writes = Promise.resolve()
  constructor(private path: string) {}
  async load() {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!validPreferences(value)) throw new Error('Invalid terminal preferences.')
      this.value = { fontSize: value.fontSize, sound: value.sound }
      const shell = (value as TerminalPreferences & { localShell?: unknown }).localShell
      if (typeof shell === 'string' && /^[a-z-]{1,32}$/.test(shell)) this.localShell = shell
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  set(value: TerminalPreferences, localShell = this.localShell) {
    if (!validPreferences(value)) throw new Error('Invalid terminal preferences.')
    const next = { fontSize: value.fontSize, sound: value.sound }
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await writeFile(this.path + '.tmp', JSON.stringify({ ...next, localShell }), { mode: 0o600 })
      await rename(this.path + '.tmp', this.path)
      this.value = next
      this.localShell = localShell
    })
    this.writes = write.catch(() => {})
    return write
  }
}
