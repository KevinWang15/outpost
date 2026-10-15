import { splitGap, type SplitDirection, type WorkspacePanel, type WorkspaceSnapshot } from './workspace-api'

export interface PaneBounds {
  x: number
  y: number
  width: number
  height: number
}
export function splitRatio(width: number, height: number, split: NonNullable<WorkspaceSnapshot['split']>) {
  const extent = Math.max(1, (split.direction === 'columns' ? width : height) - splitGap)
  const minimum = Math.min(0.5, Math.max(0.2, (split.direction === 'columns' ? 240 : 160) / extent))
  return Math.max(minimum, Math.min(1 - minimum, split.ratio))
}
/** Shared by native views and local error panels / the draggable divider. */
export function paneLayout(
  width: number,
  height: number,
  split: WorkspaceSnapshot['split'],
): { panes: PaneBounds[]; divider: PaneBounds | null } {
  const whole = { x: 0, y: 0, width, height }
  if (!split) return { panes: [whole], divider: null }
  const columns = split.direction === 'columns'
  const extent = Math.max(0, (columns ? width : height) - splitGap)
  const first = Math.floor(extent * splitRatio(width, height, split))
  return columns
    ? {
        panes: [
          { ...whole, width: first },
          { ...whole, x: first + splitGap, width: extent - first },
        ],
        divider: { ...whole, x: first, width: splitGap },
      }
    : {
        panes: [
          { ...whole, height: first },
          { ...whole, y: first + splitGap, height: extent - first },
        ],
        divider: { ...whole, y: first, height: splitGap },
      }
}

/** Session order and presentation only. A layout change never recreates a terminal. */
export class TabLayout {
  ids: number[] = []
  active: number | null = null
  split: WorkspaceSnapshot['split'] = null
  panel: WorkspacePanel = 'sessions'

  snapshot(): TabLayoutState {
    return structuredClone({ ids: this.ids, active: this.active, split: this.split, panel: this.panel })
  }
  restore(state: TabLayoutState) {
    Object.assign(this, structuredClone(state))
  }

  add(id: number) {
    this.ids.push(id)
    this.activate(id)
  }
  activate(id: number) {
    if (!this.ids.includes(id)) return
    if (!this.split?.ids.includes(id)) this.split = null
    this.active = id
    this.panel = null
  }
  remove(id: number) {
    const index = this.ids.indexOf(id)
    if (index < 0) return
    const other = this.split?.ids.find(value => value !== id)
    if (this.split?.ids.includes(id)) this.split = null
    this.ids.splice(index, 1)
    if (this.active === id) this.active = other ?? this.ids[Math.min(index, this.ids.length - 1)] ?? null
    if (this.active === null) this.panel = 'sessions'
    if (typeof this.panel === 'object' && this.panel?.rename === id) this.panel = null
  }
  move(id: number, before: number | null) {
    if (id === before || !this.ids.includes(id) || (before !== null && !this.ids.includes(before))) return
    this.ids.splice(this.ids.indexOf(id), 1)
    this.ids.splice(before === null ? this.ids.length : this.ids.indexOf(before), 0, id)
  }
  cycle(delta: number) {
    if (!this.ids.length) return
    const index = this.active === null ? 0 : this.ids.indexOf(this.active)
    this.activate(this.ids[(index + delta + this.ids.length) % this.ids.length])
  }
  pair(id: number) {
    if (this.active === null || this.active === id || !this.ids.includes(id)) return
    this.split = { ids: [this.active, id], direction: 'columns', ratio: 0.5 }
    this.panel = null
  }
  direction(direction: SplitDirection | null) {
    if (direction === null) this.split = null
    else if (this.split) this.split.direction = direction
    else {
      const next = this.ids.find(id => id !== this.active)
      if (next !== undefined) {
        this.pair(next)
        this.split!.direction = direction
      }
    }
  }
  visible(): number[] {
    if (this.panel !== null || this.active === null) return []
    return this.split?.ids ?? [this.active]
  }
}

export type TabLayoutState = Pick<TabLayout, 'ids' | 'active' | 'split' | 'panel'>
