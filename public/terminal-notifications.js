// Deliberately no fetch or push handler: this worker only displays bells from an open terminal.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const origin = self.location.origin
      let url
      try {
        url = new URL(event.notification.data?.url, origin)
        if (url.origin !== origin || url.pathname !== '/terminal') return
        if (!url.searchParams.has('target') || !url.searchParams.has('session')) return
      } catch {
        return
      }
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = windows.find(client => {
        const candidate = new URL(client.url)
        return (
          candidate.origin === origin &&
          candidate.pathname === '/terminal' &&
          ['target', 'session'].every(key => candidate.searchParams.get(key) === url.searchParams.get(key))
        )
      })
      if (existing) {
        try {
          await existing.focus()
          return
        } catch {
          // The matching tab may have closed between enumeration and activation.
        }
      }
      await self.clients.openWindow(url.href)
    })(),
  )
})
