import { validDesktopId, type DesktopTarget } from '../../shared/desktopAuth'

/** One response contract for catalogue discovery and session creation. */
export function parseServerTargets(value: unknown): DesktopTarget[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    !value.every(
      item =>
        item &&
        validDesktopId(item.id) &&
        typeof item.name === 'string' &&
        item.name.length > 0 &&
        item.name.length <= 512,
    )
  )
    throw new Error('Invalid server target list.')
  return value.map(({ id, name }) => ({ id, name }))
}
