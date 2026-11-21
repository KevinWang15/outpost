import { randomBytes, createHash } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import { parseDesktopLoginCallback } from '../../shared/desktopAuth'
import type { DesktopLaunch } from '../../shared/desktopAuth'
import type { WebSocketRoute } from '@playwright/test'
import headless from '@xterm/headless'
import { checkpoint } from '../../shared/terminalCheckpoint'

/** Browser socket fixtures use the same initial checkpoint as the real service. */
export function restoreEmptyTerminal(socket: WebSocketRoute) {
  const params = new URL(socket.url()).searchParams
  const terminal = new headless.Terminal({
    cols: Number(params.get('cols')),
    rows: Number(params.get('rows')),
    allowProposedApi: true,
  })
  try {
    socket.send(JSON.stringify({ type: 'route-selected', route: 'relay' }))
    for (const part of checkpoint(terminal)) socket.send(JSON.stringify({ type: 'restore', checkpoint: part }))
    socket.send(JSON.stringify({ type: 'ready' }))
  } finally {
    terminal.dispose()
  }
}

/** Obtain app-owned terminal grants through the same approval/exchange API as the V3 desktop bridge. */
export async function appConnection(
  request: APIRequestContext,
  targetId: string,
  sessionId: string,
): Promise<DesktopLaunch> {
  const headers = { 'x-outpost-request': '1' },
    verifier = randomBytes(32).toString('base64url')
  const start = await request.post('/api/desktop/authorizations', {
    headers,
    data: {
      state: randomBytes(32).toString('base64url'),
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    },
  })
  const { requestId } = await start.json()
  const approval = await request.post(`/api/desktop/authorizations/${requestId}`, {
    headers,
    data: { allow: true, accountId: 'local' },
  })
  const { code } = parseDesktopLoginCallback((await approval.json()).callback)
  const login = await request.post('/api/desktop/token', { headers, data: { code, verifier } })
  const { token } = await login.json()
  return (
    await request.post(`/api/desktop/targets/${targetId}/sessions/${sessionId}/connect`, {
      headers: { ...headers, authorization: `Bearer ${token}` },
    })
  ).json()
}

/** Extract the path actually delivered to the fixture tool in bracketed paste mode. */
export function pastedImage(input: string) {
  const start = input.lastIndexOf('\x1b[200~')
  return start >= 0 && input.endsWith('\x1b[201~') ? input.slice(start + 6, -6) : ''
}
