import { summarizeTabs } from '../../../desktop/src/workspace-summary'
import { WindowLayout, paneIds } from '../../../desktop/src/layout'
import type { PaneSummary, WorkspaceBridge, WorkspaceSnapshot } from '../../../desktop/src/workspace-api'

// DOM tests exercise the packaged chrome against the real layout model. Only
// native capabilities (PTY creation, dialogs, OS cursor) are replaced here.
const layout = new WindowLayout()
const panes = new Map<number, PaneSummary>()
const calls: { name: string; args: unknown[] }[] = []
const listeners = new Set<(state: WorkspaceSnapshot) => void>()
let sequence = 100
let drag: WorkspaceSnapshot['drag'] = null
function add() {
  const id = ++sequence
  panes.set(id, {
    id,
    label: `Session ${id}`,
    title: `Session ${id}`,
    kind: 'remote',
    origin: 'https://example.com',
    connection: 'connected',
    activity: null,
    attention: false,
    hasDraft: false,
    error: null,
  })
  layout.addPane(id)
  return id
}
function split(direction: 'columns' | 'rows') {
  const active = layout.activePaneId,
    id = add()
  if (active !== null)
    layout.insert(layout.take({ kind: 'pane', id }), {
      kind: 'pane',
      pane: active,
      edge: direction === 'columns' ? 'right' : 'bottom',
    })
}
function snapshot(): WorkspaceSnapshot {
  return structuredClone({
    version: 'test',
    platform: 'darwin',
    activePaneId: layout.activePaneId,
    activeTabId: layout.activeTab?.id ?? null,
    tree: layout.activeTab?.root ?? null,
    zoomed: layout.activeTab?.zoomed ?? false,
    panel: layout.panel,
    servers: { accounts: [], signIns: [] },
    recentSessions: [],
    preferences: { fontSize: 14, sound: false },
    shells: [{ id: 'default', name: 'Shell' }],
    defaultShell: 'default',
    drag,
    panes: layout.paneIds.map(id => panes.get(id)!),
    tabs: summarizeTabs(layout.tabs, [...panes.values()]),
  })
}
function emit() {
  for (const listener of listeners) listener(snapshot())
}
const bridge: WorkspaceBridge = {
  openOutpostTerminal: async server => {
    calls.push({ name: 'openOutpostTerminal', args: [server] })
  },
  state: async () => snapshot(),
  onState: listener => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  newLocal: async () => {
    add()
    emit()
  },
  splitPane: async (id, direction) => {
    layout.activatePane(id)
    split(direction)
    emit()
  },
  activateTab: async id => {
    layout.activateTab(id)
    emit()
  },
  activatePane: async id => {
    layout.activatePane(id)
    emit()
  },
  closeTab: async id => {
    const group = layout.tab(id)
    if (group) for (const id of paneIds(group.root)) layout.removePane(id)
    emit()
  },
  closePane: async id => {
    layout.removePane(id)
    emit()
  },
  zoomPane: async id => {
    layout.activatePane(id)
    layout.toggleZoom(id)
    emit()
  },
  resizeSplit: async (id, value) => {
    layout.resizeSplit(id, value)
    emit()
  },
  movePaneBeside: async (id, active) => {
    if (active !== null && active !== id)
      layout.insert(layout.take({ kind: 'pane', id }), { kind: 'pane', pane: active, edge: 'right' })
    emit()
  },
  renameTab: async (id, value) => {
    const group = layout.tab(id)
    if (group) layout.renameTab(id, value)
    layout.panel = null
    emit()
  },
  panel: async panel => {
    layout.panel = panel
    emit()
  },
  dragStart: async item => {
    drag = { ...item, source: true, target: false, before: null, scroll: 0 }
    emit()
  },
  dragEnd: async () => {
    drag = null
    emit()
  },
  tabGeometry: async () => {},
  shellMenu: async () => {},
  tabMenu: async () => {},
  paneMenu: async () => {},
  reloadPane: async () => {},
  openServer: async () => {},
  loginServer: async () => {},
  cancelServerLogin: async () => {},
  logoutServer: async () => {},
  refreshServers: async () => {},
  openRecent: async () => {},
  removeRecent: async () => {},
  clearRecent: async () => {},
  preferences: async () => {},
  checkUpdates: async () => {},
  reportError: async () => {},
}
add()
split('columns')
// Chromium's Linux headless build may not expose the window-controls API.
if (!('windowControlsOverlay' in navigator))
  Object.defineProperty(navigator, 'windowControlsOverlay', {
    value: Object.assign(new EventTarget(), { visible: false }),
  })
window.outpostWorkspace = new Proxy(bridge, {
  get(target, name: keyof WorkspaceBridge) {
    const fn = target[name]
    if (name === 'onState') return fn
    return (...args: unknown[]) => {
      calls.push({ name, args })
      return Reflect.apply(fn, target, args)
    }
  },
})
window.workspaceFixture = {
  calls,
  snapshot,
  update(id: number, update: Partial<PaneSummary>) {
    Object.assign(panes.get(id)!, update)
    emit()
  },
  extract(id: number) {
    layout.insert(layout.take({ kind: 'pane', id }), { kind: 'tab', before: null })
    emit()
  },
}
declare global {
  interface Window {
    outpostWorkspace: WorkspaceBridge
    workspaceFixture: {
      calls: typeof calls
      snapshot: typeof snapshot
      update(id: number, update: Partial<PaneSummary>): void
      extract(id: number): void
    }
  }
}
