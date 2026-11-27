import { terminalService, validScrollback, type Scrollback } from '../../shared/terminalService'
import { SerializedJsonStore } from './json-store'

interface TerminalPreferences {
  fontSize: number
  sound: boolean
  scrollbackLines: number
  unlimitedScrollback: boolean
}

const defaultPreferences: TerminalPreferences = {
  fontSize: 13.5,
  sound: true,
  scrollbackLines: terminalService.scrollback,
  unlimitedScrollback: false,
}

function validPreferences(value: unknown): value is TerminalPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
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

const allowedStoredKeys = new Set(['fontSize', 'sound', 'scrollbackLines', 'unlimitedScrollback', 'localShell'])

function parseStoredPreferences(value: unknown): StoredPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!Object.keys(raw).every(key => allowedStoredKeys.has(key))) return null
  const candidate: StoredPreferences = {
    fontSize: raw.fontSize === undefined ? defaultPreferences.fontSize : (raw.fontSize as number),
    sound: raw.sound === undefined ? defaultPreferences.sound : (raw.sound as boolean),
    scrollbackLines:
      raw.scrollbackLines === undefined ? defaultPreferences.scrollbackLines : (raw.scrollbackLines as number),
    unlimitedScrollback:
      raw.unlimitedScrollback === undefined
        ? defaultPreferences.unlimitedScrollback
        : (raw.unlimitedScrollback as boolean),
    localShell: raw.localShell === undefined ? null : (raw.localShell as string | null),
  }
  return validPreferences(candidate) && validShell(candidate.localShell) ? candidate : null
}

/** Presentation only. Credentials, terminal content and drafts are never persisted. */
export class Preferences {
  private store: SerializedJsonStore<StoredPreferences>

  constructor(path: string) {
    this.store = new SerializedJsonStore<StoredPreferences>(path, { ...defaultPreferences, localShell: null })
  }

  get value(): TerminalPreferences {
    const { localShell: _, ...preferences } = this.store.value
    return preferences
  }

  get localShell(): string | null {
    return this.store.value.localShell
  }

  get scrollback(): Scrollback {
    return this.store.value.unlimitedScrollback ? 'unlimited' : this.store.value.scrollbackLines
  }

  load() {
    return this.store.load(raw => {
      const parsed = parseStoredPreferences(raw)
      if (!parsed)
        throw new Error(
          `Invalid terminal preferences. Remove ${this.store.path} to reset settings, then restart Outpost.`,
        )
      return parsed
    })
  }

  set(value: TerminalPreferences, localShell = this.localShell) {
    if (!validPreferences(value) || !validShell(localShell)) throw new Error('Invalid terminal preferences.')
    const next: StoredPreferences = {
      fontSize: value.fontSize,
      sound: value.sound,
      scrollbackLines: value.scrollbackLines,
      unlimitedScrollback: value.unlimitedScrollback,
      localShell,
    }
    return this.store.change(() => next)
  }
}
