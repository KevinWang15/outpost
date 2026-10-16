import type { TerminalTabState } from '../../shared/desktop'
import { activityLabels } from '../../shared/activity'

const connectionLabels = {
  connected: 'Connected',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
} satisfies Record<TerminalTabState['connection'], string>

export function tabStatusLabel(tab: TerminalTabState) {
  const parts = [connectionLabels[tab.connection]]
  if (tab.connection === 'connected') {
    if (tab.activity) parts.push(activityLabels[tab.activity.state])
    if (tab.activity?.detail) parts.push(tab.activity.detail)
  }
  if (tab.attention) parts.push('Bell rang — needs attention')
  return parts.join(' · ')
}

const circle = 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z'
const spinner = ['M12 2a10 10 0 1 0 10 10']
const bell = [
  'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z',
  'M10.3 21a2 2 0 0 0 3.4 0',
  'M2 8c0-2 1-4 3-5m17 5c0-2-1-4-3-5',
]
// Small outline icons keep the bundled workspace independent of a UI framework.
const icons = {
  connected: [circle, 'm8 12 3 3 5-6'],
  connecting: spinner,
  closed: [circle, 'm9 9 6 6m0-6-6 6'],
  attention: bell,
  working: spinner,
  idle: [circle, 'M12 6v6l4 2'],
  finished: bell,
  unknown: [circle, 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3m.1 4h.01'],
}

function tabStatusIcon(tab: TerminalTabState): keyof typeof icons {
  if (tab.connection !== 'connected') return tab.connection === 'reconnecting' ? 'connecting' : tab.connection
  if (tab.attention) return 'attention'
  return tab.activity === null ? 'connected' : tab.activity.state
}

export function createTabStatus() {
  const node = document.createElement('span')
  node.className = 'tab-status'
  node.setAttribute('aria-hidden', 'true')
  return node
}

export function updateTabStatus(node: HTMLElement, tab: TerminalTabState) {
  node.title = tabStatusLabel(tab)
  const kind = tabStatusIcon(tab)
  // Metadata updates must not restart a bell's animation or a connection spinner.
  if (node.dataset.state === kind) return
  node.dataset.state = kind
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  }))
    svg.setAttribute(key, value)
  for (const data of icons[kind]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', data)
    svg.append(path)
  }
  node.replaceChildren(svg)
}
