import type { TerminalTab } from './terminals'
import type { WorkspaceWindow } from './workspace-window'

/** A provisional move uses the actual terminal view and ownership path. Keeping
 * both layouts lets hover cancellation restore selection, split panes and panels. */
export function transferTab(
  tab: TerminalTab,
  source: WorkspaceWindow,
  target: WorkspaceWindow,
  before: number | null,
  own: (window: WorkspaceWindow) => void,
) {
  const sourceLayout = source.captureLayout(),
    targetLayout = target.captureLayout()
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    target.release(tab.id)
    own(source)
    if (!tab.view.webContents.isDestroyed()) source.add(tab)
    source.restoreLayout(sourceLayout)
    target.restoreLayout(targetLayout)
  }
  try {
    source.release(tab.id)
    own(target)
    target.add(tab, before)
  } catch (error) {
    restore()
    throw error
  }
  return { restore }
}
