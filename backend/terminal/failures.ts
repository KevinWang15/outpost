import type { CloseReason } from '../../shared/protocol'
import { AppError } from '../errors'

/** Preserve setup failures across both API lookup and runtime startup. A retry
 * can recover a transport failure, but cannot repair a missing dependency. */
export function terminalFailure(error: unknown): { reason: CloseReason; message: string } {
  let reason: CloseReason = 'error'
  if (error instanceof AppError) {
    if (error.statusCode === 404) reason = 'ended'
    else if (error.statusCode === 401 || error.statusCode === 403) reason = 'expired'
    else if (error.statusCode >= 400 && error.statusCode < 500 && ![408, 429].includes(error.statusCode))
      reason = 'unavailable'
  }
  return { reason, message: error instanceof Error ? error.message : 'Could not connect to the terminal.' }
}
