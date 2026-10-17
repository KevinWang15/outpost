import type {
  TabGroup,
  WindowLayoutState,
  WorkspaceItem,
  PaneNode,
  PanePlacement,
  SplitDirection,
  WorkspacePanel,
} from './workspace-model'

export const tabBarHeight = 36
// The visible divider is 1px; reserve a forgiving native mouse target around it.
export const splitGap = 6
export const paneHeaderHeight = 28

export interface PaneBounds {
  x: number
  y: number
  width: number
  height: number
}
export interface PaneGeometry {
  id: number
  bounds: PaneBounds
  content: PaneBounds
  header: PaneBounds | null
}
export interface DividerGeometry {
  id: number
  direction: SplitDirection
  ratio: number
  bounds: PaneBounds
  container: PaneBounds
}
let sequence = 0
const identity = () => ++sequence
export const paneIds = (node: PaneNode): number[] =>
  node.kind === 'pane' ? [node.id] : [...paneIds(node.first), ...paneIds(node.second)]
function removePane(node: PaneNode, id: number): PaneNode | null {
  if (node.kind === 'pane') return node.id === id ? null : node
  const first = removePane(node.first, id),
    second = removePane(node.second, id)
  return first && second ? { ...node, first, second } : (first ?? second)
}
function replacePane(node: PaneNode, id: number, replacement: PaneNode): PaneNode {
  if (node.kind === 'pane') return node.id === id ? replacement : node
  return { ...node, first: replacePane(node.first, id, replacement), second: replacePane(node.second, id, replacement) }
}
function minimum(node: PaneNode): { width: number; height: number } {
  if (node.kind === 'pane') return { width: 180, height: 100 + paneHeaderHeight }
  const a = minimum(node.first),
    b = minimum(node.second)
  return node.direction === 'columns'
    ? { width: a.width + b.width + splitGap, height: Math.max(a.height, b.height) }
    : { width: Math.max(a.width, b.width), height: a.height + b.height + splitGap }
}

/** One geometry implementation for native terminal views, chrome, and hit testing.
 * Ratios are preferences; small windows compress proportionally without corrupting them. */
export function paneLayout(width: number, height: number, root: PaneNode | null, zoom: number | null = null) {
  const panes: PaneGeometry[] = [],
    dividers: DividerGeometry[] = []
  const headers = root?.kind === 'split'
  function visit(node: PaneNode, bounds: PaneBounds) {
    if (node.kind === 'pane') {
      const headerHeight = headers ? Math.min(paneHeaderHeight, bounds.height) : 0
      panes.push({
        id: node.id,
        bounds,
        header: headers ? { ...bounds, height: headerHeight } : null,
        content: { ...bounds, y: bounds.y + headerHeight, height: bounds.height - headerHeight },
      })
      return
    }
    const columns = node.direction === 'columns',
      axis = columns ? 'width' : 'height'
    const gap = Math.min(splitGap, bounds[axis]),
      extent = bounds[axis] - gap
    const a = minimum(node.first)[axis],
      b = minimum(node.second)[axis]
    const first = Math.round(
      extent < a + b ? (extent * a) / (a + b) : Math.max(a, Math.min(extent - b, extent * node.ratio)),
    )
    const offset = columns ? 'x' : 'y'
    dividers.push({
      id: node.id,
      direction: node.direction,
      ratio: extent ? first / extent : 0.5,
      container: bounds,
      bounds: { ...bounds, [offset]: bounds[offset] + first, [axis]: gap },
    })
    visit(node.first, { ...bounds, [axis]: first })
    visit(node.second, { ...bounds, [offset]: bounds[offset] + first + gap, [axis]: extent - first })
  }
  if (root)
    visit(zoom !== null && paneIds(root).includes(zoom) ? { kind: 'pane', id: zoom } : root, {
      x: 0,
      y: 0,
      width: Math.max(0, width),
      height: Math.max(0, height),
    })
  return { panes, dividers }
}

/** Validated at whole-layout boundaries (restore/import/transfer insertion). */
export function validateLayout(state: WindowLayoutState) {
  const tabs = new Set<number>(),
    panes = new Set<number>(),
    splits = new Set<number>()
  const unique = (id: number, ids: Set<number>, kind: string) => {
    if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw new Error(`Invalid or duplicate ${kind} ID: ${id}`)
    ids.add(id)
  }
  const visit = (node: PaneNode, members: Set<number>) => {
    if (node.kind === 'pane') {
      unique(node.id, panes, 'pane')
      members.add(node.id)
    } else {
      unique(node.id, splits, 'split')
      if (!Number.isFinite(node.ratio) || node.ratio < 0.05 || node.ratio > 0.95)
        throw new Error('Invalid split ratio.')
      visit(node.first, members)
      visit(node.second, members)
    }
  }
  for (const tab of state.tabs) {
    unique(tab.id, tabs, 'tab')
    const members = new Set<number>()
    visit(tab.root, members)
    if (!members.has(tab.activePaneId)) throw new Error(`Tab ${tab.id} must select one of its own panes.`)
  }
  if (state.activeTabId === null ? tabs.size !== 0 : !tabs.has(state.activeTabId))
    throw new Error('A nonempty window must select one of its own tabs.')
  if (state.panel && typeof state.panel === 'object' && !tabs.has(state.panel.renameTab))
    throw new Error('The renamed tab must belong to this window.')
}

/** Window → ordered tabs → pane trees. Only this model mutates membership and
 * selection; it never creates/disposes terminal processes or native views. */
export class WindowLayout {
  private items: TabGroup[] = []
  private selectedTabId: number | null = null
  panel: WorkspacePanel = 'sessions'
  get tabs(): readonly TabGroup[] {
    return this.items
  }
  get paneIds() {
    return this.items.flatMap(tab => paneIds(tab.root))
  }
  get activeTabId() {
    return this.selectedTabId
  }
  get activeTab() {
    return this.selectedTabId === null ? undefined : this.tab(this.selectedTabId)
  }
  get activePaneId() {
    return this.activeTab?.activePaneId ?? null
  }
  /** Workspace pages cover terminals without focusing the remembered pane. */
  get focusedPaneId() {
    return this.panel === null ? this.activePaneId : null
  }
  tabForPane(id: number) {
    return this.items.find(tab => paneIds(tab.root).includes(id))
  }
  tab(id: number) {
    return this.items.find(tab => tab.id === id)
  }
  snapshot(): WindowLayoutState {
    return structuredClone({ tabs: this.items, activeTabId: this.selectedTabId, panel: this.panel })
  }
  restore(state: WindowLayoutState) {
    validateLayout(state)
    const copy = structuredClone(state)
    this.items = copy.tabs
    this.selectedTabId = copy.activeTabId
    this.panel = copy.panel
  }
  addPane(id: number, placement: PanePlacement = { kind: 'tab', before: null }) {
    this.insert({ id: identity(), root: { kind: 'pane', id }, activePaneId: id, label: null, zoomed: false }, placement)
  }
  private update(tab: TabGroup, changes: Partial<TabGroup>) {
    this.items = this.items.map(item => (item.id === tab.id ? { ...item, ...changes } : item))
  }
  activatePane(id: number) {
    const tab = this.tabForPane(id)
    if (!tab) return
    this.selectedTabId = tab.id
    this.update(tab, { activePaneId: id })
    this.panel = null
  }
  activateTab(id: number) {
    const tab = this.tab(id)
    if (tab) this.activatePane(tab.activePaneId)
  }
  renameTab(id: number, label: string) {
    const tab = this.tab(id)
    if (tab) this.update(tab, { label: label.trim() || null })
  }
  toggleZoom(paneId: number) {
    const tab = this.tabForPane(paneId)
    if (tab?.root.kind === 'split') this.update(tab, { zoomed: !tab.zoomed })
  }
  removePane(id: number) {
    const tab = this.tabForPane(id)
    if (!tab) return
    const index = this.items.indexOf(tab),
      root = removePane(tab.root, id)
    if (root)
      this.update(tab, {
        root,
        activePaneId: tab.activePaneId === id ? paneIds(root)[0] : tab.activePaneId,
        zoomed: root.kind === 'split' && tab.zoomed,
      })
    else {
      this.items = this.items.filter(item => item.id !== tab.id)
      if (this.selectedTabId === tab.id)
        this.selectedTabId = this.items[Math.min(index, this.items.length - 1)]?.id ?? null
    }
    if (this.selectedTabId === null) this.panel = 'sessions'
    else if (typeof this.panel === 'object' && this.panel?.renameTab === tab.id && !root) this.panel = null
  }
  moveTab(id: number, before: number | null) {
    const tab = this.tab(id)
    if (!tab || id === before || (before !== null && !this.tab(before))) return
    this.items = this.items.filter(item => item.id !== id)
    this.items.splice(before === null ? this.items.length : this.items.findIndex(tab => tab.id === before), 0, tab)
  }
  cycleTabs(delta: number) {
    if (!this.items.length) return
    const index = this.activeTab ? this.items.indexOf(this.activeTab) : 0
    this.activateTab(this.items[(index + delta + this.items.length) % this.items.length].id)
  }
  selection(item: WorkspaceItem) {
    const tab = item.kind === 'tab' ? this.tab(item.id) : this.tabForPane(item.id)
    return !tab ? [] : item.kind === 'tab' ? paneIds(tab.root) : [item.id]
  }
  take(item: WorkspaceItem): TabGroup {
    const tab = item.kind === 'tab' ? this.tab(item.id) : this.tabForPane(item.id)
    if (!tab) throw new Error('This pane is no longer available.')
    const whole = item.kind === 'tab' || tab.root.kind === 'pane'
    const result = whole
      ? structuredClone(tab)
      : {
          id: identity(),
          root: { kind: 'pane' as const, id: item.id },
          activePaneId: item.id,
          label: null,
          zoomed: false,
        }
    for (const id of whole ? paneIds(tab.root) : [item.id]) this.removePane(id)
    return result
  }
  insert(group: TabGroup, placement: PanePlacement) {
    const tab = structuredClone(group)
    const next = this.items.slice()
    let selected = tab.id
    if (placement.kind === 'tab') {
      if (placement.before !== null && !this.tab(placement.before)) throw new Error('The destination tab has closed.')
      next.splice(placement.before === null ? next.length : next.findIndex(t => t.id === placement.before), 0, tab)
    } else {
      const target = this.tabForPane(placement.pane)
      if (!target) throw new Error('The destination pane has closed.')
      const before = placement.edge === 'left' || placement.edge === 'top'
      const leaf: PaneNode = { kind: 'pane', id: placement.pane }
      selected = target.id
      next[next.indexOf(target)] = {
        ...target,
        root: replacePane(target.root, placement.pane, {
          kind: 'split',
          id: identity(),
          ratio: 0.5,
          direction: placement.edge === 'left' || placement.edge === 'right' ? 'columns' : 'rows',
          first: before ? tab.root : leaf,
          second: before ? leaf : tab.root,
        }),
        activePaneId: tab.activePaneId,
        zoomed: false,
      }
    }
    // Reject invalid state before changing this window, even outside a transfer.
    const state = { tabs: next, activeTabId: selected, panel: null }
    validateLayout(state)
    this.items = next
    this.selectedTabId = selected
    this.panel = null
  }
  resizeSplit(id: number, ratio: number) {
    if (!Number.isFinite(ratio)) return
    function visit(node: PaneNode): PaneNode {
      if (node.kind === 'pane') return node
      return node.id === id
        ? { ...node, ratio: Math.max(0.05, Math.min(0.95, ratio)) }
        : { ...node, first: visit(node.first), second: visit(node.second) }
    }
    const tab = this.activeTab
    if (tab) this.update(tab, { root: visit(tab.root) })
  }
  visiblePaneIds(): number[] {
    const tab = this.activeTab
    return this.panel !== null || !tab ? [] : tab.zoomed ? [tab.activePaneId] : paneIds(tab.root)
  }
}
