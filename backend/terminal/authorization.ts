import type { FastifyRequest } from 'fastify'
import { AppError } from '../errors'
import type { Services } from '../services'

/** Ancillary terminal requests use the same owner/target/session scope as the socket. */
export function terminalGrant(services: Services, request: FastifyRequest) {
  const authorization = request.headers.authorization
  const grant = authorization?.startsWith('Bearer ') ? services.tokens.authorize(authorization.slice(7)) : null
  if (!grant || !services.active(grant.owner))
    throw new AppError('This terminal authorization expired. Connect again from Outpost.', 401)
  return grant
}
