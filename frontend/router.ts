// Lightweight SPA router using React 19 concurrent transitions so route changes
// never blank the screen with a Suspense fallback while lazy chunks load.
import { startTransition, useEffect, useState, useTransition } from 'react'

export interface RouteLocation {
  pathname: string
  search: string
  hash: string
}

interface NavigationEvent {
  location: RouteLocation
  transition: boolean
}

type Listener = (event: NavigationEvent) => void

const listeners = new Set<Listener>()
let popstateInstalled = false

export function readLocation(): RouteLocation {
  if (typeof window === 'undefined') return { pathname: '/', search: '', hash: '' }
  return {
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  }
}

export function isPlainLeftClick(event: {
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  button: number
}): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
}

function sameLocation(a: RouteLocation, b: RouteLocation): boolean {
  return a.pathname === b.pathname && a.search === b.search && a.hash === b.hash
}

function emit(location: RouteLocation, transition: boolean) {
  const event: NavigationEvent = { location, transition }
  for (const listener of listeners) listener(event)
}

function ensurePopstate() {
  if (popstateInstalled || typeof window === 'undefined') return
  popstateInstalled = true
  window.addEventListener('popstate', () => {
    emit(readLocation(), true)
  })
}

function subscribe(listener: Listener): () => void {
  ensurePopstate()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Navigate within the SPA when `to` is same-origin http(s), otherwise delegate to browser navigation. */
export function navigate(to: string, options: { replace?: boolean; transition?: boolean } = {}) {
  if (typeof window === 'undefined') return
  let url: URL
  try {
    url = new URL(to, window.location.href)
  } catch {
    window.location.assign(to)
    return
  }
  if (url.origin !== window.location.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    window.location.assign(to)
    return
  }
  const next: RouteLocation = { pathname: url.pathname, search: url.search, hash: url.hash }
  const current = readLocation()
  if (sameLocation(current, next)) return

  const relative = `${url.pathname}${url.search}${url.hash}`
  if (options.replace) window.history.replaceState(null, '', relative)
  else window.history.pushState(null, '', relative)
  emit(next, options.transition ?? true)
}

/** Synchronize query/hash URL state without pushing a history entry or running a page transition. */
export function replaceUrl(to: string) {
  navigate(to, { replace: true, transition: false })
}

/** Subscribe to SPA location changes with React concurrent transition support. */
export function useLocation(): RouteLocation {
  const [location, setLocation] = useState<RouteLocation>(readLocation)
  useEffect(
    () =>
      subscribe(({ location: next, transition }) => {
        if (transition) startTransition(() => setLocation(next))
        else setLocation(next)
      }),
    [],
  )
  return location
}

/** Subscribe to SPA location changes and expose whether a lazy route transition is currently pending. */
export function useRouteTransition(): { location: RouteLocation; isPending: boolean } {
  const [location, setLocation] = useState<RouteLocation>(readLocation)
  const [isPending, startRouteTransition] = useTransition()
  useEffect(
    () =>
      subscribe(({ location: next, transition }) => {
        if (transition) startRouteTransition(() => setLocation(next))
        else setLocation(next)
      }),
    [],
  )
  return { location, isPending }
}
