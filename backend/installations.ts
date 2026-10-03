import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import type {
  Installation,
  InstallationEvent,
  SoftwareId,
  Target,
} from '../shared/session-manager'
import { AppError } from './errors'
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
// A job belongs to the manager process, not to an HTTP stream or modal.
// Keep just the latest bounded log per target; no software status is cached.
export class Installations {
  private jobs = new Map<string, Job>()
  private closed = false
  constructor(private software: SoftwareService) {}
  latest(targetId: string) {
    return this.jobs.get(targetId)?.installation ?? null
  }
  start(target: Target, softwareId: SoftwareId, script: string) {
    if (this.closed) throw new AppError('The manager is shutting down. No new installations can start.', 503)
    if (this.latest(target.id)?.status === 'running')
      throw new AppError(
        'An installation is already running on this target. Open its log to follow progress.',
        409,
      )
    const installation: Installation = {
      id: randomUUID(),
      softwareId,
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
    this.jobs.set(target.id, job)
    const emit = (event: InstallationEvent) => {
      for (const stream of job.subscribers) {
        // A slow viewer must not accumulate unbounded output or block an installer.
        if (!stream.write(`${JSON.stringify(event)}\n`)) stream.destroy()
      }
    }
    const output = (text: string) => {
      job.omitted ||= job.output.length + text.length > logLimit
      job.output = (job.output + text).slice(-logLimit)
      emit({ type: 'output', text })
    }
    job.completion = Promise.resolve().then(async () => {
      try {
        const code = await this.software.install(
          target,
          script,
          output,
          job.controller.signal,
        )
        installation.exitCode = code
        installation.status = code === 0 ? 'succeeded' : 'failed'
        if (code !== 0)
          installation.error = `Installation exited with ${code === null ? 'a disconnected process' : `status ${code}`}.`
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
  }
  events(targetId: string, id: string) {
    const job = this.jobs.get(targetId)
    if (!job || job.installation.id !== id)
      throw new AppError('Installation log is no longer available', 404)
    const stream = new PassThrough({ highWaterMark: 1024 * 1024 })
    const send = (event: InstallationEvent) =>
      stream.write(`${JSON.stringify(event)}\n`)
    if (job.output)
      send({
        type: 'output',
        text: `${job.omitted ? '[Earlier output omitted]\n' : ''}${job.output}`,
      })
    send({
      type: job.installation.status === 'running' ? 'status' : 'complete',
      installation: job.installation,
    })
    if (job.installation.status === 'running') {
      job.subscribers.add(stream)
      stream.once('close', () => job.subscribers.delete(stream))
    } else stream.end()
    return stream
  }
  forget(targetId: string) {
    this.jobs.delete(targetId)
  }
  async close() {
    this.closed = true
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.all([...this.jobs.values()].map((job) => job.completion))
    this.jobs.clear()
  }
}
