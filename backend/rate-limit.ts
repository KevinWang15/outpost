import { AppError } from './errors'

/** Bounded, short-lived buckets for unauthenticated authorization endpoints. */
export class RateLimit {
  private buckets = new Map<string, { count: number; until: number }>()
  consume(key: string, limit: number) {
    const now = Date.now()
    if (this.buckets.size >= 10000) {
      for (const [name, entry] of this.buckets) if (entry.until <= now) this.buckets.delete(name)
      if (this.buckets.size >= 10000 && !this.buckets.has(key))
        throw new AppError('Too many requests. Please try again later.', 429)
    }
    const previous = this.buckets.get(key)
    const bucket = previous && previous.until > now ? previous : { count: 0, until: now + 15 * 60_000 }
    if (bucket.count >= limit) throw new AppError('Too many attempts. Please try again in 15 minutes.', 429)
    bucket.count++
    this.buckets.set(key, bucket)
  }
}
