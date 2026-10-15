import {
  statusBarHeight,
  tabBarHeight,
  type WorkspaceBridge,
  type WorkspacePanel,
  type WorkspaceSnapshot,
  type TabSummary,
} from './workspace-api'
import { paneLayout, type PaneBounds } from './layout'

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
document.documentElement.style.setProperty('--status-bar-height', `${statusBarHeight}px`)
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
    el('message').textContent = error instanceof Error ? error.message : 'Could not complete this action.'
  })
}
let state: WorkspaceSnapshot | null = null
let panelKey = ''
let dragged: number | null = null
let selected = 0
let matches: TabSummary[] = []
const tabNodes = new Map<number, HTMLElement>()
const tabs = el('tabs')
const divider = el('divider')
const search = el<HTMLInputElement>('session-search')
const statusLabel = (tab: TabSummary) =>
  tab.attention
    ? 'Bell'
    : { connected: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', closed: 'Disconnected' }[
        tab.connection
      ]

function tabNode(id: number) {
  const node = document.createElement('div')
  node.className = 'tab'
  node.draggable = true
  const select = button('', () => run(api.activate(id)), 'tab-select')
  select.setAttribute('role', 'tab')
  const dot = document.createElement('span')
  dot.className = 'dot'
  dot.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'tab-label'
  select.append(dot, label)
  select.ondblclick = () => run(api.panel({ rename: id }))
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
      run(api.activate(state.tabs[next].id))
    }
  }
  const close = button('×', () => run(api.close(id)), 'tab-close')
  node.append(select, close)
  node.oncontextmenu = event => {
    event.preventDefault()
    run(api.contextMenu(id))
  }
  node.onauxclick = event => {
    if (event.button === 1) {
      event.preventDefault()
      run(api.close(id))
    }
  }
  node.ondragstart = event => {
    dragged = id
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', String(id))
    }
  }
  node.ondragover = event => {
    if (dragged === null || dragged === id) return
    event.preventDefault()
    const rect = node.getBoundingClientRect()
    node.dataset.drop = event.clientX < rect.x + rect.width / 2 ? 'before' : 'after'
  }
  node.ondragleave = () => {
    delete node.dataset.drop
  }
  node.ondrop = event => {
    event.preventDefault()
    if (dragged !== null && state) {
      const index = state.tabs.findIndex(tab => tab.id === id)
      const before = node.dataset.drop === 'after' ? (state.tabs[index + 1]?.id ?? null) : id
      run(api.reorder(dragged, before))
    }
    delete node.dataset.drop
    dragged = null
  }
  node.ondragend = () => {
    dragged = null
    for (const item of tabNodes.values()) delete item.dataset.drop
  }
  return node
}
function renderTabs() {
  if (!state) return
  for (const [id, node] of tabNodes)
    if (!state.tabs.some(tab => tab.id === id)) {
      node.remove()
      tabNodes.delete(id)
    }
  state.tabs.forEach((tab, index) => {
    let node = tabNodes.get(tab.id)
    if (!node) {
      node = tabNode(tab.id)
      tabNodes.set(tab.id, node)
    }
    node.classList.toggle('selected', tab.id === state!.active)
    node.classList.toggle('visible', state!.split?.ids.includes(tab.id) ?? false)
    const select = node.querySelector<HTMLButtonElement>('.tab-select')!
    select.setAttribute('aria-selected', String(tab.id === state!.active))
    select.tabIndex = tab.id === state!.active ? 0 : -1
    select.title = `${tab.label}\n${tab.origin}\n${statusLabel(tab)}${tab.hasDraft ? ' · Unsent message' : ''}`
    node.querySelector('.tab-label')!.textContent = tab.label
    node.querySelector('.dot')!.className = `dot ${tab.attention ? 'attention' : tab.connection}`
    const close = node.querySelector<HTMLButtonElement>('.tab-close')!
    close.classList.toggle('draft', tab.hasDraft)
    close.textContent = tab.hasDraft ? '•' : '×'
    close.setAttribute('aria-label', `Close ${tab.label}${tab.hasDraft ? ' (unsent message)' : ''}`)
    close.title = tab.hasDraft ? 'Close tab (unsent message)' : 'Close tab'
    if (tabs.children[index] !== node) tabs.insertBefore(node, tabs.children[index] ?? null)
  })
}
function renderServers() {
  const list = el('servers')
  list.replaceChildren()
  for (const origin of state!.servers) {
    const row = document.createElement('li')
    const open = button(
      origin + ' ↗',
      () => {
        el<HTMLInputElement>('server').value = origin
        el<HTMLFormElement>('server-form').requestSubmit()
      },
      'row-main',
    )
    const forget = button('Forget', () => run(api.forgetServer(origin)))
    forget.setAttribute('aria-label', `Forget ${origin} and close its tabs`)
    row.append(open, forget)
    list.append(row)
  }
  el('no-servers').hidden = state!.servers.length > 0
}
function renderMatches() {
  const query = search.value.trim().toLocaleLowerCase()
  matches = (state?.tabs ?? []).filter(tab =>
    `${tab.label} ${tab.title} ${tab.origin}`.toLocaleLowerCase().includes(query),
  )
  selected = Math.max(0, Math.min(selected, matches.length - 1))
  const list = el('session-list')
  list.replaceChildren()
  matches.forEach((tab, index) => {
    const row = document.createElement('li')
    row.classList.toggle('highlighted', index === selected)
    const open = button('', () => run(api.activate(tab.id)), 'row-main')
    const title = document.createElement('strong')
    title.textContent = `${tab.attention ? '● ' : ''}${tab.label}`
    const subtitle = document.createElement('small')
    subtitle.textContent = `${tab.origin} · ${statusLabel(tab)}`
    open.append(title, subtitle)
    const pair = button('◫', () => run(api.pair(tab.id)))
    pair.disabled = tab.id === state?.active || state?.active === null
    pair.setAttribute('aria-label', `Show ${tab.label} beside current session`)
    pair.title = 'Show beside current session'
    row.append(open, pair)
    list.append(row)
  })
  el('no-matches').hidden = matches.length > 0
}
function renderStage() {
  if (!state) return
  const area = el('stage').getBoundingClientRect()
  const visible = state.panel === null ? (state.split?.ids ?? (state.active === null ? [] : [state.active])) : []
  const columns = state.split?.direction !== 'rows'
  const geometry = paneLayout(area.width, area.height, state.split)
  const place = (node: HTMLElement, bounds: PaneBounds) =>
    Object.assign(node.style, {
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      width: `${bounds.width}px`,
      height: `${bounds.height}px`,
    })
  const placeholders = el('placeholders')
  placeholders.replaceChildren()
  visible.forEach((id, index) => {
    const tab = state!.tabs.find(tab => tab.id === id)
    if (!tab?.error) return
    const box = document.createElement('div')
    box.className = 'placeholder'
    place(box, geometry.panes[index])
    const title = document.createElement('h2')
    title.textContent = tab.label
    const message = document.createElement('p')
    message.textContent = tab.error
    const actions = document.createElement('div')
    actions.append(
      button('Reload terminal', () => run(api.reload(id)), 'primary'),
      button('Open server ↗', () => run(api.openServer(tab.origin))),
    )
    box.append(title, message, actions)
    placeholders.append(box)
  })
  divider.hidden = visible.length !== 2
  divider.classList.toggle('row-split', !columns)
  divider.setAttribute('aria-orientation', columns ? 'vertical' : 'horizontal')
  divider.setAttribute('aria-valuemin', '20')
  divider.setAttribute('aria-valuemax', '80')
  divider.setAttribute('aria-valuenow', String(Math.round((state.split?.ratio ?? 0.5) * 100)))
  if (geometry.divider) place(divider, geometry.divider)
}
function render(next: WorkspaceSnapshot) {
  const previousActive = state?.active
  state = next
  renderTabs()
  renderServers()
  renderMatches()
  renderStage()
  if (previousActive !== next.active && next.active !== null)
    tabNodes.get(next.active)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  const panel: WorkspacePanel = next.panel ?? (next.active === null ? 'sessions' : null)
  const key = JSON.stringify(panel)
  const changedPanel = panelKey !== key
  panelKey = key
  el('panels').hidden = panel === null
  for (const name of ['sessions', 'switcher', 'settings', 'rename'])
    el(`${name}-panel`).hidden = typeof panel === 'object' ? name !== 'rename' || panel === null : panel !== name
  el('back').hidden = next.active === null
  el('split').setAttribute('aria-label', next.split ? 'Return to single pane' : 'Split side by side')
  el('split').title = next.split ? 'Return to single pane' : 'Split side by side'
  el('split').setAttribute('aria-pressed', String(Boolean(next.split)))
  const active = next.tabs.find(tab => tab.id === next.active)
  el('connection').textContent = active ? `${statusLabel(active)} · ${active.origin}` : 'Outpost'
  el('count').textContent =
    `${next.tabs.length} session${next.tabs.length === 1 ? '' : 's'}${next.split ? ' · Split view' : ''}`
  el('version').textContent = `Outpost ${next.version} · Preview`
  if (changedPanel) {
    el('message').textContent = ''
    if (panel === 'switcher') {
      search.value = ''
      selected = 0
      renderMatches()
      search.focus()
    } else if (panel === 'sessions') el('server').focus()
    else if (panel === 'settings') {
      el<HTMLInputElement>('font-size').value = String(next.preferences.fontSize)
      el<HTMLInputElement>('sound').checked = next.preferences.sound
      el('saved').textContent = ''
    } else if (panel && typeof panel === 'object') {
      const tab = next.tabs.find(tab => tab.id === panel.rename)
      const field = el<HTMLInputElement>('tab-name')
      field.value = tab?.label ?? ''
      field.focus()
      field.select()
    }
  }
}

el('home').onclick = el('new-tab').onclick = () => run(api.panel('sessions'))
el('switch').onclick = () => run(api.panel('switcher'))
el('settings').onclick = () => run(api.panel('settings'))
el('back').onclick = () => run(api.panel(null))
el('split').onclick = () => run(api.split(state?.split ? null : 'columns'))
el('updates').onclick = () => run(api.checkUpdates())
search.oninput = () => {
  selected = 0
  renderMatches()
}
search.onkeydown = event => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    selected += event.key === 'ArrowDown' ? 1 : -1
    renderMatches()
    el('session-list').children[selected]?.scrollIntoView({ block: 'nearest' })
  } else if (event.key === 'Enter' && matches[selected]) {
    event.preventDefault()
    run(api.activate(matches[selected].id))
  }
}
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state?.active !== null && state?.panel !== null) {
    event.preventDefault()
    run(api.panel(null))
  }
})
el<HTMLFormElement>('server-form').onsubmit = async event => {
  event.preventDefault()
  const submit = el('server-form').querySelector<HTMLButtonElement>('button[type=submit]')!
  submit.disabled = true
  try {
    if (await api.openServer(el<HTMLInputElement>('server').value.trim()))
      el('open-result').textContent =
        'Choose a session in your browser, then Connect → Outpost Desktop. It will appear here as a new tab.'
  } catch {
    el('open-result').textContent =
      'Could not open this server. Use HTTPS, or HTTP on localhost, and check the address.'
  } finally {
    submit.disabled = false
  }
}
el<HTMLFormElement>('preferences-form').onsubmit = event => {
  event.preventDefault()
  run(
    api
      .preferences({
        fontSize: Number(el<HTMLInputElement>('font-size').value),
        sound: el<HTMLInputElement>('sound').checked,
      })
      .then(() => {
        el('saved').textContent = 'Saved'
      }),
  )
}
el<HTMLFormElement>('rename-form').onsubmit = event => {
  event.preventDefault()
  if (state?.panel && typeof state.panel === 'object')
    run(api.rename(state.panel.rename, el<HTMLInputElement>('tab-name').value))
}
let resizing = false
let frame = 0
let ratio = 0.5
const finishResize = () => {
  resizing = false
  divider.classList.remove('dragging')
}
divider.onpointerdown = event => {
  if (event.button !== 0) return
  resizing = true
  divider.setPointerCapture(event.pointerId)
  divider.classList.add('dragging')
  event.preventDefault()
}
divider.onpointermove = event => {
  if (!resizing || !state?.split) return
  const rect = el('stage').getBoundingClientRect()
  ratio =
    state.split.direction === 'columns'
      ? (event.clientX - rect.left) / rect.width
      : (event.clientY - rect.top) / rect.height
  if (!frame)
    frame = requestAnimationFrame(() => {
      frame = 0
      run(api.ratio(ratio))
    })
}
divider.onpointerup = divider.onpointercancel = divider.onlostpointercapture = finishResize
divider.ondblclick = () => run(api.ratio(0.5))
divider.onkeydown = event => {
  if (!state?.split) return
  const delta =
    event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      ? -0.05
      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 0.05
        : 0
  if (delta || event.key === 'Home') {
    event.preventDefault()
    run(api.ratio(event.key === 'Home' ? 0.5 : state.split.ratio + delta))
  }
}
window.addEventListener('resize', renderStage)
api.onState(render)
run(
  api.state().then(value => {
    render(value)
    const mac = value.platform === 'darwin',
      modifier = mac ? '⌘' : 'Ctrl+Shift+'
    const shortcuts = [
      ['New tab / choose a session', `${modifier}T`],
      ['Switch session', `${modifier}P`],
      ['Close tab', `${modifier}W`],
      ['Next / previous tab', 'Ctrl+Tab / Ctrl+Shift+Tab'],
      ['Go to tab 1–8 / last tab', `${mac ? '⌘' : 'Alt+'}1–9`],
      ['Split side by side', `${modifier}D`],
      ['Focus other pane', `${mac ? '⌘' : 'Ctrl+'}Alt+→`],
      ['Text size', `${mac ? '⌘' : 'Ctrl+'}+ / − / 0`],
      ['Copy selection', `${modifier}C`],
      ['Paste into terminal', mac ? '⌘V or Ctrl+V' : `${modifier}V`],
      ['Reload terminal', `${modifier}R`],
    ]
    for (const [label, keys] of shortcuts) {
      const dt = document.createElement('dt')
      dt.textContent = label
      const dd = document.createElement('dd')
      dd.textContent = keys
      el('shortcuts').append(dt, dd)
    }
  }),
)
