import { tabBarHeight } from './layout'
import { workspaceDragging } from './workspace-drag-ui'
import { createTabStatus, tabStatusLabel, updateTabStatus } from './tab-status'
import type { WorkspaceBridge, WorkspaceSnapshot, PaneSummary } from './workspace-api'
import type { WorkspacePanel } from './workspace-model'
import { paneControls } from './pane-ui'
import { reconcileElements } from './keyed-elements'
import { paneActionShortcuts, tabActionShortcuts } from './workspace-shortcuts'
import { clearScreenShortcut } from '../../shared/terminalShortcuts'
import { serverAccountsControls } from './server-accounts-ui'

declare global {
  interface Window {
    outpostWorkspace: WorkspaceBridge
  }
  interface Navigator {
    readonly windowControlsOverlay: EventTarget & { readonly visible: boolean }
  }
}
const api = window.outpostWorkspace
document.documentElement.style.setProperty('--tab-bar-height', `${tabBarHeight}px`)
const overlay = navigator.windowControlsOverlay
const titleBarGeometry = () => document.documentElement.toggleAttribute('data-window-controls-overlay', overlay.visible)
overlay.addEventListener('geometrychange', titleBarGeometry)
titleBarGeometry()
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id)! as T
const button = (text: string, action: () => void, className = 'subtle') => {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = text
  node.className = className
  node.onclick = action
  return node
}
const run = (work: Promise<unknown>) => {
  void work.catch(error => {
    const message = error instanceof Error ? error.message : 'Could not complete this action.'
    void api.reportError(message).catch(reportError => console.error(message, reportError))
  })
}
let state: WorkspaceSnapshot | null = null
let panelKey = ''
let selected = 0
let matches: PaneSummary[] = []
const tabNodes = new Map<number, HTMLElement>()
const recentNodes = new Map<string, HTMLElement>()
const sessionNodes = new Map<number, HTMLElement>()
const tabs = el('tabs')
const search = el<HTMLInputElement>('session-search')
workspaceDragging(document.body, api, run)
const renderPanes = paneControls(el('stage'), api, run)
const renderServerAccounts = serverAccountsControls(api, run)
let geometryFrame = 0
let scrollFrame = 0
const dragSpace = document.querySelector<HTMLElement>('.window-drag')!
function reportGeometry() {
  cancelAnimationFrame(geometryFrame)
  geometryFrame = requestAnimationFrame(() => {
    const viewport = tabs.getBoundingClientRect()
    const end = dragSpace.getBoundingClientRect()
    run(
      api.tabGeometry({
        left: viewport.left,
        right: end.right,
        viewportRight: viewport.right,
        tabs: [...tabs.children].map(node => {
          const bounds = node.getBoundingClientRect()
          return { id: Number((node as HTMLElement).dataset.tab), left: bounds.left, right: bounds.right }
        }),
      }),
    )
  })
}
new ResizeObserver(reportGeometry).observe(tabs)
new ResizeObserver(reportGeometry).observe(dragSpace)
tabs.addEventListener('scroll', reportGeometry)

function tabNode(id: number) {
  const node = document.createElement('div')
  node.className = 'tab'
  node.dataset.tab = String(id)
  const select = button('', () => run(api.activateTab(id)), 'tab-select')
  select.setAttribute('role', 'tab')
  const label = document.createElement('span')
  label.className = 'tab-label'
  const count = document.createElement('span')
  count.className = 'pane-count'
  select.append(createTabStatus(), label, count)
  select.ondblclick = () => run(api.panel({ renameTab: id }))
  select.onkeydown = event => {
    if (!state) return
    const index = state.tabs.findIndex(tab => tab.id === id)
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % state.tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + state.tabs.length) % state.tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? state.tabs.length - 1
              : -1
    if (next >= 0) {
      event.preventDefault()
      run(api.activateTab(state.tabs[next].id))
    }
  }
  const close = button('×', () => run(api.closeTab(id)), 'tab-close')
  node.append(select, close)
  node.oncontextmenu = event => {
    event.preventDefault()
    run(api.tabMenu(id))
  }
  node.onauxclick = event => {
    if (event.button === 1) {
      event.preventDefault()
      run(api.closeTab(id))
    }
  }
  return node
}
function renderTabs(panel: WorkspacePanel) {
  if (!state) return
  reconcileElements(
    tabs,
    tabNodes,
    state.tabs,
    tab => tab.id,
    tab => tabNode(tab.id),
    (node, tab) => {
      // The active terminal is remembered while a workspace page covers it.
      const selected = panel === null && tab.id === state!.activeTabId
      node.classList.toggle('selected', selected)
      const select = node.querySelector<HTMLButtonElement>('.tab-select')!
      select.setAttribute('aria-selected', String(selected))
      select.tabIndex = tab.id === state!.activeTabId ? 0 : -1
      const description = `${tabStatusLabel(tab.status)}${tab.hasDraft ? ' · Unsent message' : ''}`
      const paneDescriptions = tab.panes.flatMap(id => {
        const pane = state!.panes.find(pane => pane.id === id)
        return pane ? [`${pane.label}: ${tabStatusLabel(pane)}`] : []
      })
      select.title =
        tab.panes.length > 1
          ? `${tab.label} · ${tab.panes.length} panes\n${paneDescriptions.join('\n')}`
          : `${tab.label}\n${state!.panes.find(pane => pane.id === tab.activePaneId)?.origin ?? ''}\n${description}`
      select.setAttribute('aria-label', `${tab.label} · ${description}`)
      node.querySelector('.tab-label')!.textContent = tab.label
      const count = node.querySelector<HTMLElement>('.pane-count')!
      count.hidden = tab.panes.length < 2
      count.textContent = String(tab.panes.length)
      count.title = `${tab.panes.length} panes`
      updateTabStatus(node.querySelector<HTMLElement>('.tab-status')!, tab.status)
      const close = node.querySelector<HTMLButtonElement>('.tab-close')!
      close.classList.toggle('draft', tab.hasDraft)
      close.textContent = tab.hasDraft ? '•' : '×'
      close.setAttribute('aria-label', `Close ${tab.label}${tab.hasDraft ? ' (unsent message)' : ''}`)
      close.title = tab.hasDraft ? 'Close tab (unsent message)' : 'Close tab'
    },
  )
  for (const [id, node] of tabNodes) {
    node.classList.toggle('dragging', Boolean(state.drag?.source && state.drag.kind === 'tab' && state.drag.id === id))
    node.classList.toggle(
      'merging',
      Boolean(state.drag?.target && !state.drag.source && state.drag.kind === 'tab' && state.drag.id === id),
    )
    delete node.dataset.drop
  }
  const drag = state.drag
  document.documentElement.classList.toggle('workspace-dragging', Boolean(drag?.source))
  tabs.classList.toggle('drop-empty', Boolean(drag?.target && !state.tabs.length))
  if (drag?.target && drag.source) {
    const id = drag.before ?? state.tabs.at(-1)?.id
    const node = id === undefined ? undefined : tabNodes.get(id)
    if (node) node.dataset.drop = drag.before === null ? 'after' : 'before'
  }
  cancelAnimationFrame(scrollFrame)
  const scroll = () => {
    if (!state?.drag?.scroll) return
    tabs.scrollLeft += state.drag.scroll * 10
    scrollFrame = requestAnimationFrame(scroll)
  }
  if (drag?.scroll) scrollFrame = requestAnimationFrame(scroll)
  reportGeometry()
}
function renderRecents() {
  const active = document.activeElement
  const hadFocus =
    active instanceof HTMLElement && (el('recent-sessions').contains(active) || active.id === 'clear-recent')
  reconcileElements(
    el('recent-sessions'),
    recentNodes,
    state!.recentSessions,
    session => session.id,
    session => {
      const row = document.createElement('li')
      const open = button('', () => run(api.openRecent(session.id)), 'row-main')
      open.append(document.createElement('strong'), document.createElement('small'))
      const remove = button('Remove', () => run(api.removeRecent(session.id)))
      row.append(open, remove)
      return row
    },
    (row, session) => {
      const open = row.querySelector<HTMLButtonElement>('.row-main')!
      open.querySelector('strong')!.textContent = session.title
      open.querySelector('small')!.textContent = session.server
      open.title = `${session.title}\n${session.server}\nLast connected ${new Date(session.lastConnectedAt).toLocaleString()}`
      open.setAttribute('aria-label', `Connect to ${session.title} on ${session.server}`)
      row.lastElementChild!.setAttribute('aria-label', `Remove ${session.title} from recent sessions`)
    },
  )
  const empty = state!.recentSessions.length === 0
  el('no-recent').hidden = !empty
  el('recent-hint').hidden = empty
  el('clear-recent').hidden = empty
  if (hadFocus && (!active.isConnected || (empty && active.id === 'clear-recent')))
    (el('recent-sessions').querySelector<HTMLElement>('.row-main') ?? el('server')).focus()
}
function renderMatches(preserveSelection = true) {
  const query = search.value.trim().toLocaleLowerCase()
  const selectedId = preserveSelection ? matches[selected]?.id : undefined
  matches = (state?.panes ?? []).filter(pane =>
    `${pane.label} ${pane.title} ${pane.origin}`.toLocaleLowerCase().includes(query),
  )
  const retained = matches.findIndex(pane => pane.id === selectedId)
  selected = retained >= 0 ? retained : preserveSelection ? Math.max(0, Math.min(selected, matches.length - 1)) : 0
  const list = el('session-list')
  reconcileElements(
    list,
    sessionNodes,
    matches,
    pane => pane.id,
    pane => {
      const row = document.createElement('li')
      const open = button('', () => run(api.activatePane(pane.id)), 'row-main')
      const title = document.createElement('strong')
      title.className = 'session-title'
      const indicator = createTabStatus()
      const label = document.createElement('span')
      label.className = 'tab-label'
      title.append(indicator, label)
      const subtitle = document.createElement('small')
      open.append(title, subtitle)
      const pair = button('◫', () => run(api.movePaneBeside(pane.id, state!.activePaneId!)))
      pair.title = 'Show beside current session'
      row.append(open, pair)
      return row
    },
    (row, pane, index) => {
      row.classList.toggle('highlighted', index === selected)
      updateTabStatus(row.querySelector<HTMLElement>('.tab-status')!, pane)
      row.querySelector('.tab-label')!.textContent = pane.label
      row.querySelector('small')!.textContent = `${pane.origin} · ${tabStatusLabel(pane)}`
      const pair = row.lastElementChild as HTMLButtonElement
      pair.disabled = pane.id === state?.activePaneId || state?.activePaneId === null
      pair.setAttribute('aria-label', `Show ${pane.label} beside current session`)
    },
  )
  el('no-matches').hidden = matches.length > 0
}
function renderStage() {
  if (state) renderPanes(state)
}
function render(next: WorkspaceSnapshot) {
  const previousActive = state?.activeTabId
  const panel: WorkspacePanel = next.panel ?? (next.activePaneId === null ? 'sessions' : null)
  state = next
  renderTabs(panel)
  renderServerAccounts(state!.servers)
  renderRecents()
  renderMatches()
  renderStage()
  if (previousActive !== next.activeTabId && next.activeTabId !== null)
    tabNodes.get(next.activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const key = JSON.stringify(panel)
  const changedPanel = panelKey !== key
  panelKey = key
  el('panels').hidden = panel === null
  for (const name of ['sessions', 'switcher', 'settings', 'rename'])
    el(`${name}-panel`).hidden = typeof panel === 'object' ? name !== 'rename' || panel === null : panel !== name
  for (const [id, page] of [
    ['home', 'sessions'],
    ['switch', 'switcher'],
    ['settings', 'settings'],
  ]) {
    const control = el(id)
    if (panel === page) control.setAttribute('aria-current', 'page')
    else control.removeAttribute('aria-current')
  }
  el('back').hidden = next.activePaneId === null || panel === 'sessions'
  el('split').setAttribute('aria-label', 'Split with new local terminal')
  el('split').title = 'Split with new local terminal (right-click for top and bottom)'
  el<HTMLButtonElement>('split').disabled = next.panel !== null || next.activePaneId === null
  el('version').textContent = `Outpost ${next.version} · Preview`
  if (changedPanel) {
    // A provisional transfer may empty the source or cover the target's panel.
    // Keep keyboard focus and pointer capture in the source chrome until release.
    if (panel === 'switcher') {
      search.value = ''
      renderMatches(false)
      if (!next.drag) search.focus()
    } else if (panel === 'sessions') {
      if (!next.drag) (el('recent-sessions').querySelector<HTMLElement>('.row-main') ?? el('server')).focus()
    } else if (panel === 'settings') {
      const shell = el<HTMLSelectElement>('local-shell')
      shell.replaceChildren(...next.shells.map(profile => new Option(profile.name, profile.id)))
      shell.value = next.defaultShell
      el<HTMLInputElement>('font-size').value = String(next.preferences.fontSize)
      el<HTMLInputElement>('sound').checked = next.preferences.sound
      el('saved').textContent = ''
    } else if (panel && typeof panel === 'object') {
      const tab = next.tabs.find(tab => tab.id === panel.renameTab)
      const field = el<HTMLInputElement>('tab-name')
      field.value = tab?.label ?? ''
      if (!next.drag) {
        field.focus()
        field.select()
      }
    }
  }
}

el('home').onclick = () => run(api.panel('sessions'))
el('clear-recent').onclick = () => run(api.clearRecent())
el('recent-sessions').onkeydown = event => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  const buttons = [...el('recent-sessions').querySelectorAll<HTMLButtonElement>('.row-main')]
  const index = buttons.findIndex(node => node === document.activeElement)
  if (index < 0) return
  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  buttons[next]?.focus()
}
el('new-tab').onclick = el('open-local').onclick = () => run(api.newLocal())
el('new-tab').oncontextmenu = event => {
  event.preventDefault()
  run(api.shellMenu())
}
el('switch').onclick = () => run(api.panel('switcher'))
el('settings').onclick = () => run(api.panel('settings'))
el('back').onclick = () => run(api.panel(null))
el('split').onclick = () => run(api.splitPane(state!.activePaneId!, 'columns'))
el('split').oncontextmenu = event => {
  event.preventDefault()
  run(api.splitPane(state!.activePaneId!, 'rows'))
}
el('updates').onclick = () => run(api.checkUpdates())
search.oninput = () => {
  renderMatches(false)
}
search.onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    selected += event.key === 'ArrowDown' ? 1 : -1
    renderMatches()
    el('session-list').children[selected]?.scrollIntoView({ block: 'nearest' })
  } else if (event.key === 'Enter' && matches[selected]) {
    event.preventDefault()
    run(api.activatePane(matches[selected].id))
  }
}
window.addEventListener('keydown', event => {
  if (
    event.key === 'Escape' &&
    state &&
    state.activePaneId !== null &&
    state.panel !== null &&
    state.panel !== 'sessions'
  ) {
    event.preventDefault()
    run(api.panel(null))
  }
})
el<HTMLFormElement>('preferences-form').onsubmit = event => {
  event.preventDefault()
  run(
    api
      .preferences(
        {
          fontSize: Number(el<HTMLInputElement>('font-size').value),
          sound: el<HTMLInputElement>('sound').checked,
        },
        el<HTMLSelectElement>('local-shell').value,
      )
      .then(() => {
        el('saved').textContent = 'Saved'
      }),
  )
}
el<HTMLFormElement>('rename-form').onsubmit = event => {
  event.preventDefault()
  if (state?.panel && typeof state.panel === 'object')
    run(api.renameTab(state.panel.renameTab, el<HTMLInputElement>('tab-name').value))
}
window.addEventListener('resize', renderStage)
api.onState(render)
run(
  api.state().then(value => {
    render(value)
    const mac = value.platform === 'darwin',
      modifier = mac ? '⌘' : 'Ctrl+Shift+'
    const tabShortcuts = tabActionShortcuts(value.platform)
    const clearShortcut = clearScreenShortcut(mac)
    el('new-tab').title =
      `${tabShortcuts.newTab.label} (${tabShortcuts.newTab.keys}; right-click for shells or Outpost sessions)`
    el('open-local').textContent = `Open local terminal (${tabShortcuts.newTab.keys})`
    const shortcuts = [
      ['New window', mac ? '⌘Shift+N' : 'Ctrl+Shift+N'],
      ['Cancel pane or tab drag', 'Esc'],
      [tabShortcuts.newTab.label, tabShortcuts.newTab.keys],
      ['Switch session', `${modifier}P`],
      ['Next / previous tab', 'Ctrl+Tab / Ctrl+Shift+Tab'],
      ['Go to tab 1–8 / last tab', `${mac ? '⌘' : 'Alt+'}1–9`],
      ...Object.values(paneActionShortcuts(value.platform)).map(shortcut => [shortcut.label, shortcut.keys]),
      ['Find in terminal', `${mac ? '⌘' : 'Ctrl+'}F`],
      [clearShortcut.label, clearShortcut.keys],
      ['Larger terminal text', `${mac ? '⌘' : 'Ctrl+'}= or ${mac ? '⌘' : 'Ctrl+'}+`],
      ['Smaller terminal text', `${mac ? '⌘' : 'Ctrl+'}−`],
      ['Reset terminal text size', `${mac ? '⌘' : 'Ctrl+'}0`],
      ['Copy selection', `${modifier}C`],
      ['Paste into terminal', mac ? '⌘V or Ctrl+V' : `${modifier}V`],
      ['Reload terminal', `${modifier}R`],
    ]
    for (const id of ['home-shortcuts', 'shortcuts']) {
      const list = el(id)
      list.replaceChildren()
      for (const [label, keys] of shortcuts) {
        const dt = document.createElement('dt')
        dt.textContent = label
        const dd = document.createElement('dd')
        dd.textContent = keys
        list.append(dt, dd)
      }
    }
  }),
)
