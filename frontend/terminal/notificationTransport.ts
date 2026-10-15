import { desktop } from '../desktop'

let registration: Promise<ServiceWorkerRegistration | null> | null = null

function activate(worker: ServiceWorker) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      worker.removeEventListener('statechange', changed)
      if (error) reject(error)
      else resolve()
    }
    const changed = () => {
      if (worker.state === 'activated') finish()
      else if (worker.state === 'redundant') finish(new Error('Notification setup failed. Tap the bell to retry.'))
    }
    const timer = setTimeout(() => finish(new Error('Notification setup timed out. Tap the bell to retry.')), 8000)
    worker.addEventListener('statechange', changed)
    changed()
  })
}

/** Notifications only: no fetch handler, offline cache, credentials, or background session connection. */
export function prepareBrowserNotifications() {
  if (desktop || !('serviceWorker' in navigator)) return Promise.resolve(null)
  if (!registration) {
    const setup = async () => {
      const result = await navigator.serviceWorker.register('/terminal-notifications.js', {
        scope: '/terminal',
        updateViaCache: 'none',
      })
      const worker = result.active ?? result.installing ?? result.waiting
      if (!worker) throw new Error('Notification setup failed. Tap the bell to retry.')
      await activate(worker)
      return result
    }
    let timer: ReturnType<typeof setTimeout>
    registration = Promise.race([
      setup(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Notification setup timed out. Tap the bell to retry.')), 10_000)
      }),
    ])
      .catch(error => {
        registration = null
        throw error
      })
      .finally(() => clearTimeout(timer))
  }
  return registration
}

export interface BrowserBellNotification {
  close(): void
}

export async function showBrowserNotification(
  session: { id: string; name: string },
  wanted: () => boolean,
  onClick: () => void,
  onError: () => void,
): Promise<BrowserBellNotification | null> {
  const worker = await prepareBrowserNotifications()
  if (!wanted()) return null
  const title = 'Outpost · Terminal bell'
  const options = { body: `${session.name} rang a bell`, icon: '/outpost.png', tag: `outpost-bell:${session.id}` }
  if (worker) {
    // Notification data contains only a normal authenticated page URL, never launch/resume tokens.
    const current = new URL(window.location.href)
    const url = new URL('/terminal', current.origin)
    for (const key of ['target', 'session']) {
      const value = current.searchParams.get(key)
      if (value) url.searchParams.set(key, value)
    }
    const id = crypto.randomUUID()
    await worker.showNotification(title, { ...options, data: { url: url.href, id } })
    return {
      close() {
        void worker
          .getNotifications({ tag: options.tag })
          .then(notifications => {
            for (const notification of notifications) if (notification.data?.id === id) notification.close()
          })
          .catch(() => {})
      },
    }
  }
  const notification = new Notification(title, options)
  notification.onclick = onClick
  notification.onerror = onError
  return {
    close() {
      notification.onclick = notification.onerror = null
      notification.close()
    },
  }
}
