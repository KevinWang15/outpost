import type { Terminal } from '@xterm/xterm'

/** A vertical swipe is a wheel gesture. xterm and the application retain their normal wheel semantics. */
export function attachTouchScroll(term: Terminal) {
  const element = term.element!
  const screen = element.querySelector<HTMLElement>('.xterm-screen')!
  let gesture: { id: number; x: number; y: number; lastY: number; scrolling: boolean } | null = null
  const start = (event: TouchEvent) => {
    gesture = null
    // Own this gesture instead of also letting xterm's local viewport scroll it.
    // Do not cancel the default: taps, long presses, and pinch zoom remain available.
    event.stopPropagation()
    if (event.touches.length !== 1 || Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.01) return
    const point = event.touches[0]
    gesture = { id: point.identifier, x: point.clientX, y: point.clientY, lastY: point.clientY, scrolling: false }
  }
  const move = (event: TouchEvent) => {
    event.stopPropagation()
    if (!gesture) return
    const point = [...event.touches].find(touch => touch.identifier === gesture!.id)
    if (event.touches.length !== 1 || !point) {
      gesture = null
      return
    }
    const distance = gesture.y - point.clientY
    if (!gesture.scrolling) {
      if (Math.abs(distance) < 8) return
      if (Math.abs(point.clientX - gesture.x) > Math.abs(distance)) {
        gesture = null
        return
      }
      gesture.scrolling = true
    }
    event.preventDefault()
    const delta = Math.max(-120, Math.min(120, gesture.lastY - point.clientY))
    gesture.lastY = point.clientY
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: point.clientX,
      clientY: point.clientY,
      deltaY: delta,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    })
    // Synthetic wheels expose inconsistent legacy deltas in Chromium/WebKit.
    // Let xterm normalize the standard deltaY instead of reversing a swipe via wheelDeltaY.
    for (const key of ['wheelDelta', 'wheelDeltaX', 'wheelDeltaY'])
      Object.defineProperty(wheel, key, { value: undefined })
    screen.dispatchEvent(wheel)
  }
  const end = (event: TouchEvent) => {
    event.stopPropagation()
    if (gesture?.scrolling) {
      event.preventDefault()
    }
    gesture = null
  }
  element.addEventListener('touchstart', start, { capture: true, passive: true })
  element.addEventListener('touchmove', move, { capture: true, passive: false })
  element.addEventListener('touchend', end, { capture: true, passive: false })
  element.addEventListener('touchcancel', end, { capture: true, passive: false })
  return () => {
    element.removeEventListener('touchstart', start, true)
    element.removeEventListener('touchmove', move, true)
    element.removeEventListener('touchend', end, true)
    element.removeEventListener('touchcancel', end, true)
  }
}
