import type { Terminal } from '@xterm/xterm'
import { desktop } from '../desktop'
import { appleMobile, standaloneBrowser } from '../browser'
import { showBrowserNotification, type BrowserBellNotification } from './notificationTransport'

export type BellNotificationPermission = NotificationPermission | 'unsupported' | 'insecure' | 'home-screen'

export function bellNotificationPermission(): BellNotificationPermission {
  if (desktop) return desktop.notificationsSupported ? 'granted' : 'unsupported'
  if (!window.isSecureContext) return 'insecure'
  if (appleMobile() && !standaloneBrowser()) return 'home-screen'
  if (typeof window.Notification !== 'function') return 'unsupported'
  return Notification.permission
}

/** Use the parser's bell event: BEL also terminates OSC sequences, where it
 * must not ring. Browser attention, notifications, and sound belong to this connection. */
export function attachBell(
  term: Terminal,
  changed: (ringing: boolean) => void,
  session: () => { id: string; name: string },
  preferences?: { active: () => boolean; sound: () => boolean },
  onNotificationError?: (message: string) => void,
) {
  let audio: AudioContext | null = null
  let notification: BrowserBellNotification | null = null
  let generation = 0
  let notified = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSound = -Infinity
  const active = preferences?.active ?? (() => document.visibilityState === 'visible' && document.hasFocus())
  const closeNotification = () => {
    generation++
    if (desktop) void desktop.dismissBell().catch(() => {})
    const current = notification
    notification = null
    if (!current) return
    try {
      current.close()
    } catch {
      // A browser notification failure must not interrupt the terminal.
    }
  }
  const acknowledge = () => {
    clearTimeout(timer)
    closeNotification()
    notified = false
    changed(false)
  }
  const showNotification = () => {
    if (active() || notified || bellNotificationPermission() !== 'granted') return
    const attempt = ++generation
    notified = true
    if (desktop) {
      void desktop.notifyBell(session().name).then(
        shown => {
          if (!shown && generation === attempt) notified = false
        },
        () => {
          if (generation === attempt) notified = false
        },
      )
      return
    }
    const failed = () => {
      if (generation !== attempt) return
      closeNotification()
      notified = false
      onNotificationError?.('Could not show a notification. Tap the bell to check notification access.')
    }
    void showBrowserNotification(
      session(),
      () => generation === attempt && !active(),
      () => {
        window.focus()
        term.focus()
        acknowledge()
      },
      failed,
    )
      .then(current => {
        // Permission/worker setup can finish after a tab was acknowledged or closed.
        if (generation !== attempt || active()) {
          current?.close()
          return
        }
        notification = current
        if (!current) notified = false
      })
      .catch(failed)
  }
  const prepareSound = () => {
    try {
      audio ??= new AudioContext()
      if (audio.state === 'suspended') void audio.resume().catch(() => {})
    } catch {
      // Audio may be unavailable or blocked; the visual bell still works.
    }
  }
  const playSound = () => {
    if (preferences && !preferences.sound()) return
    prepareSound()
    if (!audio || audio.state !== 'running' || performance.now() - lastSound < 1000) return
    try {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      const now = audio.currentTime
      oscillator.frequency.setValueAtTime(880, now)
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(0.12, now + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.onended = () => {
        oscillator.disconnect()
        gain.disconnect()
      }
      oscillator.start(now)
      oscillator.stop(now + 0.22)
      lastSound = performance.now()
    } catch {
      // Audio failures must never interrupt terminal output.
    }
  }
  const interact = () => {
    // Unlock sound during a browser gesture, before a later background bell.
    prepareSound()
    acknowledge()
  }
  const returned = () => {
    if (active()) acknowledge()
  }
  const listener = term.onBell(() => {
    changed(true)
    playSound()
    showNotification()
    clearTimeout(timer)
    if (active()) timer = setTimeout(returned, 4000)
  })
  window.addEventListener('click', interact, true)
  window.addEventListener('keydown', interact, true)
  window.addEventListener('focus', returned)
  document.addEventListener('visibilitychange', returned)

  return {
    acknowledge,
    dispose() {
      listener.dispose()
      clearTimeout(timer)
      closeNotification()
      window.removeEventListener('click', interact, true)
      window.removeEventListener('keydown', interact, true)
      window.removeEventListener('focus', returned)
      document.removeEventListener('visibilitychange', returned)
      if (audio) void audio.close().catch(() => {})
    },
  }
}
