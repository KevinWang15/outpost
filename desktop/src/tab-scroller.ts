/** The viewport owns the scroll position. The overlaid control only reflects it;
 * showing the control never changes the dimensions used to measure overflow. */
export function tabScroller(viewport: HTMLElement, track: HTMLElement, thumb: HTMLElement, onPointerDone: () => void) {
  let drag: { pointer: number; grab: number } | null = null

  function metrics() {
    const width = viewport.clientWidth
    const range = Math.max(0, viewport.scrollWidth - width)
    const thumbWidth = Math.min(width, Math.max(32, (width * width) / Math.max(1, viewport.scrollWidth)))
    const travel = width - thumbWidth
    const offset = Math.max(0, Math.min(range, viewport.scrollLeft))
    return { width, range, thumbWidth, travel, offset, left: range ? (offset / range) * travel : 0 }
  }
  function finish() {
    const current = drag
    drag = null
    track.classList.remove('dragging')
    if (current && track.hasPointerCapture(current.pointer)) track.releasePointerCapture(current.pointer)
  }
  function refresh() {
    const m = metrics()
    const visible = m.width > 0 && m.range > 1
    if (!visible) {
      finish()
      // If a resize removes overflow while the scrollbar owns keyboard focus,
      // return focus to the selected tab without scrolling any ancestor.
      if (document.activeElement === track) {
        const selected = viewport.querySelector<HTMLElement>('[role="tab"][tabindex="0"]')
        if (selected) selected.focus({ preventScroll: true })
        else track.blur()
      }
    }
    track.hidden = !visible
    thumb.style.width = `${m.thumbWidth}px`
    thumb.style.transform = `translateX(${m.left}px)`
    track.setAttribute('aria-valuenow', String(m.range ? Math.round((m.offset / m.range) * 100) : 0))
    // All navigation in this strip is horizontal, including focus-driven scroll.
    if (viewport.scrollTop) viewport.scrollTop = 0
  }
  function reveal(tab: HTMLElement) {
    const bounds = tab.getBoundingClientRect()
    const view = viewport.getBoundingClientRect()
    if (!view.width || !viewport.clientWidth) return
    const scale = view.width / Math.max(1, viewport.clientWidth)
    if (bounds.width > view.width || bounds.left < view.left) viewport.scrollLeft += (bounds.left - view.left) / scale
    else if (bounds.right > view.right) viewport.scrollLeft += (bounds.right - view.right) / scale
  }
  function moveThumb(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointer) return
    const m = metrics()
    const bounds = track.getBoundingClientRect()
    if (!bounds.width || !m.travel) return
    const x = ((event.clientX - bounds.left) / bounds.width) * m.width
    const position = Math.max(0, Math.min(m.travel, x - drag.grab * m.thumbWidth))
    viewport.scrollLeft = (position / m.travel) * m.range
  }
  track.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || track.hidden) return
    const m = metrics()
    const bounds = track.getBoundingClientRect()
    if (!bounds.width || m.range <= 1) return
    event.preventDefault()
    const x = ((event.clientX - bounds.left) / bounds.width) * m.width
    drag = {
      pointer: event.pointerId,
      grab: x >= m.left && x <= m.left + m.thumbWidth ? (x - m.left) / m.thumbWidth : 0.5,
    }
    track.setPointerCapture(event.pointerId)
    track.classList.add('dragging')
    moveThumb(event)
  })
  track.addEventListener('pointermove', moveThumb)
  track.addEventListener('pointerup', event => {
    if (event.pointerId !== drag?.pointer) return
    moveThumb(event)
    finish()
    onPointerDone()
  })
  track.addEventListener('pointercancel', finish)
  track.addEventListener('lostpointercapture', finish)
  window.addEventListener('blur', finish)
  track.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const m = metrics()
    const step = viewport.clientWidth * 0.9
    const next =
      event.key === 'ArrowLeft'
        ? m.offset - 40
        : event.key === 'ArrowRight'
          ? m.offset + 40
          : event.key === 'PageUp'
            ? m.offset - step
            : event.key === 'PageDown'
              ? m.offset + step
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? m.range
                  : null
    if (next === null) return
    event.preventDefault()
    event.stopPropagation()
    viewport.scrollLeft = Math.max(0, Math.min(m.range, next))
  })
  const wheel = (event: WheelEvent) => {
    // Trackpad pinch and browser zoom must not become horizontal scroll gestures.
    if (event.ctrlKey || event.metaKey || metrics().range <= 1) return
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (!delta) return
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? parseFloat(getComputedStyle(viewport).lineHeight) || 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? viewport.clientWidth
          : 1
    event.preventDefault()
    viewport.scrollLeft += delta * unit
  }
  viewport.addEventListener('wheel', wheel, { passive: false })
  track.addEventListener('wheel', wheel, { passive: false })
  return { refresh, reveal }
}
