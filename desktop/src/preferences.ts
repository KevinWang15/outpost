import { readFile } from 'node:fs/promises'
import { writeJsonFile } from '../../shared/node/jsonFile'

import { terminalService, validScrollback, type Scrollback } from '../../shared/terminalService'

interface TerminalPreferences {
  fontSize: number
  sound: boolean
  scrollbackLines: number
  unlimitedScrollback: boolean
}

export const defaultPreferences: TerminalPreferences = {
  fontSize: 13.5,
  sound: true,
  scrollbackLines: terminalService.scrollback,
  unlimitedScrollback: false,
}
export function validPreferences(value: unknown): value is TerminalPreferences {
  if (!value || typeof value !== 'object') return false
  const item = value as TerminalPreferences
  return (
    Number.isFinite(item.fontSize) &&
    item.fontSize >= 10 &&
    item.fontSize <= 28 &&
    typeof item.sound === 'boolean' &&
    typeof item.scrollbackLines === 'number' &&
    validScrollback(item.scrollbackLines) &&
    typeof item.unlimitedScrollback === 'boolean'
  )
}

interface StoredPreferences extends TerminalPreferences {
  localShell: string | null
}
const validShell = (value: unknown): value is string | null =>
  value === null || (typeof value === 'string' && /^[a-z-]{1,32}$/.test(value))
function validStoredPreferences(value: unknown): value is StoredPreferences {
  return (
    validPreferences(value) &&
    Object.keys(value).length === Object.keys(defaultPreferences).length + 1 &&
    'localShell' in value &&
    validShell(value.localShell)
  )
}

/** Presentation only. Credentials, terminal content and drafts are never persisted. */
export class Preferences {
  value = { ...defaultPreferences }
  localShell: string | null = null
  private writes = Promise.resolve()
  constructor(private path: string) {}
  get scrollback(): Scrollback {
    return this.value.unlimitedScrollback ? 'unlimited' : this.value.scrollbackLines
  }
  async load() {
    try {
      const value: unknown = {
        scrollbackLines: defaultPreferences.scrollbackLines,
        unlimitedScrollback: defaultPreferences.unlimitedScrollback,
        ...JSON.parse(await readFile(this.path, 'utf8')),
      }
      if (!validStoredPreferences(value))
        throw new Error(`Invalid terminal preferences. Remove ${this.path} to reset settings, then restart Outpost.`)
      const { localShell, ...preferences } = value
      this.value = preferences
      this.localShell = localShell
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  set(value: TerminalPreferences, localShell = this.localShell) {
    if (!validPreferences(value) || !validShell(localShell)) throw new Error('Invalid terminal preferences.')
    const next = { ...value }
    const write = this.writes.then(async () => {
      await writeJsonFile(this.path, { ...next, localShell })
      this.value = next
      this.localShell = localShell
    })
    this.writes = write.catch(() => {})
    return write
  }
}
