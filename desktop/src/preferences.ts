import { readFile } from 'node:fs/promises'
import type { TerminalPreferences } from '../../shared/desktop'
import { writeJsonFile } from '../../shared/node/jsonFile'

export const defaultPreferences: TerminalPreferences = { fontSize: 13.5, sound: true }
export function validPreferences(value: unknown): value is TerminalPreferences {
  if (!value || typeof value !== 'object') return false
  const item = value as TerminalPreferences
  return Number.isFinite(item.fontSize) && item.fontSize >= 10 && item.fontSize <= 28 && typeof item.sound === 'boolean'
}

interface StoredPreferences extends TerminalPreferences {
  localShell: string | null
}
const validShell = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && /^[a-z-]{1,32}$/.test(value))
function validStoredPreferences(value: unknown): value is StoredPreferences {
  return (
    validPreferences(value) && Object.keys(value).length === 3 && 'localShell' in value && validShell(value.localShell)
  )
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
      if (!validStoredPreferences(value))
        throw new Error(`Invalid terminal preferences. Remove ${this.path} to reset settings, then restart Outpost.`)
      this.value = { fontSize: value.fontSize, sound: value.sound }
      this.localShell = value.localShell
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  set(value: TerminalPreferences, localShell = this.localShell) {
    if (!validPreferences(value) || !validShell(localShell)) throw new Error('Invalid terminal preferences.')
    const next = { fontSize: value.fontSize, sound: value.sound }
    const write = this.writes.then(async () => {
      await writeJsonFile(this.path, { ...next, localShell })
      this.value = next
      this.localShell = localShell
    })
    this.writes = write.catch(() => {})
    return write
  }
}
