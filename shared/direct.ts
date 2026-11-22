import { desktopOrigin } from './desktopAuth'

export interface DirectEnrollment {
  origin: string
  targetId: string
  publicKey: string
  proofKey: string
}
export const directApiPath = '/api/direct/request'
export const directTerminalPath = '/api/direct/terminal'

/** Only an explicit response from the authenticated deployment delegates a request.
 * Never forward the account bearer or cookies to a machine. */
export async function directResponse(response: Response, signal?: AbortSignal) {
  if (response.status !== 200 || response.headers.get('x-outpost-direct') !== '1') return response
  const grant = (await response.json()) as { endpoint: string; ticket: string }
  if (typeof grant?.endpoint !== 'string' || typeof grant.ticket !== 'string' || grant.ticket.length > 512 * 1024)
    throw Error('Invalid direct grant.')
  return fetch(new URL(directApiPath, desktopOrigin(grant.endpoint)), {
    method: 'POST',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: grant.ticket }),
  })
}
