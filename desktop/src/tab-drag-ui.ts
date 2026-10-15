import type { WorkspaceBridge } from './workspace-api'

/** Pointer capture keeps release/cancellation in the source window even outside
 * its tab bar. The native process resolves the destination in screen coordinates. */
export function tabDragging(tabs: HTMLElement, api: WorkspaceBridge, report: (work: Promise<unknown>) => void) {
  let gesture: { pointer: number; id: number; x: number; y: number; started: boolean; capture: HTMLElement } | null =
    null
  let suppressClick = false
  const finish = (cancel: boolean) => {
    const current = gesture
    gesture = null
    if (!current) return
    if (current.capture.hasPointerCapture(current.pointer)) current.capture.releasePointerCapture(current.pointer)
    if (current.started) {
      suppressClick = true
      report(api.dragEnd(cancel))
      setTimeout(() => {
        suppressClick = false
      }, 0)
    }
  }
  tabs.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return
    const select = event.target.closest<HTMLButtonElement>('.tab-select')
    const node = select?.closest<HTMLElement>('.tab')
    if (!node || !select) return
    // Select on press without focusing the button or the separate terminal view.
    // Moving native focus now would cancel pointer capture before a drag starts.
    // The normal click activates with terminal focus after release; keyboard and
    // assistive-technology clicks continue to use that same path.
    event.preventDefault()
    gesture = {
      pointer: event.pointerId,
      id: Number(node.dataset.tab),
      x: event.clientX,
      y: event.clientY,
      started: false,
      capture: select,
    }
    select.setPointerCapture(event.pointerId)
    report(api.activate(gesture.id, false))
  })
  window.addEventListener('pointermove', event => {
    const current = gesture
    if (!current || current.pointer !== event.pointerId) return
    if (!current.started) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 8) return
      current.started = true
      // Keep normal clicks targeted at the button. Once dragging starts, the
      // tab node may leave this window, so capture its stable strip instead.
      current.capture = tabs
      tabs.setPointerCapture(event.pointerId)
      report(
        api.dragStart(current.id).catch(error => {
          finish(true)
          throw error
        }),
      )
    }
  })
  window.addEventListener('pointerup', event => {
    if (gesture?.pointer === event.pointerId) finish(false)
  })
  window.addEventListener('pointercancel', () => finish(true))
  tabs.addEventListener('lostpointercapture', event => {
    // Transferring capture from the button to the strip is intentional.
    if (event.target === gesture?.capture) finish(true)
  })
  window.addEventListener('blur', () => finish(true))
  window.addEventListener(
    'keydown',
    event => {
      if (gesture && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        finish(true)
      }
    },
    true,
  )
  tabs.addEventListener(
    'click',
    event => {
      if (suppressClick) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    true,
  )
}
