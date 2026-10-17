import { validPreferences } from './preferences'
import type { TabGeometry, WorkspaceCommand, WorkspaceCommands } from './workspace-api'

const entityId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit
const none = (args: unknown[]) => args.length === 0
const entity = (args: unknown[]) => args.length === 1 && entityId(args[0])
const identifier = (args: unknown[]) => args.length === 1 && text(args[0], 8192)
const direction = (value: unknown) => value === 'rows' || value === 'columns'

function panel(value: unknown) {
  return (
    value === null ||
    value === 'sessions' ||
    value === 'switcher' ||
    value === 'settings' ||
    (typeof value === 'object' && Object.keys(value).length === 1 && 'renameTab' in value && entityId(value.renameTab))
  )
}

function geometry(value: unknown): value is TabGeometry {
  if (!value || typeof value !== 'object') return false
  const item = value as TabGeometry
  const coordinate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000
  return (
    [item.left, item.right, item.viewportRight].every(coordinate) &&
    item.left >= 0 &&
    item.right > item.left &&
    item.viewportRight >= item.left &&
    item.viewportRight <= item.right &&
    Array.isArray(item.tabs) &&
    item.tabs.length <= 32 &&
    item.tabs.every(
      tab => tab && entityId(tab.id) && coordinate(tab.left) && coordinate(tab.right) && tab.right >= tab.left,
    )
  )
}

/** IPC argument validation lives at one boundary. Ownership remains the window's
 * responsibility; a well-formed tab ID never grants access to another window. */
const validators: Record<keyof WorkspaceCommands, (args: unknown[]) => boolean> = {
  state: none,
  newLocal: args => args.length <= 1 && (args[0] === undefined || text(args[0], 256)),
  shellMenu: none,
  openOutpostTerminal: args => args.length <= 1 && (args[0] === undefined || text(args[0], 8192)),
  activateTab: args =>
    args.length >= 1 &&
    args.length <= 2 &&
    entityId(args[0]) &&
    (args[1] === undefined || typeof args[1] === 'boolean'),
  activatePane: args =>
    args.length >= 1 &&
    args.length <= 2 &&
    entityId(args[0]) &&
    (args[1] === undefined || typeof args[1] === 'boolean'),
  closeTab: entity,
  closePane: entity,
  paneMenu: entity,
  zoomPane: entity,
  renameTab: args =>
    args.length === 2 &&
    entityId(args[0]) &&
    text(args[1], 120) &&
    [...args[1]].every(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
  panel: args => args.length === 1 && panel(args[0]),
  movePaneBeside: args => args.length === 2 && args.every(entityId),
  splitPane: args => args.length === 2 && entityId(args[0]) && direction(args[1]),
  resizeSplit: args =>
    args.length === 2 && entityId(args[0]) && typeof args[1] === 'number' && Number.isFinite(args[1]),
  tabMenu: entity,
  reloadPane: entity,
  loginServer: identifier,
  cancelServerLogin: identifier,
  logoutServer: identifier,
  refreshServers: none,
  openRecent: identifier,
  removeRecent: identifier,
  clearRecent: none,
  preferences: args => args.length === 2 && validPreferences(args[0]) && text(args[1], 256),
  checkUpdates: none,
  reportError: args => args.length === 1 && text(args[0], 16_384),
  tabGeometry: args => args.length === 1 && geometry(args[0]),
  dragStart: args => {
    const item = args[0]
    return (
      args.length === 1 &&
      !!item &&
      typeof item === 'object' &&
      'kind' in item &&
      'id' in item &&
      Object.keys(item).length === 2 &&
      (item.kind === 'tab' || item.kind === 'pane') &&
      entityId(item.id)
    )
  },
  dragEnd: args => args.length === 1 && typeof args[0] === 'boolean',
}

export function workspaceCommand(name: unknown, args: unknown[]): WorkspaceCommand {
  if (typeof name !== 'string' || !Object.hasOwn(validators, name)) throw new Error('Unknown workspace action.')
  if (!validators[name as keyof WorkspaceCommands](args)) throw new Error(`Invalid workspace action: ${name}.`)
  return { name, args } as WorkspaceCommand
}

export const keepsWorkspaceDrag = (name: WorkspaceCommand['name']) =>
  name === 'state' || name === 'tabGeometry' || name === 'dragStart' || name === 'dragEnd'
