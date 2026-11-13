// Webhooks: an account's subscriptions to its activity log. Each one receives
// matching events as a POST with Outpost's JSON body and the owner's headers,
// one request at a time, retried on network errors, 429 and 5xx.
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonFile } from '../../shared/node/jsonFile'
import {
  logLevels,
  reservedHeaders,
  type LogEvent,
  type Webhook,
  type WebhookDelivery,
  type WebhookInput,
  type WebhookPayload,
} from '../../shared/logs'
import type { Deployment, Owner } from '../deployment'
import { AppError } from '../errors'

interface StoredWebhook extends Omit<Webhook, 'headers'> {
  headers: { name: string; value: string }[]
}
interface Account {
  webhooks: StoredWebhook[]
  saving: Promise<void>
}
interface Job {
  webhook: StoredWebhook
  owner: Owner
  event: LogEvent
}

const maxWebhooks = 20
const queueLimit = 200
const timeoutMs = 10_000
const levelRank = (level: LogEvent['level']) => logLevels.indexOf(level)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms).unref())

/** Addresses a hosted server must not be made to call: its own network. */
function internal(address: string) {
  const v4 = address.replace(/^::ffff:/i, '')
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  const v6 = address.toLowerCase()
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff')
}

export class Webhooks {
  private accounts = new Map<string, Promise<Account>>()
  private queues = new Map<string, Job[]>()
  private running = new Set<string>()
  private closed = false
  /** Delivery problems are logged as events of their own (never sent to the webhook that failed). */
  failed: (owner: Owner, webhook: StoredWebhook, delivery: WebhookDelivery) => void = () => {}

  constructor(
    private deployment: Deployment,
    /** Waits before each retry of a failed delivery. */
    private retryMs = [2_000, 15_000, 60_000],
  ) {}

  private path(owner: Owner) {
    return join(this.deployment.workspace(owner).directory, 'webhooks.json')
  }

  private account(owner: Owner) {
    let account = this.accounts.get(owner.userId)
    if (!account) {
      account = readFile(this.path(owner), 'utf8').then(
        text => ({ webhooks: (JSON.parse(text) as { webhooks: StoredWebhook[] }).webhooks, saving: Promise.resolve() }),
        error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { webhooks: [], saving: Promise.resolve() }
          throw error
        },
      )
      account.catch(() => this.accounts.delete(owner.userId))
      this.accounts.set(owner.userId, account)
    }
    return account
  }

  private save(owner: Owner, account: Account) {
    // Saves run in order; one that failed does not block the next.
    account.saving = account.saving
      .catch(() => {})
      .then(() => writeJsonFile(this.path(owner), { version: 1, webhooks: account.webhooks }))
    return account.saving
  }

  private view = ({ headers, ...webhook }: StoredWebhook): Webhook => ({
    ...webhook,
    headers: headers.map(header => ({ name: header.name })),
  })

  async list(owner: Owner) {
    return (await this.account(owner)).webhooks.map(this.view)
  }

  /** Validate an input against the saved headers it may keep. */
  private headers(input: WebhookInput, saved: StoredWebhook['headers']) {
    const seen = new Set<string>()
    return input.headers.map(header => {
      const key = header.name.toLowerCase()
      if (reservedHeaders.includes(key)) throw new AppError(`Outpost sets ${header.name} itself.`, 400)
      if (seen.has(key)) throw new AppError(`${header.name} is listed twice.`, 400)
      seen.add(key)
      const value = header.value ?? saved.find(item => item.name.toLowerCase() === key)?.value
      if (value === undefined) throw new AppError(`Enter a value for ${header.name}.`, 400)
      return { name: header.name, value }
    })
  }

  private validateUrl(value: string) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      throw new AppError('Enter a valid http or https URL.', 400)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('Use an http or https URL.', 400)
    if (url.username || url.password) throw new AppError('Send credentials in a header instead of the URL.', 400)
    return url.href
  }

  async create(owner: Owner, input: WebhookInput) {
    const account = await this.account(owner)
    if (account.webhooks.length >= maxWebhooks) throw new AppError(`An account can have ${maxWebhooks} webhooks.`, 400)
    const webhook: StoredWebhook = {
      id: randomUUID(),
      name: input.name.trim(),
      url: this.validateUrl(input.url),
      headers: this.headers(input, []),
      kinds: input.kinds,
      level: input.level,
      enabled: input.enabled,
      createdAt: new Date().toISOString(),
      lastDelivery: null,
    }
    account.webhooks.push(webhook)
    await this.save(owner, account)
    return this.view(webhook)
  }

  private async find(owner: Owner, id: string) {
    const account = await this.account(owner)
    const webhook = account.webhooks.find(item => item.id === id)
    if (!webhook) throw new AppError('This webhook no longer exists.', 404)
    return { account, webhook }
  }

  async update(owner: Owner, id: string, input: WebhookInput) {
    const { account, webhook } = await this.find(owner, id)
    Object.assign(webhook, {
      name: input.name.trim(),
      url: this.validateUrl(input.url),
      headers: this.headers(input, webhook.headers),
      kinds: input.kinds,
      level: input.level,
      enabled: input.enabled,
    })
    await this.save(owner, account)
    return this.view(webhook)
  }

  async remove(owner: Owner, id: string) {
    const { account, webhook } = await this.find(owner, id)
    account.webhooks = account.webhooks.filter(item => item !== webhook)
    this.queues.delete(webhook.id)
    await this.save(owner, account)
  }

  /** Send one event now, without retries, and report what happened. */
  async test(owner: Owner, id: string, event: LogEvent) {
    const { account, webhook } = await this.find(owner, id)
    webhook.lastDelivery = await this.post(webhook, event)
    await this.save(owner, account)
    return webhook.lastDelivery
  }

  /** Queue the event for every enabled webhook that subscribes to it. */
  publish(owner: Owner, event: LogEvent, except: string | null = null) {
    if (this.closed) return
    void this.account(owner).then(
      account => {
        for (const webhook of account.webhooks) {
          if (!webhook.enabled || webhook.id === except) continue
          if (webhook.kinds.length && !webhook.kinds.includes(event.kind)) continue
          if (levelRank(event.level) < levelRank(webhook.level)) continue
          const queue = this.queues.get(webhook.id) ?? []
          // A receiver that is down for long loses the oldest events, not the newest.
          if (queue.length >= queueLimit) queue.shift()
          queue.push({ webhook, owner, event })
          this.queues.set(webhook.id, queue)
          void this.drain(webhook.id)
        }
      },
      () => {},
    )
  }

  private async drain(id: string) {
    if (this.running.has(id)) return
    this.running.add(id)
    try {
      for (let job = this.queues.get(id)?.shift(); job && !this.closed; job = this.queues.get(id)?.shift()) {
        let delivery = await this.post(job.webhook, job.event)
        for (const delay of this.retryMs) {
          if (
            delivery.ok ||
            this.closed ||
            (delivery.status !== null && delivery.status !== 429 && delivery.status < 500)
          )
            break
          await sleep(delay)
          delivery = await this.post(job.webhook, job.event)
        }
        const account = await this.account(job.owner)
        if (!account.webhooks.includes(job.webhook)) continue
        job.webhook.lastDelivery = delivery
        await this.save(job.owner, account).catch(() => {})
        if (!delivery.ok) this.failed(job.owner, job.webhook, delivery)
      }
    } finally {
      this.running.delete(id)
    }
  }

  /** One POST. A hosted server only calls public addresses, and connects to
   * the address it checked, so a changing DNS answer cannot redirect it. */
  private async post(webhook: StoredWebhook, event: LogEvent): Promise<WebhookDelivery> {
    const at = new Date().toISOString()
    const payload: WebhookPayload = { version: 1, webhook: { id: webhook.id, name: webhook.name }, event }
    const body = Buffer.from(JSON.stringify(payload))
    try {
      const url = new URL(webhook.url)
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const resolved = isIP(host) ? { address: host, family: isIP(host) } : await lookup(host)
      if (this.deployment.mode === 'hosted' && internal(resolved.address))
        return { at, ok: false, status: null, error: 'Webhooks on this server can only reach public addresses.' }
      const options: RequestOptions = {
        method: 'POST',
        headers: {
          ...Object.fromEntries(webhook.headers.map(header => [header.name, header.value])),
          'content-type': 'application/json',
          'content-length': body.length,
          'user-agent': 'Outpost',
        },
        timeout: timeoutMs,
        lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
      }
      const status = await new Promise<number>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
          response.on('error', reject)
        })
        request.on('timeout', () => request.destroy(new Error(`No response within ${timeoutMs / 1000} seconds.`)))
        request.on('error', reject)
        request.end(body)
      })
      // Redirects are not followed: the receiver answers at the address it was given.
      const ok = status >= 200 && status < 300
      return { at, ok, status, error: ok ? null : `The receiver answered ${status}.` }
    } catch (error) {
      return { at, ok: false, status: null, error: (error as Error).message.slice(0, 500) }
    }
  }

  close() {
    this.closed = true
    this.queues.clear()
  }
}
