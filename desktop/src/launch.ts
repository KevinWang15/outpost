import type { DesktopLaunch } from '../../shared/desktop'
import { desktopOrigin } from '../../shared/desktop'

/** Treat OS links as untrusted input. Only the server validates the grant itself. */
export function parseLaunch(value: string): DesktopLaunch {
  const prefix = 'outpost://connect/'
  if (value.length > 32768 || !value.startsWith(prefix)) throw new Error('Invalid Outpost launch link.')
  const encoded = value.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('Invalid Outpost launch link.')
  let data: DesktopLaunch
  try {
    data = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Invalid Outpost launch link.')
  }
  if (
    !data ||
    data.v !== 2 ||
    data.terminal !== 'desktop' ||
    typeof data.server !== 'string' ||
    typeof data.sessionKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.sessionKey) ||
    typeof data.token !== 'string' ||
    data.token.length > 8192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token) ||
    typeof data.title !== 'string' ||
    data.title.length > 512
  )
    throw new Error(
      'Update Outpost Desktop and your Outpost server together, then use Connect → Outpost Desktop again.',
    )
  return {
    v: 2,
    server: desktopOrigin(data.server),
    sessionKey: data.sessionKey,
    token: data.token,
    terminal: 'desktop',
    title: data.title,
  }
}
