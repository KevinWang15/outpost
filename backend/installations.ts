import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type { Installation, InstallationEvent, SoftwareId } from '../shared/model'
import { requiredSoftware } from '../shared/model'
import type { Owner } from './deployment'
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

/** A job belongs to the server process, not to an HTTP stream or dialog. Only
 * the latest bounded log per target is kept; software status is never cached.
 * Starting a job and removing its target share one critical section. */
export class Installations {
  private jobs = new Map<string, Job>()
  private queues = new Map<string, Promise<void>>()
  private closed = false
  constructor(private software: SoftwareService) {}
  latest(owner: Owner, targetId: string) { return this.jobs.get(key(owner, targetId))?.installation ?? null }
  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(operation)
    const finished = result.then(() => {}, () => {})
    this.queues.set(id, finished)
    void finished.then(() => { if (this.queues.get(id) === finished) this.queues.delete(id) })
    return result
  }
  /** Run a target removal unless an installation is running on it. */
  removeTarget(owner: Owner, targetId: string, remove: () => Promise<void>) {
    const id = key(owner, targetId)
    return this.serialize(id, async () => {
      if (this.jobs.get(id)?.installation.status === 'running') throw new AppError('Wait for the installation to finish before removing this target.', 409)
      await remove()
      this.jobs.delete(id)
    })
  }
  start(context: TargetContext, softwareId: SoftwareId, script: string) {
    const id = key(context.owner, context.target.id)
    return this.serialize(id, async () => {
      if (this.closed) throw new AppError('Outpost is shutting down. No new installations can start.', 503)
      const target = await context.workspace.get(context.target.id)
      if (!target.environment) throw new AppError('Check Required Software before installing.', 409)
      if (!requiredSoftware(target).includes(softwareId)) throw new AppError('Software is not required by this target', 400)
      if (this.jobs.get(id)?.installation.status === 'running') throw new AppError('An installation is already running on this target. Open its log to follow progress.', 409)
      const installation: Installation = { id: randomUUID(), softwareId, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, error: null }
      const job: Job = { installation, output: '', omitted: false, subscribers: new Set(), controller: new AbortController(), completion: Promise.resolve() }
      this.jobs.set(id, job)
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
          const code = await this.software.install(context, script, output, job.controller.signal)
          installation.exitCode = code
          installation.status = code === 0 ? 'succeeded' : 'failed'
          if (code !== 0) installation.error = `Installation exited with ${code === null ? 'a disconnected process' : `status ${code}`}.`
        } catch (error) {
          installation.status = 'failed'
          installation.error = (error as Error).message
        } finally {
          installation.finishedAt = new Date().toISOString()
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
    if (!job || job.installation.id !== installationId) throw new AppError('Installation log is no longer available', 404)
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
