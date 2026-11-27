import { randomUUID } from 'node:crypto'
import { access, chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExecutionEnvironment, Target, TargetUpdate } from '../shared/model'
import Type from 'typebox'
import { targetRecord } from '../shared/schemas'
import { AppError } from './errors'
import { readStateFile } from './stateFile'
import { compileSchema } from './validate'
import { writeJsonFile } from '../shared/node/jsonFile'

interface WorkspaceFile {
  version: 3
  targets: Target[]
}
const validTarget = compileSchema(targetRecord)
const validFile = compileSchema(
  Type.Object({ version: Type.Literal(3), targets: Type.Array(targetRecord) }, { additionalProperties: false }),
)

function validateSettings(target: Target) {
  if (!validTarget(target)) throw new AppError('Invalid machine settings.', 400)
}

/** Target settings live with the server. Sessions are always read from their target. */
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly directory: string,
    private deploymentPolicy?: (target: Target) => void,
  ) {}
  private get path() {
    return join(this.directory, 'workspace.json')
  }
  private async read(): Promise<WorkspaceFile> {
    const data = await readStateFile(this.path, { version: 3, targets: [] }, validFile)
    if (
      new Set(data.targets.map(target => target.id)).size !== data.targets.length ||
      new Set(data.targets.map(target => target.name.toLowerCase())).size !== data.targets.length ||
      data.targets.filter(target => target.kind === 'local').length > 1
    ) {
      throw new AppError('Duplicate machines in workspace.json. No data was modified.', 409)
    }
    for (const target of data.targets) this.deploymentPolicy?.(target)
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
  async get(id: string) {
    const target = (await this.list()).find(item => item.id === id)
    if (!target) throw new AppError('Machine not found', 404)
    return target
  }
  add(target: Target) {
    return this.transaction(data => {
      validateSettings(target)
      this.deploymentPolicy?.(target)
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
    return this.update(id, target => ({ ...target, ...patch }))
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
  /** Seed this computer once on a brand-new workspace. No-op once workspace.json exists. */
  seedLocalIfNew(rawName: string): Promise<Target | null> {
    const work = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
      try {
        await access(this.path)
        return null
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const cleaned = Array.from(rawName)
        .filter(char => {
          const code = char.charCodeAt(0)
          return code >= 0x20 && code !== 0x7f
        })
        .join('')
        .trim()
        .slice(0, 80)
      const target: Target = {
        kind: 'local',
        id: randomUUID(),
        name: cleaned || 'This computer',
        createdAt: new Date().toISOString(),
      }
      validateSettings(target)
      this.deploymentPolicy?.(target)
      await writeJsonFile(this.path, { version: 3, targets: [target] } satisfies WorkspaceFile)
      return target
    })
    this.queue = work.catch(() => {})
    return work
  }
}
