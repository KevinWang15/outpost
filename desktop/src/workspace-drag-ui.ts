import type { WorkspaceBridge } from './workspace-api'
import type { WorkspaceItem } from './workspace-model'

/** Pointer capture keeps release/cancellation in the source window even outside
 * its tab bar. The native process resolves the destination in screen coordinates. */
export function workspaceDragging(root: HTMLElement, api: WorkspaceBridge, report: (work: Promise<unknown>) => void) {
  let gesture: {
    pointer: number
    item: WorkspaceItem
    x: number
    y: number
    started: boolean
    capture: HTMLElement
  } | null = null
  let suppressClick = false
  const finish = (cancel: boolean) => {
    const current = gesture
    gesture = null
    if (!current) return
    if (current.capture.hasPointerCapture(current.pointer)) current.capture.releasePointerCapture(current.pointer)
    if (current.started) {
      suppressClick = true
      report(api.dragEnd(cancel))
    }
  }
  root.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || !(event.target instanceof Element)) return
    // Cancellation may precede mouse release by seconds. Keep suppressing that
    // gesture's trailing click until a fresh pointer press, not a timer tick.
    suppressClick = false
    const select = event.target.closest<HTMLButtonElement>('.tab-select, .pane-select')
    const node = select?.closest<HTMLElement>('[data-tab], [data-pane]')
    if (!node || !select) return
    // Select on press without focusing the button or the separate terminal view.
    // Moving native focus now would cancel pointer capture before a drag starts.
    // The normal click activates with terminal focus after release; keyboard and
    // assistive-technology clicks continue to use that same path.
    event.preventDefault()
    gesture = {
      pointer: event.pointerId,
      item: node.dataset.pane
        ? { kind: 'pane', id: Number(node.dataset.pane) }
        : { kind: 'tab', id: Number(node.dataset.tab) },
      x: event.clientX,
      y: event.clientY,
      started: false,
      capture: select,
    }
    select.setPointerCapture(event.pointerId)
    report(
      gesture.item.kind === 'tab' ? api.activateTab(gesture.item.id, false) : api.activatePane(gesture.item.id, false),
    )
  })
  window.addEventListener('pointermove', event => {
    const current = gesture
    if (!current || current.pointer !== event.pointerId) return
    if (!current.started) {
      if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < 8) return
      current.started = true
      // Keep normal clicks targeted at the button. Once dragging starts, the
      // tab node may leave this window, so capture the stable workspace instead.
      current.capture = root
      root.setPointerCapture(event.pointerId)
      report(
        api.dragStart(current.item).catch(error => {
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
  root.addEventListener('lostpointercapture', event => {
    // Transferring capture from the button to the workspace is intentional.
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
  root.addEventListener(
    'click',
    event => {
      if (suppressClick && event.detail !== 0) {
        suppressClick = false
        event.preventDefault()
        event.stopPropagation()
      }
    },
    true,
  )
}
