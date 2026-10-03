import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionEnvironment, Target, TargetRequirements } from '../shared/session-manager'
import { AppError } from './errors'
import { validConfig, validTarget, type TargetConfig } from './schema'

// Target settings live with the manager. Sessions are always read from their execution host.
export class TargetStore {
  private queue: Promise<unknown> = Promise.resolve()
  readonly directory: string
  constructor(directory = process.env.OUTPOST_DATA_DIR ?? join(homedir(), '.outpost')) {
    this.directory = directory
  }
  private async read(): Promise<TargetConfig> {
    try {
      const config: unknown = JSON.parse(await readFile(join(this.directory, 'targets.json'), 'utf8'))
      if (!validConfig(config)) throw new AppError('Invalid target configuration. Expected the current schema; no data was modified.', 409)
      const ids = new Set(config.targets.map(target => target.id))
      const names = new Set(config.targets.map(target => target.name.toLowerCase()))
      if (ids.size !== config.targets.length || names.size !== config.targets.length) throw new AppError('Duplicate targets in configuration. No data was modified.', 409)
      return config
    } catch (error) {
      if (error instanceof SyntaxError) throw new AppError('Invalid JSON in target configuration. No data was modified.', 409)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { secret: randomBytes(32).toString('hex'), targets: [] }
    }
  }
  private transaction<T>(action: (config: TargetConfig) => T | Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
      const config = await this.read()
      const result = await action(config)
      const temporary = join(this.directory, `targets.${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
        await rename(temporary, join(this.directory, 'targets.json'))
      } finally { await rm(temporary, { force: true }) }
      return result
    })
    this.queue = work.catch(() => {})
    return work
  }
  async list() { await this.queue; return (await this.read()).targets }
  secret() { return this.transaction(config => config.secret) }
  async get(id: string) {
    const target = (await this.list()).find(item => item.id === id)
    if (!target) throw new AppError('Target not found', 404)
    return target
  }
  add(target: Target) {
    return this.transaction(config => {
      if (!validTarget(target)) throw new AppError('Invalid target configuration. Expected the current schema; no data was modified.', 409)
      if (config.targets.some(item => item.id === target.id)) throw new AppError('A target with this ID already exists', 409)
      if (config.targets.some(item => item.name.toLowerCase() === target.name.toLowerCase())) {
        throw new AppError('A target with this name already exists', 409)
      }
      config.targets.push(target)
      return target
    })
  }
  updateEnvironment(id: string, environment: ExecutionEnvironment) {
    return this.transaction(config => {
      const index = config.targets.findIndex(target => target.id === id)
      if (index < 0) throw new AppError('Target not found', 404)
      const updated = { ...config.targets[index], environment }
      if (!validTarget(updated)) throw new AppError('Invalid environment result. No data was modified.', 502)
      config.targets[index] = updated
      return updated
    })
  }
  updateRequirements(id: string, requirements: TargetRequirements) {
    return this.transaction(config => {
      const index = config.targets.findIndex(target => target.id === id)
      if (index < 0) throw new AppError('Target not found', 404)
      const updated = { ...config.targets[index], tools: requirements.tools, backends: requirements.backends }
      if (!validTarget(updated)) throw new AppError('Invalid software requirements. No data was modified.', 400)
      config.targets[index] = updated
      return updated
    })
  }
  remove(id: string) {
    return this.transaction(config => {
      if (!config.targets.some(item => item.id === id)) throw new AppError('Target not found', 404)
      config.targets = config.targets.filter(item => item.id !== id)
    })
  }
}
