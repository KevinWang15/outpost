import { paneIds } from './layout'
import type { TabGroup } from './workspace-model'
import type { PaneSummary, TabSummary, PaneStatus } from './workspace-api'

/** A tab's badge summarizes its members; it never adopts a member's identity,
 * origin, error or connection capability. Titles follow its selected pane. */
export function summarizeTabs(tabs: readonly TabGroup[], panes: readonly PaneSummary[]): TabSummary[] {
  const byId = new Map(panes.map(pane => [pane.id, pane]))
  return tabs.map(tab => {
    const members = paneIds(tab.root).map(id => {
      const pane = byId.get(id)
      if (!pane) throw new Error(`Missing terminal pane ${id} in tab ${tab.id}.`)
      return pane
    })
    const active = byId.get(tab.activePaneId)
    if (!active || !members.includes(active)) throw new Error(`Invalid active pane in tab ${tab.id}.`)
    const representative =
      members.find(pane => pane.kind === 'remote' && pane.connection !== 'connected') ??
      members.find(pane => pane.kind === 'remote' && (pane.attention || pane.activity?.state === 'finished')) ??
      members.find(pane => pane.kind === 'remote' && pane.activity?.state === 'working') ??
      (active.kind === 'remote' ? active : members.find(pane => pane.kind === 'remote')) ??
      active
    const status: PaneStatus = {
      kind: representative.kind,
      connection: representative.connection,
      activity: representative.activity,
      attention: representative.attention,
    }
    return {
      id: tab.id,
      label: tab.label || active.label,
      activePaneId: tab.activePaneId,
      panes: members.map(pane => pane.id),
      status,
      hasDraft: members.some(pane => pane.hasDraft),
    }
  })
}
