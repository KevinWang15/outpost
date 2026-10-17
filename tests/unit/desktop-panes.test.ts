import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { paneIds, paneLayout, WindowLayout } from '../../desktop/src/layout'
import type { TabGroup, WindowLayoutState } from '../../desktop/src/workspace-model'
import { transferPanes } from '../../desktop/src/pane-transfer'
import { paneActionShortcuts, attachWorkspaceShortcuts } from '../../desktop/src/workspace-shortcuts'
import { workspaceCommand } from '../../desktop/src/workspace-commands'
import { PaneAppearance } from '../../desktop/src/pane-appearance'
type NativeContents = Parameters<typeof attachWorkspaceShortcuts>[0]
import type { WorkspaceItem, PanePlacement } from '../../desktop/src/workspace-model'

function split(layout: WindowLayout, id: number, next: number, edge: 'left' | 'right' | 'top' | 'bottom' = 'right') {
  layout.addPane(next)
  layout.insert(layout.take({ kind: 'pane', id: next }), { kind: 'pane', pane: id, edge })
}
function layout(...ids: number[]) {
  const value = new WindowLayout()
  ids.forEach(id => value.addPane(id))
  return value
}

test('pane trees retain tab identity, collapse empty parents and choose a remaining active pane', () => {
  const state = layout(101),
    tab = state.activeTab!.id
  split(state, 101, 102)
  split(state, 102, 103, 'bottom')
  assert.equal(state.tabs.length, 1)
  assert.equal(state.activeTab!.id, tab)
  assert.deepEqual(state.paneIds, [101, 102, 103])
  state.removePane(102)
  assert.equal(state.activeTab!.root.kind, 'split')
  assert.deepEqual(state.paneIds, [101, 103])
  state.removePane(101)
  assert.deepEqual(state.activeTab!.root, { kind: 'pane', id: 103 })
  assert.equal(state.activeTab!.id, tab)
  state.removePane(103)
  assert.equal(state.activePaneId, null)
  assert.deepEqual(state.tabs, [])
  assert.equal(state.panel, 'sessions')
})

test('tab activation, cycle, zoom and snapshot restoration retain each tab’s focused pane', () => {
  const state = layout(101)
  split(state, 101, 102)
  const first = state.activeTab!
  state.renameTab(first.id, 'My group')
  state.toggleZoom(first.activePaneId)
  state.addPane(103)
  const second = state.activeTab!.id
  state.cycleTabs(-1)
  assert.equal(state.activePaneId, 102)
  assert.deepEqual(state.visiblePaneIds(), [102])
  const saved = state.snapshot()
  state.activatePane(101)
  state.removePane(102)
  assert.deepEqual(paneIds(saved.tabs[0].root), [101, 102])
  state.restore(saved)
  assert.equal(state.activeTab!.label, 'My group')
  state.activateTab(second)
  state.cycleTabs(1)
  assert.equal(state.activePaneId, 102)
  state.panel = 'settings'
  assert.deepEqual(state.visiblePaneIds(), [])
})

test('nested geometry tiles the viewport without overlap, negatives or lost pixels at any size', () => {
  const state = layout(101)
  for (let id = 102; id < 112; id++) split(state, id - 1, id, id % 2 ? 'bottom' : 'right')
  const root = state.activeTab!.root
  for (const [width, height] of [
    [0, 0],
    [1, 1],
    [23, 15],
    [640, 384],
    [1281, 801],
    [4000, 3000],
  ]) {
    const geometry = paneLayout(width, height, root)
    const rectangles = [...geometry.panes.map(pane => pane.bounds), ...geometry.dividers.map(divider => divider.bounds)]
    assert.equal(
      rectangles.reduce((sum, b) => sum + b.width * b.height, 0),
      width * height,
    )
    for (const b of rectangles) {
      for (const value of Object.values(b)) assert.ok(Number.isInteger(value) && value >= 0)
      assert.ok(b.x + b.width <= width && b.y + b.height <= height)
      for (const other of rectangles)
        if (b !== other) {
          const overlapWidth = Math.max(0, Math.min(b.x + b.width, other.x + other.width) - Math.max(b.x, other.x))
          const overlapHeight = Math.max(0, Math.min(b.y + b.height, other.y + other.height) - Math.max(b.y, other.y))
          assert.equal(overlapWidth * overlapHeight, 0)
        }
    }
    for (const pane of geometry.panes)
      assert.equal(pane.content.height + (pane.header?.height ?? 0), pane.bounds.height)
  }
  const zoom = paneLayout(1000, 600, root, 105)
  assert.equal(zoom.dividers.length, 0)
  assert.deepEqual(
    zoom.panes.map(pane => pane.id),
    [105],
  )
  assert.equal(zoom.panes[0].bounds.width, 1000)
})

test('divider resize changes only its own split and small windows do not overwrite saved ratios', () => {
  const state = layout(101)
  split(state, 101, 102)
  split(state, 102, 103, 'bottom')
  const root = state.activeTab!.root
  assert.equal(root.kind, 'split')
  if (root.kind !== 'split' || root.second.kind !== 'split') throw Error('Expected nested splits')
  state.resizeSplit(root.second.id, 0.7)
  assert.equal(root.ratio, 0.5)
  const updated = state.activeTab!.root
  assert.equal(updated.kind === 'split' && updated.second.kind === 'split' && updated.second.ratio, 0.7)
  const saved = state.snapshot()
  paneLayout(50, 40, root)
  assert.deepEqual(state.snapshot(), saved)
  const normal = paneLayout(2000, 1000, updated)
  assert.equal(normal.dividers[0].bounds.width, 6)
  assert.ok(Math.abs(normal.dividers[1].ratio - 0.7) < 0.001)
})

class TransferWindow {
  layout = new WindowLayout()
  views = new Set<number>()
  attaches = 0
  failOnce: number | null = null
  constructor(
    private live: Set<number>,
    ids: number[],
  ) {
    for (const id of ids) {
      live.add(id)
      this.views.add(id)
      this.layout.addPane(id)
    }
  }
  captureLayout() {
    return this.layout.snapshot()
  }
  restoreLayout(state: WindowLayoutState) {
    this.layout.restore(state)
    for (const id of this.layout.paneIds) if (!this.live.has(id)) this.layout.removePane(id)
  }
  selection(item: WorkspaceItem) {
    return this.layout.selection(item)
  }
  extract(item: WorkspaceItem) {
    return this.layout.take(item)
  }
  insert(group: TabGroup, placement: PanePlacement) {
    this.layout.insert(group, placement)
  }
  attach(id: number) {
    this.attaches++
    if (this.failOnce === id) {
      this.failOnce = null
      throw Error('Native attachment failed')
    }
    if (!this.live.has(id)) return false
    this.views.add(id)
    return true
  }
  detach(id: number) {
    this.views.delete(id)
  }
  groupForPane(id: number) {
    return this.layout.tabForPane(id)?.id
  }
  render() {}
}
function windows() {
  const live = new Set<number>(),
    source = new TransferWindow(live, [101, 102]),
    target = new TransferWindow(live, [103])
  source.layout.insert(source.layout.take({ kind: 'pane', id: 102 }), { kind: 'pane', pane: 101, edge: 'right' })
  const owners = new Map([
    [101, source],
    [102, source],
    [103, target],
  ])
  const own = (id: number, window: TransferWindow) => {
    owners.set(id, window)
  }
  return { live, source, target, owners, own }
}

test('cross-window transfer and cancellation preserve trees, panels, active pane, names and native ownership', () => {
  const { source, target, owners, own } = windows()
  source.layout.renameTab(source.layout.activeTabId!, 'Keep this')
  source.layout.toggleZoom(source.layout.activePaneId!)
  target.layout.panel = 'settings'
  const a = source.captureLayout(),
    b = target.captureLayout()
  const move = transferPanes(
    { kind: 'pane', id: 102 },
    source,
    target,
    { kind: 'pane', pane: 103, edge: 'bottom' },
    own,
  )
  assert.deepEqual(source.layout.paneIds, [101])
  assert.deepEqual(target.layout.paneIds, [103, 102])
  assert.equal(owners.get(102), target)
  assert.equal(target.layout.activePaneId, 102)
  assert.equal(source.views.has(102), false)
  assert.equal(target.views.has(102), true)
  move.restore()
  assert.deepEqual(source.captureLayout(), a)
  assert.deepEqual(target.captureLayout(), b)
  assert.equal(owners.get(102), source)
  const attaches = source.attaches
  move.restore()
  assert.equal(source.attaches, attaches)
})

test('moving a whole tab preserves all views and rolls back a partially failed native attachment', () => {
  const { source, target, owners, own } = windows()
  const a = source.captureLayout(),
    b = target.captureLayout()
  const item: WorkspaceItem = { kind: 'tab', id: source.layout.activeTab!.id }
  target.failOnce = 102
  assert.throws(() => transferPanes(item, source, target, { kind: 'tab', before: null }, own), /attachment failed/)
  assert.deepEqual(source.captureLayout(), a)
  assert.deepEqual(target.captureLayout(), b)
  assert.deepEqual([...source.views], [101, 102])
  assert.deepEqual([...target.views], [103])
  assert.equal(owners.get(101), source)
  assert.equal(owners.get(102), source)
  transferPanes(item, source, target, { kind: 'tab', before: null }, own)
  assert.deepEqual(source.layout.tabs, [])
  assert.deepEqual(target.layout.tabs.at(-1), a.tabs[0])
})

test('same-window pane reorganization, tab extraction and self-anchor reorder never reparent a native view', () => {
  const { source, own } = windows()
  const id = source.layout.activeTab!.id
  transferPanes({ kind: 'pane', id: 102 }, source, source, { kind: 'pane', pane: 101, edge: 'left' }, own)
  assert.deepEqual(source.layout.paneIds, [102, 101])
  assert.equal(source.layout.activeTab!.id, id)
  transferPanes({ kind: 'pane', id: 102 }, source, source, { kind: 'tab', before: id }, own)
  assert.equal(source.layout.tabs.length, 2)
  const before = source.captureLayout()
  transferPanes({ kind: 'tab', id }, source, source, { kind: 'tab', before: id }, own)
  assert.deepEqual(source.layout.tabs, before.tabs)
  assert.equal(source.attaches, 0)
})

test('invalid destinations roll back and destroyed panes are pruned when cancelling a hover', () => {
  const { source, target, live, own } = windows()
  const initial = source.captureLayout()
  assert.throws(
    () => transferPanes({ kind: 'pane', id: 101 }, source, target, { kind: 'pane', pane: 999, edge: 'top' }, own),
    /closed/,
  )
  assert.deepEqual(source.captureLayout(), initial)
  assert.throws(
    () => transferPanes({ kind: 'pane', id: 101 }, source, source, { kind: 'pane', pane: 101, edge: 'top' }, own),
    /itself/,
  )
  const move = transferPanes(
    { kind: 'tab', id: source.layout.activeTab!.id },
    source,
    target,
    { kind: 'tab', before: null },
    own,
  )
  live.delete(102)
  move.restore()
  assert.deepEqual(source.layout.paneIds, [101])
  assert.deepEqual(target.layout.paneIds, [103])
})

test('pane IPC accepts only typed directions, finite ratios and explicit drag identities', () => {
  assert.deepEqual(workspaceCommand('splitPane', [101, 'rows']), { name: 'splitPane', args: [101, 'rows'] })
  assert.deepEqual(workspaceCommand('zoomPane', [101]), { name: 'zoomPane', args: [101] })
  assert.deepEqual(workspaceCommand('resizeSplit', [1, 0.7]), { name: 'resizeSplit', args: [1, 0.7] })
  assert.deepEqual(workspaceCommand('dragStart', [{ kind: 'pane', id: 101 }]).name, 'dragStart')
  for (const [name, args] of [
    ['splitPane', [null]],
    ['splitPane', [101, 'diagonal']],
    ['splitPane', ['rows']],
    ['resizeSplit', [1, Infinity]],
    ['resizeSplit', [1]],
    ['zoomPane', []],
    ['movePaneBeside', [101]],
    ['dragStart', [1]],
    ['dragStart', [{ kind: 'pane', id: 1, origin: 'remote' }]],
    ['activatePane', [-1]],
    // Ambiguous pre-refactor commands are removed, without compatibility aliases.
    ['activate', [101]],
    ['close', [101]],
    ['split', ['rows']],
    ['ratio', [1, 0.7]],
  ] as [string, unknown[]][])
    assert.throws(() => workspaceCommand(name, args))
})

test('native pane menus and help share the exact macOS and Windows split shortcuts', () => {
  const mac = paneActionShortcuts('darwin'),
    windows = paneActionShortcuts('win32')
  assert.equal(mac.splitColumns.accelerator, 'Cmd+D')
  assert.equal(mac.splitRows.accelerator, 'Cmd+Shift+D')
  assert.equal(mac.zoom.accelerator, 'Cmd+Shift+Enter')
  assert.equal(mac.close.accelerator, 'Cmd+W')
  assert.equal(windows.close.accelerator, 'Ctrl+Shift+W')
  assert.equal(windows.splitColumns.accelerator, 'Ctrl+Shift+D')
  assert.equal(windows.splitRows.accelerator, 'Ctrl+Alt+D')
  assert.deepEqual(paneActionShortcuts('linux'), windows)
  const contents = new EventEmitter(),
    cycles: number[] = []
  let dragging = false
  const paneActions: string[] = []
  attachWorkspaceShortcuts(contents as unknown as NativeContents, {
    cycle: delta => cycles.push(delta),
    pane: action => paneActions.push(action),
    cancelDrag: () => {
      const active = dragging
      dragging = false
      return active
    },
  })
  let prevented = 0
  const event = { preventDefault: () => prevented++ }
  for (const type of ['keyDown', 'keyUp'])
    contents.emit('before-input-event', event, { key: 'Tab', control: true, shift: true, type })
  contents.emit('before-input-event', event, { key: 'Tab', control: true, alt: true, type: 'keyDown' })
  assert.equal(prevented, 2)
  assert.deepEqual(cycles, [-1])
  contents.emit('before-input-event', event, { key: 'Escape', type: 'keyDown' })
  assert.equal(prevented, 2, 'Escape outside a drag belongs to the terminal')
  dragging = true
  for (const type of ['keyDown', 'keyDown', 'keyUp'])
    contents.emit('before-input-event', event, { key: 'Escape', type })
  assert.equal(dragging, false)
  assert.equal(prevented, 5, 'Cancel, repeats and release never reach the terminal')
  contents.emit('before-input-event', event, { key: 'Escape', type: 'keyDown' })
  assert.equal(prevented, 5)
  for (const type of ['keyDown', 'keyUp'])
    contents.emit('before-input-event', event, { key: 'Enter', control: true, shift: true, type })
  assert.deepEqual(paneActions, ['zoom'])
  assert.equal(prevented, 7, 'Pane accelerators bypass xterm and suppress duplicate menu dispatch')
})

const settle = () => new Promise(resolve => setImmediate(resolve))

test('macOS pane shortcuts dispatch once, preserve ordinary shell keys and ignore IME composition', () => {
  const contents = new EventEmitter(),
    actions: string[] = []
  attachWorkspaceShortcuts(
    contents as unknown as NativeContents,
    { cycle: () => {}, cancelDrag: () => false, pane: action => actions.push(action) },
    'darwin',
  )
  let prevented = 0
  const event = { preventDefault: () => prevented++ }
  for (const input of [
    { key: 'd', meta: true },
    { key: 'D', meta: true, shift: true },
    { key: 'Enter', meta: true, shift: true },
    { key: 'ArrowRight', meta: true, alt: true },
    { key: 'w', meta: true },
  ]) {
    contents.emit('before-input-event', event, { ...input, type: 'keyDown' })
    contents.emit('before-input-event', event, { ...input, type: 'keyDown', isAutoRepeat: true })
    contents.emit('before-input-event', event, { ...input, type: 'keyUp' })
  }
  assert.deepEqual(actions, ['splitColumns', 'splitRows', 'zoom', 'next', 'close'])
  assert.equal(prevented, 15)
  for (const input of [
    { key: 'd', control: true },
    { key: 'Enter', shift: true },
    { key: 'd', meta: true, isComposing: true },
  ])
    contents.emit('before-input-event', event, { ...input, type: 'keyDown' })
  assert.equal(prevented, 15)
})

class Contents extends EventEmitter {
  destroyed = false
  styles = new Map<string, string>()
  inserts = 0
  pause: Promise<void> | null = null
  isDestroyed() {
    return this.destroyed
  }
  async insertCSS(css: string) {
    const key = String(++this.inserts)
    if (this.pause) await this.pause
    this.styles.set(key, css)
    return key
  }
  async removeInsertedCSS(key: string) {
    this.styles.delete(key)
  }
}
test('inactive dimming is idempotent, click-through and serialized across rapid focus changes', async () => {
  const contents = new Contents(),
    appearance = new PaneAppearance(contents as unknown as NativeContents)
  let release!: () => void
  contents.pause = new Promise(resolve => {
    release = resolve
  })
  appearance.setDimmed(true)
  await settle()
  appearance.setDimmed(false)
  release()
  await settle()
  assert.equal(contents.styles.size, 0)
  for (let i = 0; i < 50; i++) appearance.setDimmed(true)
  await settle()
  assert.equal(contents.styles.size, 1)
  assert.equal(contents.inserts, 2)
  assert.match([...contents.styles.values()][0], /pointer-events: none/)
  assert.match([...contents.styles.values()][0], /position: fixed/)
  appearance.setDimmed(false)
  await settle()
  assert.equal(contents.styles.size, 0)
})

test('navigation supersedes an in-flight dimming operation without leaving stale styles', async () => {
  const contents = new Contents(),
    appearance = new PaneAppearance(contents as unknown as NativeContents)
  let release!: () => void
  contents.pause = new Promise(resolve => {
    release = resolve
  })
  appearance.setDimmed(true)
  await settle()
  contents.emit('did-start-navigation', {}, 'https://example.com', false, true)
  contents.emit('dom-ready')
  release()
  await settle()
  assert.equal(contents.styles.size, 1)
  assert.equal(contents.inserts, 2)
  appearance.setDimmed(false)
  contents.destroyed = true
  await settle()
  assert.equal(contents.inserts, 2)
})
