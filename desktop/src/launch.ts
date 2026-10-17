import { validDesktopId, desktopOrigin, type DesktopLaunch } from '../../shared/desktopAuth'

/** Validate server responses before giving a terminal its scoped credential. */
export function parseDesktopLaunch(value: unknown): DesktopLaunch {
  const data = value as DesktopLaunch
  if (
    !data ||
    typeof data.loginId !== 'string' ||
    !/^desktop:[A-Za-z0-9-]{36}$/.test(data.loginId) ||
    !validDesktopId(data.accountId) ||
    !validDesktopId(data.targetId) ||
    !validDesktopId(data.sessionId) ||
    typeof data.server !== 'string' ||
    !validTerminalToken(data.token) ||
    typeof data.title !== 'string' ||
    data.title.length > 512
  )
    throw new Error(
      'Update Outpost Desktop and your Outpost server together, then use Connect → Outpost Desktop again.',
    )
  return {
    server: desktopOrigin(data.server),
    loginId: data.loginId,
    accountId: data.accountId,
    targetId: data.targetId,
    sessionId: data.sessionId,
    token: data.token,
    title: data.title,
  }
}

export const validTerminalToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 8192 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
