import assert from 'node:assert/strict'
import test from 'node:test'
import { WindowLayout, validateLayout } from '../../desktop/src/layout'
import { WorkspaceClose } from '../../desktop/src/workspace-close'
import { summarizeTabs } from '../../desktop/src/workspace-summary'
import type { CloseScope } from '../../desktop/src/workspace-model'
import type { PaneSummary } from '../../desktop/src/workspace-api'

function layout() {
  const layout = new WindowLayout()
  layout.addPane(101)
  layout.addPane(102)
  layout.insert(layout.take({ kind: 'pane', id: 102 }), { kind: 'pane', pane: 101, edge: 'right' })
  layout.addPane(103)
  layout.activatePane(102)
  return layout
}
const pane = (id: number, changes: Partial<PaneSummary> = {}): PaneSummary => ({
  id,
  kind: 'remote',
  title: `Pane ${id}`,
  label: `Pane ${id}`,
  origin: `https://server-${id}.example`,
  connection: 'connected',
  attention: false,
  activity: null,
  hasDraft: false,
  error: null,
  ...changes,
})

test('window selection and per-tab pane selection have one source of truth', () => {
  const model = layout(),
    first = model.activeTabId!,
    other = model.tabForPane(103)!.id
  assert.equal(model.activePaneId, 102)
  model.activateTab(other)
  model.activateTab(first)
  assert.equal(model.activePaneId, 102)
  model.panel = 'settings'
  assert.equal(model.focusedPaneId, null)
  assert.equal(model.activePaneId, 102, 'a workspace page remembers, but does not focus, a pane')
  model.activatePane(101)
  assert.equal(model.focusedPaneId, 101)
  model.removePane(102)
  assert.equal(model.activeTabId, first)
  model.removePane(101)
  assert.equal(model.activeTabId, other)
  assert.equal(model.activePaneId, 103)
  validateLayout(model.snapshot())
})

test('invalid layout restores/inserts reject duplicate membership and foreign selection atomically', () => {
  const model = layout(),
    original = model.snapshot()
  const foreign = { ...original, activeTabId: 99999 }
  assert.throws(() => model.restore(foreign), /select one of its own tabs/)
  const wrongPane = structuredClone(original)
  wrongPane.tabs[0] = { ...wrongPane.tabs[0], activePaneId: 103 }
  assert.throws(() => model.restore(wrongPane), /own panes/)
  assert.throws(() => model.insert(original.tabs[0], { kind: 'tab', before: null }), /duplicate/)
  assert.deepEqual(model.snapshot(), original)
  const other = new WindowLayout()
  other.addPane(101)
  const duplicatePane = { ...original.tabs[1], root: other.activeTab!.root, activePaneId: 101 }
  assert.throws(() => model.insert(duplicatePane, { kind: 'pane', pane: 103, edge: 'left' }), /duplicate pane/)
  assert.deepEqual(model.snapshot(), original)
})

test('model getters expose immutable snapshots of individual tab values across changes', () => {
  const model = layout(),
    tab = model.activeTab!
  model.renameTab(tab.id, 'Renamed')
  model.toggleZoom(tab.activePaneId)
  assert.equal(tab.label, null)
  assert.equal(tab.zoomed, false)
  assert.equal(model.activeTab!.label, 'Renamed')
  const state = model.snapshot()
  model.removePane(101)
  assert.equal(state.tabs[0].root.kind, 'split')
  assert.equal(model.activeTab!.root.kind, 'pane')
})

test('adding a split is one validated mutation and retains its destination tab identity', () => {
  const model = layout(),
    destination = model.tabForPane(103)!.id
  model.addPane(104, { kind: 'pane', pane: 103, edge: 'bottom' })
  assert.equal(model.tabs.length, 2)
  assert.equal(model.activeTabId, destination)
  assert.equal(model.activePaneId, 104)
  assert.equal(model.activeTab!.root.kind, 'split')
  const before = model.snapshot()
  assert.throws(() => model.addPane(105, { kind: 'pane', pane: 999, edge: 'left' }), /destination pane/)
  assert.throws(() => model.addPane(101, { kind: 'pane', pane: 103, edge: 'left' }), /duplicate pane/)
  assert.deepEqual(model.snapshot(), before)
})

test('tab status is an aggregate, independent of its label, selected pane and terminal identity', () => {
  const model = layout()
  model.activatePane(101)
  const panes = [
    pane(101, { kind: 'local', origin: 'This computer' }),
    pane(102, { attention: true, hasDraft: true }),
    pane(103),
  ]
  const tab = summarizeTabs(model.tabs, panes)[0]
  assert.equal(tab.id, model.tabs[0].id)
  assert.equal(tab.activePaneId, 101)
  assert.equal(tab.label, 'Pane 101')
  assert.equal(tab.hasDraft, true)
  assert.equal(tab.status.kind, 'remote')
  assert.equal(tab.status.attention, true)
  assert.equal('origin' in tab, false)
  assert.equal('error' in tab, false)
  assert.equal('connection' in tab, false)
  assert.throws(() => summarizeTabs(model.tabs, panes.slice(1)), /Missing terminal pane/)
})

function closeFixture() {
  const model = layout(),
    live = new Map([101, 102, 103].map(id => [id, pane(id)])),
    disposed: number[] = []
  let answer!: (allow: boolean) => void,
    confirmations = 0,
    settled = 0
  const resolve = (scope: CloseScope) =>
    (scope.kind === 'window' ? model.paneIds : model.selection(scope)).flatMap(id => live.get(id) ?? [])
  const close = new WorkspaceClose({
    resolve,
    confirm: async () => {
      confirmations++
      return new Promise<boolean>(resolve => {
        answer = resolve
      })
    },
    dispose: pane => {
      disposed.push(pane.id)
      live.delete(pane.id)
      model.removePane(pane.id)
    },
    settled: () => {
      settled++
    },
  })
  return {
    model,
    live,
    close,
    disposed,
    answer: (allow: boolean) => answer(allow),
    counts: () => ({ confirmations, settled }),
  }
}

test('close scopes explicitly distinguish pane, tab and window and collapse only empty containers', async () => {
  for (const kind of ['pane', 'tab', 'window'] as const) {
    const f = closeFixture()
    const request = f.close.request(
      kind === 'window' ? { kind } : { kind, id: kind === 'pane' ? 102 : f.model.activeTabId! },
    )
    f.answer(true)
    assert.equal(await request, 'closed')
    assert.deepEqual(f.disposed, kind === 'pane' ? [102] : kind === 'tab' ? [101, 102] : [101, 102, 103])
    assert.equal(f.model.tabs.length, kind === 'pane' ? 2 : kind === 'tab' ? 1 : 0)
    validateLayout(f.model.snapshot())
  }
})

test('cancelled and duplicate close requests cannot mutate or double-dispose a terminal', async () => {
  const f = closeFixture(),
    before = f.model.snapshot()
  const request = f.close.request({ kind: 'pane', id: 102 })
  assert.equal(await f.close.request({ kind: 'window' }), 'busy')
  f.answer(false)
  assert.equal(await request, 'cancelled')
  assert.deepEqual(f.model.snapshot(), before)
  assert.deepEqual(f.counts(), { confirmations: 1, settled: 1 })
  assert.equal(await f.close.request({ kind: 'pane', id: 999 }), 'empty')
  assert.deepEqual(f.disposed, [])
})

test('tab confirmation does not follow a moved pane or include a newly added pane', async () => {
  const f = closeFixture(),
    tab = f.model.activeTabId!
  const request = f.close.request({ kind: 'tab', id: tab })
  f.model.insert(f.model.take({ kind: 'pane', id: 102 }), { kind: 'tab', before: null })
  f.model.addPane(104)
  f.live.set(104, pane(104))
  f.model.insert(f.model.take({ kind: 'pane', id: 104 }), { kind: 'pane', pane: 101, edge: 'right' })
  f.answer(true)
  await request
  assert.deepEqual(f.disposed, [101])
  assert.ok(f.model.tab(tab), 'the tab survives because an unapproved pane arrived')
  assert.deepEqual(f.model.paneIds.sort(), [102, 103, 104])
})

test('window confirmation does not close arrivals or a replacement reusing a destroyed pane ID', async () => {
  const f = closeFixture(),
    request = f.close.request({ kind: 'window' })
  f.model.removePane(102) // Moved to another window.
  f.model.addPane(104)
  f.live.set(104, pane(104))
  f.live.set(103, pane(103)) // A different resource can never inherit consent.
  f.answer(true)
  await request
  assert.deepEqual(f.disposed, [101])
  assert.deepEqual(f.model.paneIds, [103, 104])
})

test('confirmation failure releases its request and allows a later close', async () => {
  const item = pane(101)
  let attempts = 0,
    closed = false
  const close = new WorkspaceClose({
    resolve: () => [item],
    confirm: async () => {
      if (!attempts++) throw Error('Dialog unavailable')
      return true
    },
    dispose: () => {
      closed = true
    },
    settled: () => {},
  })
  await assert.rejects(close.request({ kind: 'pane', id: 101 }), /unavailable/)
  assert.equal(await close.request({ kind: 'pane', id: 101 }), 'closed')
  assert.equal(closed, true)
})
