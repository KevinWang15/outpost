import type { Terminal } from '@xterm/xterm'
import { desktop } from '../desktop'

export type BellNotificationPermission = NotificationPermission | 'unsupported' | 'insecure'

export function bellNotificationPermission(): BellNotificationPermission {
  if (desktop) return desktop.notificationsSupported ? 'granted' : 'unsupported'
  if (!window.isSecureContext) return 'insecure'
  if (typeof window.Notification !== 'function') return 'unsupported'
  return Notification.permission
}

/** Use the parser's bell event: BEL also terminates OSC sequences, where it
 * must not ring. Browser attention, notifications, and sound belong to this connection. */
export function attachBell(
  term: Terminal,
  changed: (ringing: boolean) => void,
  session: () => { id: string; name: string },
) {
  let audio: AudioContext | null = null
  let notification: Notification | null = null
  let notified = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSound = -Infinity
  const active = () => document.visibilityState === 'visible' && document.hasFocus()
  const closeNotification = () => {
    if (desktop) void desktop.dismissBell().catch(() => {})
    const current = notification
    notification = null
    if (!current) return
    current.onclick = current.onclose = current.onerror = null
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
    if (desktop) {
      notified = true
      void desktop.notifyBell(session().name).then(
        shown => {
          if (!shown) notified = false
        },
        () => {
          notified = false
        },
      )
      return
    }
    try {
      const current = new Notification('Outpost · Terminal bell', {
        body: `${session().name} rang a bell`,
        icon: '/outpost.png',
        // App windows share a page URL. Group by the session, never by URL or token.
        tag: `outpost-bell:${session().id}`,
      })
      notification = current
      notified = true
      current.onclick = () => {
        // Preserve the browser's default click action, which activates this tab.
        window.focus()
        term.focus()
        acknowledge()
      }
      current.onclose = () => {
        if (notification === current) notification = null
      }
      current.onerror = () => {
        if (notification === current) {
          closeNotification()
          notified = false
        }
      }
    } catch {
      // Permission can change, and some browsers cannot create notifications.
      // Keep the visual bell and chime even when desktop alerts are unavailable.
    }
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
