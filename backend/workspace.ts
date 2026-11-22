import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import type { ExecutionEnvironment, Target, TargetUpdate } from '../shared/model'
import Type from 'typebox'
import { targetRecord } from '../shared/schemas'
import { desktopOrigin } from '../shared/desktopAuth'
import { supportsTerminal } from '../shared/harnesses'
import { AppError } from './errors'
import { writeJsonFile } from '../shared/node/jsonFile'

interface WorkspaceFile {
  version: 3
  targets: Target[]
}
const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false })
const validTarget = ajv.compile<Target>(targetRecord)
const validFile = ajv.compile<WorkspaceFile>(
  Type.Object({ version: Type.Literal(3), targets: Type.Array(targetRecord) }, { additionalProperties: false }),
)

function validateSettings(target: Target) {
  if (!validTarget(target)) throw new AppError('Invalid machine settings.', 400)
  if ('endpoint' in target && target.endpoint !== undefined) {
    try {
      target.endpoint = desktopOrigin(target.endpoint)
    } catch {
      throw new AppError('Enter the machine HTTPS origin, without a path.', 400)
    }
  }
  if (target.kind === 'direct' && !target.tools.every(supportsTerminal))
    throw new AppError('Direct-only machines support terminal coding tools only.', 400)
}

/** Target settings live with the server. Sessions are always read from their target. */
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly directory: string) {}
  private get path() {
    return join(this.directory, 'workspace.json')
  }
  private async read(): Promise<WorkspaceFile> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { version: 3, targets: [] }
    }
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      throw new AppError('Invalid JSON in workspace.json. No data was modified.', 409)
    }
    if (!validFile(data))
      throw new AppError('Invalid workspace.json. Expected the current schema; no data was modified.', 409)
    if (
      new Set(data.targets.map(target => target.id)).size !== data.targets.length ||
      new Set(data.targets.map(target => target.name.toLowerCase())).size !== data.targets.length
    ) {
      throw new AppError('Duplicate machines in workspace.json. No data was modified.', 409)
    }
    return data
  }
  private transaction<T>(action: (data: WorkspaceFile) => T | Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
      const data = await this.read()
      const result = await action(data)
      await writeJsonFile(this.path, data)
      return result
    })
    this.queue = work.catch(() => {})
    return work
  }
  private update(id: string, change: (target: Target) => Target) {
    return this.transaction(data => {
      const index = data.targets.findIndex(target => target.id === id)
      if (index < 0) throw new AppError('Machine not found', 404)
      const updated = change(data.targets[index])
      validateSettings(updated)
      if (data.targets.some(target => target.id !== id && target.name.toLowerCase() === updated.name.toLowerCase()))
        throw new AppError('A machine with this name already exists', 409)
      data.targets[index] = updated
      return updated
    })
  }
  async list() {
    await this.queue
    return (await this.read()).targets
  }
  /** Chat, history and activity collection need a server-to-machine connection. */
  async listForServer() {
    return (await this.list()).filter(target => target.kind !== 'direct')
  }
  async get(id: string) {
    const target = (await this.list()).find(item => item.id === id)
    if (!target) throw new AppError('Machine not found', 404)
    return target
  }
  add(target: Target) {
    return this.transaction(data => {
      validateSettings(target)
      if (target.kind === 'local' && data.targets.some(item => item.kind === 'local'))
        throw new AppError('The Outpost server is already in this workspace.', 409)
      if (data.targets.some(item => item.id === target.id))
        throw new AppError('A machine with this ID already exists', 409)
      if (data.targets.some(item => item.name.toLowerCase() === target.name.toLowerCase()))
        throw new AppError('A machine with this name already exists', 409)
      data.targets.push(target)
      return target
    })
  }
  edit(id: string, patch: TargetUpdate) {
    return this.update(id, target => {
      const { endpoint, ...fields } = patch
      const updated = { ...target, ...fields }
      if (endpoint !== undefined) {
        if (updated.kind !== 'direct' && updated.kind !== 'paired')
          throw new AppError('Only connector machines use an HTTPS endpoint.', 400)
        if (endpoint !== null) updated.endpoint = endpoint
        else if (updated.kind === 'paired') delete updated.endpoint
        else throw new AppError('Direct only requires a machine HTTPS address.', 400)
      }
      return updated
    })
  }
  setEnvironment(id: string, environment: ExecutionEnvironment) {
    return this.update(id, target => ({ ...target, environment }))
  }
  remove(id: string) {
    return this.transaction(data => {
      if (!data.targets.some(item => item.id === id)) throw new AppError('Machine not found', 404)
      data.targets = data.targets.filter(item => item.id !== id)
    })
  }
}
