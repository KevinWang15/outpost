import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import type { ExecutionEnvironment, Target, TargetUpdate } from '../shared/model'
import Type from 'typebox'
import { targetRecord } from '../shared/schemas'
import { AppError } from './errors'

interface WorkspaceFile {
  version: 2
  targets: Target[]
}
const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false })
const validTarget = ajv.compile<Target>(targetRecord)
const validFile = ajv.compile<WorkspaceFile>(
  Type.Object({ version: Type.Literal(2), targets: Type.Array(targetRecord) }, { additionalProperties: false }),
)

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
      return { version: 2, targets: [] }
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
      throw new AppError('Duplicate targets in workspace.json. No data was modified.', 409)
    }
    return data
  }
  private transaction<T>(action: (data: WorkspaceFile) => T | Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
      const data = await this.read()
      const result = await action(data)
      const temporary = join(this.directory, `workspace.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
      return result
    })
    this.queue = work.catch(() => {})
    return work
  }
  private update(id: string, change: (target: Target) => Target, message: string) {
    return this.transaction(data => {
      const index = data.targets.findIndex(target => target.id === id)
      if (index < 0) throw new AppError('Target not found', 404)
      const updated = change(data.targets[index])
      if (!validTarget(updated)) throw new AppError(message, 400)
      if (data.targets.some(target => target.id !== id && target.name.toLowerCase() === updated.name.toLowerCase()))
        throw new AppError('A target with this name already exists', 409)
      data.targets[index] = updated
      return updated
    })
  }
  async list() {
    await this.queue
    return (await this.read()).targets
  }
  async get(id: string) {
    const target = (await this.list()).find(item => item.id === id)
    if (!target) throw new AppError('Target not found', 404)
    return target
  }
  add(target: Target) {
    return this.transaction(data => {
      if (!validTarget(target)) throw new AppError('Invalid target settings.', 400)
      if (data.targets.some(item => item.id === target.id))
        throw new AppError('A target with this ID already exists', 409)
      if (data.targets.some(item => item.name.toLowerCase() === target.name.toLowerCase()))
        throw new AppError('A target with this name already exists', 409)
      data.targets.push(target)
      return target
    })
  }
  edit(id: string, patch: TargetUpdate) {
    return this.update(id, target => ({ ...target, ...patch }), 'Invalid target settings.')
  }
  setEnvironment(id: string, environment: ExecutionEnvironment) {
    return this.update(id, target => ({ ...target, environment }), 'Invalid execution environment.')
  }
  remove(id: string) {
    return this.transaction(data => {
      if (!data.targets.some(item => item.id === id)) throw new AppError('Target not found', 404)
      data.targets = data.targets.filter(item => item.id !== id)
    })
  }
}
