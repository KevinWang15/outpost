import type { FastifyReply } from 'fastify'

// Read operations belong to their HTTP request; mutations have their own lifetime.
export async function withRequestSignal<T>(reply: FastifyReply, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  reply.raw.once('close', cancel)
  try {
    if (reply.raw.destroyed) controller.abort()
    return await read(controller.signal)
  } finally {
    reply.raw.off('close', cancel)
  }
}
