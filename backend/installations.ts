import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import {
  coreSoftware,
  softwareLabel,
  type Installation,
  type InstallationEvent,
  type SoftwareId,
} from '../shared/model'
import type { Owner } from './deployment'
import type { LogInput } from './logs/activity'
import { AppError } from './errors'
import type { TargetContext } from './sessions'
import type { SoftwareService } from './software'

const logLimit = 256 * 1024
interface Job {
  installation: Installation
  output: string
  omitted: boolean
  subscribers: Set<PassThrough>
  controller: AbortController
  completion: Promise<void>
}
const key = (owner: Owner, targetId: string) => JSON.stringify([owner.userId, targetId])
const sameSoftware = (a: readonly SoftwareId[], b: readonly SoftwareId[]) =>
  a.length === b.length && a.every(id => b.includes(id))
function describeSoftware(ids: readonly SoftwareId[]) {
  const visible = ids.filter(id => !(id === 'claude-agent-acp' && ids.includes('claude')))
  return visible.map(softwareLabel).join(', ')
}

/** A job belongs to the server process, not to an HTTP stream or dialog. Only
 * the latest bounded log per target is kept; software status is never cached.
 * Starting a job and removing its target share one critical section. */
export class Installations {
  private jobs = new Map<string, Job>()
  private queues = new Map<string, Promise<void>>()
  private closed = false
  constructor(
    private software: SoftwareService,
    private log: (owner: Owner, input: LogInput) => void = () => {},
  ) {}
  latest(owner: Owner, targetId: string) {
    return this.jobs.get(key(owner, targetId))?.installation ?? null
  }
  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(operation)
    const finished = result.then(
      () => {},
      () => {},
    )
    this.queues.set(id, finished)
    void finished.then(() => {
      if (this.queues.get(id) === finished) this.queues.delete(id)
    })
    return result
  }
  /** Cancel the target’s in-flight setup before releasing its workspace entry. */
  removeTarget(owner: Owner, targetId: string, remove: () => Promise<void>) {
    const id = key(owner, targetId)
    return this.serialize(id, async () => {
      const job = this.jobs.get(id)
      if (job?.installation.status === 'running') {
        job.controller.abort()
        await job.completion
      }
      await remove()
      this.jobs.delete(id)
    })
  }
  start(context: TargetContext, requested?: readonly SoftwareId[]) {
    const id = key(context.owner, context.target.id)
    const software: SoftwareId[] = requested?.length ? [...new Set(requested)] : [...coreSoftware]
    const specific = Boolean(requested?.length)
    const subject = specific ? describeSoftware(software) : null
    return this.serialize(id, async () => {
      if (this.closed) throw new AppError('Outpost is shutting down. No new installations can start.', 503)
      const target = await context.workspace.get(context.target.id)
      const running = this.jobs.get(id)?.installation
      if (running?.status === 'running') {
        if (sameSoftware(running.software, software)) return running
        throw new AppError('Another setup is already running on this machine. Wait for it to finish first.', 409)
      }
      const installation: Installation = {
        id: randomUUID(),
        software,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        error: null,
      }
      const job: Job = {
        installation,
        output: '',
        omitted: false,
        subscribers: new Set(),
        controller: new AbortController(),
        completion: Promise.resolve(),
      }
      this.jobs.set(id, job)
      const machine = { id: context.target.id, name: context.target.name }
      this.log(context.owner, {
        kind: 'machine',
        type: 'installing',
        message: subject ? `Setting up ${subject} on ${machine.name}` : `Setting up ${machine.name}`,
        machine,
      })
      const emit = (event: InstallationEvent) => {
        // A slow viewer must not accumulate unbounded output or block an installer.
        for (const stream of job.subscribers) if (!stream.write(`${JSON.stringify(event)}\n`)) stream.destroy()
      }
      const output = (text: string) => {
        job.omitted ||= job.output.length + text.length > logLimit
        job.output = (job.output + text).slice(-logLimit)
        emit({ type: 'output', text })
      }
      job.completion = Promise.resolve().then(async () => {
        try {
          await this.software.setup({ ...context, target }, output, job.controller.signal, requested)
          installation.status = 'succeeded'
          installation.exitCode = 0
        } catch (error) {
          installation.exitCode = 1
          installation.status = 'failed'
          installation.error = (error as Error).message
        } finally {
          installation.finishedAt = new Date().toISOString()
          this.log(context.owner, {
            level: installation.status === 'succeeded' ? 'info' : 'error',
            kind: 'machine',
            type: installation.status === 'succeeded' ? 'installed' : 'install-failed',
            message:
              installation.status === 'succeeded'
                ? subject
                  ? `${subject} ready on ${machine.name}`
                  : `${machine.name} is ready`
                : subject
                  ? `Could not set up ${subject} on ${machine.name}: ${installation.error}`
                  : `Could not set up ${machine.name}: ${installation.error}`,
            machine,
            details: { exitCode: installation.exitCode, error: installation.error, software: software.join(',') },
          })
          emit({ type: 'complete', installation })
          for (const stream of job.subscribers) stream.end()
          job.subscribers.clear()
        }
      })
      return installation
    })
  }
  events(owner: Owner, targetId: string, installationId: string) {
    const job = this.jobs.get(key(owner, targetId))
    if (!job || job.installation.id !== installationId)
      throw new AppError('Installation log is no longer available', 404)
    const stream = new PassThrough({ highWaterMark: 1024 * 1024 })
    const send = (event: InstallationEvent) => stream.write(`${JSON.stringify(event)}\n`)
    if (job.output) send({ type: 'output', text: `${job.omitted ? '[Earlier output omitted]\n' : ''}${job.output}` })
    send({ type: job.installation.status === 'running' ? 'status' : 'complete', installation: job.installation })
    if (job.installation.status === 'running') {
      job.subscribers.add(stream)
      stream.once('close', () => job.subscribers.delete(stream))
    } else stream.end()
    return stream
  }
  async close() {
    this.closed = true
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.all([...this.jobs.values()].map(job => job.completion))
    this.jobs.clear()
  }
}
