import type { FastifyReply } from 'fastify'

// Reads and cancellable uploads belong to their HTTP request. Durable mutations
// (creation, installation, termination) deliberately keep their own lifetime.
export async function withRequestSignal<T>(reply: FastifyReply, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  reply.raw.once('close', cancel)
  try {
    if (reply.raw.destroyed) controller.abort()
    return await work(controller.signal)
  } finally {
    reply.raw.off('close', cancel)
  }
}
