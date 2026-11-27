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
      if (!validStoredPreferences(raw))
        throw new Error(
          `Invalid terminal preferences. Remove ${this.store.path} to reset settings, then restart Outpost.`,
        )
      return {
        fontSize: raw.fontSize,
        sound: raw.sound,
        scrollbackLines: raw.scrollbackLines,
        unlimitedScrollback: raw.unlimitedScrollback,
        localShell: raw.localShell,
      }
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
