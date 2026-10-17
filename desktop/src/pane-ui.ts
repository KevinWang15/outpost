import { paneLayout, splitGap, type DividerGeometry, type PaneBounds } from './layout'
import { reconcileElements } from './keyed-elements'
import { createTabStatus, updateTabStatus } from './tab-status'
import type { WorkspaceBridge, WorkspaceSnapshot } from './workspace-api'

function place(node: HTMLElement, bounds: PaneBounds) {
  Object.assign(node.style, {
    left: `${bounds.x}px`,
    top: `${bounds.y}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  })
}
function button(label: string, text: string, action: () => void, className = '') {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.title = label
  node.setAttribute('aria-label', label)
  node.textContent = text
  node.onclick = action
  return node
}

/** Workspace chrome occupies the headers/gaps left by native terminal views.
 * It owns pointer capture even when a dragged terminal leaves this window. */
export function paneControls(stage: HTMLElement, api: WorkspaceBridge, run: (work: Promise<unknown>) => void) {
  const headers = stage.querySelector<HTMLElement>('#pane-headers')!
  const dividers = stage.querySelector<HTMLElement>('#dividers')!
  const placeholders = stage.querySelector<HTMLElement>('#placeholders')!
  const headerNodes = new Map<number, HTMLElement>(),
    dividerNodes = new Map<number, HTMLElement>(),
    errorNodes = new Map<number, HTMLElement>()
  let geometry = paneLayout(0, 0, null)
  function dividerNode(id: number) {
    const node = document.createElement('div')
    node.className = 'pane-divider'
    node.dataset.divider = String(id)
    node.tabIndex = 0
    node.setAttribute('role', 'separator')
    node.setAttribute('aria-label', 'Resize terminal panes')
    let resizing = false,
      frame = 0,
      pending: number | null = null
    const flush = () => {
      cancelAnimationFrame(frame)
      frame = 0
      if (pending !== null) {
        run(api.resizeSplit(id, pending))
        pending = null
      }
    }
    const end = () => {
      resizing = false
      node.classList.remove('dragging')
      flush()
    }
    const divider = () => geometry.dividers.find(divider => divider.id === id)
    node.onpointerdown = event => {
      if (event.button !== 0) return
      event.preventDefault()
      resizing = true
      node.setPointerCapture(event.pointerId)
      node.classList.add('dragging')
    }
    node.onpointermove = event => {
      const current = divider()
      if (!resizing || !current) return
      const rect = stage.getBoundingClientRect(),
        b = current.container
      const columns = current.direction === 'columns'
      const gap = columns ? current.bounds.width : current.bounds.height
      pending = columns
        ? (event.clientX - rect.left - b.x - gap / 2) / Math.max(1, b.width - gap)
        : (event.clientY - rect.top - b.y - gap / 2) / Math.max(1, b.height - gap)
      if (!frame) frame = requestAnimationFrame(flush)
    }
    node.onpointerup = node.onpointercancel = node.onlostpointercapture = end
    node.ondblclick = () => run(api.resizeSplit(id, 0.5))
    node.onkeydown = event => {
      const current = divider()
      if (!current) return
      const delta =
        event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -0.05
          : event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? 0.05
            : 0
      if (delta || event.key === 'Home') {
        event.preventDefault()
        run(api.resizeSplit(id, event.key === 'Home' ? 0.5 : current.ratio + delta))
      }
    }
    return node
  }
  function updateDivider(node: HTMLElement, divider: DividerGeometry) {
    place(node, divider.bounds)
    node.classList.toggle('row-split', divider.direction === 'rows')
    node.setAttribute('aria-orientation', divider.direction === 'columns' ? 'vertical' : 'horizontal')
    node.setAttribute('aria-valuemin', '5')
    node.setAttribute('aria-valuemax', '95')
    node.setAttribute('aria-valuenow', String(Math.round(divider.ratio * 100)))
  }
  return (state: WorkspaceSnapshot) => {
    const area = stage.getBoundingClientRect()
    geometry = paneLayout(
      area.width,
      area.height,
      state.panel === null ? state.tree : null,
      state.zoomed ? state.activePaneId : null,
    )
    const panes = geometry.panes.flatMap(geometry => {
      const pane = state.panes.find(pane => pane.id === geometry.id)
      return pane ? [{ pane, geometry }] : []
    })
    reconcileElements(
      headers,
      headerNodes,
      panes.filter(item => item.geometry.header),
      item => item.pane.id,
      ({ pane }) => {
        const node = document.createElement('div')
        node.className = 'pane-header'
        node.dataset.pane = String(pane.id)
        // Paint through half the resize gap on either side, keeping controls
        // aligned with their terminal. The divider stays above this decoration.
        node.style.paddingInline = `${splitGap / 2}px`
        const select = button('Drag to move pane', '', () => run(api.activatePane(pane.id)), 'pane-select')
        const label = document.createElement('span')
        label.className = 'pane-label'
        select.append(createTabStatus(), label)
        select.ondblclick = () => run(api.zoomPane(pane.id))
        const zoom = button('Zoom pane', '□', () => run(api.zoomPane(pane.id)), 'pane-zoom')
        node.append(
          select,
          zoom,
          button('Pane actions', '⋯', () => run(api.paneMenu(pane.id)), 'pane-menu'),
          button('Close pane', '×', () => run(api.closePane(pane.id)), 'pane-close'),
        )
        node.oncontextmenu = event => {
          event.preventDefault()
          run(api.paneMenu(pane.id))
        }
        return node
      },
      (node, { pane, geometry }) => {
        const header = geometry.header!
        place(node, { ...header, x: header.x - splitGap / 2, width: header.width + splitGap })
        node.classList.toggle('active', pane.id === state.activePaneId)
        node.classList.toggle(
          'dragging',
          !!(state.drag?.source && state.drag.kind === 'pane' && state.drag.id === pane.id),
        )
        node.querySelector('.pane-label')!.textContent = pane.label
        const select = node.querySelector<HTMLButtonElement>('.pane-select')!
        select.title = `${pane.label} — drag to move; double-click to zoom`
        select.setAttribute('aria-label', `Focus or drag ${pane.label}`)
        select.setAttribute('aria-pressed', String(pane.id === state.activePaneId))
        updateTabStatus(node.querySelector<HTMLElement>('.tab-status')!, pane)
        const zoom = node.querySelector<HTMLButtonElement>('.pane-zoom')!
        zoom.title = state.zoomed ? 'Restore split panes' : 'Zoom pane'
        zoom.setAttribute('aria-label', zoom.title)
        zoom.textContent = state.zoomed ? '▣' : '□'
      },
    )
    reconcileElements(
      dividers,
      dividerNodes,
      geometry.dividers,
      divider => divider.id,
      divider => dividerNode(divider.id),
      updateDivider,
    )
    reconcileElements(
      placeholders,
      errorNodes,
      panes.filter(item => item.pane.error),
      item => item.pane.id,
      ({ pane }) => {
        const box = document.createElement('div')
        box.className = 'placeholder'
        box.append(
          document.createElement('h2'),
          document.createElement('p'),
          button('Reload terminal', 'Reload terminal', () => run(api.reloadPane(pane.id)), 'primary'),
          button('Close pane', 'Close pane', () => run(api.closePane(pane.id))),
        )
        return box
      },
      (box, { pane, geometry }) => {
        place(box, geometry.content)
        box.querySelector('h2')!.textContent = pane.label
        box.querySelector('p')!.textContent = pane.error
      },
    )
  }
}
