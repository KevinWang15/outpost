import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Ajv } from 'ajv'
import type { ExecutionEnvironment, Target, TargetUpdate } from '../shared/model'
import { harnessIds } from '../shared/harnesses'
import { AppError } from './errors'

const textField = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '^[^\\u0000-\\u001f\\u007f]+$' })
const absolutePath = { ...textField(4096), pattern: '^/[^\\u0000-\\u001f\\u007f]*$' }
export const nameField = { ...textField(80), pattern: '^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$' }
export const toolsField = { type: 'array', minItems: 1, maxItems: harnessIds.length, uniqueItems: true, items: { enum: harnessIds } }
const sshFields = {
  host: { type: 'string', minLength: 1, maxLength: 253, pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]*$' },
  port: { type: 'integer', minimum: 1, maximum: 65535 },
  identityFile: { ...textField(1024), pattern: '^(~/|/)[^\\u0000-\\u001f\\u007f]+$' },
}
export const targetInput = {
  oneOf: [
    { properties: { kind: { const: 'ssh' } }, required: ['host'] },
    { properties: { kind: { const: 'local' } }, not: { anyOf: [{ required: ['host'] }, { required: ['port'] }, { required: ['identityFile'] }] } },
  ],
  type: 'object', additionalProperties: false, required: ['name', 'kind', 'tools'],
  properties: { name: nameField, kind: { enum: ['ssh', 'local'] }, tools: toolsField, ...sshFields },
}
export const targetUpdate = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: { name: nameField, tools: toolsField },
}
const environment = {
  type: 'object', additionalProperties: false, required: ['home', 'username', 'uid', 'shell'],
  properties: { home: absolutePath, username: textField(256), uid: { type: 'integer', minimum: 0 }, shell: absolutePath },
}
const targetRecord = {
  ...targetInput,
  required: [...targetInput.required, 'id', 'createdAt'],
  properties: { ...targetInput.properties, id: textField(80), createdAt: textField(80), environment },
}
interface WorkspaceFile { version: 2; targets: Target[] }
const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false })
const validTarget = ajv.compile<Target>(targetRecord)
const validFile = ajv.compile<WorkspaceFile>({
  type: 'object', additionalProperties: false, required: ['version', 'targets'],
  properties: { version: { const: 2 }, targets: { type: 'array', items: targetRecord } },
})

/** Convert an Outpost v1 `targets.json` once. Windows/WSL targets cannot run on v2. */
export function importV1(config: unknown): Target[] {
  if (!config || typeof config !== 'object' || !Array.isArray((config as { targets?: unknown }).targets)) return []
  return (config as { targets: Record<string, unknown>[] }).targets.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || entry.distribution) return []
    const target: Record<string, unknown> = { ...entry }
    const previous = entry.environment as (ExecutionEnvironment & { platform?: string }) | undefined
    delete target.backends
    delete target.environment
    if (previous && previous.platform !== 'darwin') target.environment = { home: previous.home, username: previous.username, uid: previous.uid, shell: previous.shell }
    return validTarget(target) ? [target] : []
  })
}

/** Target settings live with the server. Sessions are always read from their target. */
export class Workspace {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly directory: string) {}
  private get path() { return join(this.directory, 'workspace.json') }
  private async read(): Promise<WorkspaceFile> {
    let raw: string
    try { raw = await readFile(this.path, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { return { version: 2, targets: importV1(JSON.parse(await readFile(join(this.directory, 'targets.json'), 'utf8'))) } }
      catch { return { version: 2, targets: [] } }
    }
    let data: unknown
    try { data = JSON.parse(raw) } catch { throw new AppError('Invalid JSON in workspace.json. No data was modified.', 409) }
    if (!validFile(data)) throw new AppError('Invalid workspace.json. Expected the current schema; no data was modified.', 409)
    if (new Set(data.targets.map(target => target.id)).size !== data.targets.length
      || new Set(data.targets.map(target => target.name.toLowerCase())).size !== data.targets.length) {
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
      } finally { await rm(temporary, { force: true }) }
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
      if (data.targets.some(target => target.id !== id && target.name.toLowerCase() === updated.name.toLowerCase())) throw new AppError('A target with this name already exists', 409)
      data.targets[index] = updated
      return updated
    })
  }
  async list() { await this.queue; return (await this.read()).targets }
  async get(id: string) {
    const target = (await this.list()).find(item => item.id === id)
    if (!target) throw new AppError('Target not found', 404)
    return target
  }
  add(target: Target) {
    return this.transaction(data => {
      if (!validTarget(target)) throw new AppError('Invalid target settings.', 400)
      if (data.targets.some(item => item.id === target.id)) throw new AppError('A target with this ID already exists', 409)
      if (data.targets.some(item => item.name.toLowerCase() === target.name.toLowerCase())) throw new AppError('A target with this name already exists', 409)
      data.targets.push(target)
      return target
    })
  }
  edit(id: string, patch: TargetUpdate) { return this.update(id, target => ({ ...target, ...patch }), 'Invalid target settings.') }
  setEnvironment(id: string, environment: ExecutionEnvironment) { return this.update(id, target => ({ ...target, environment }), 'Invalid execution environment.') }
  remove(id: string) {
    return this.transaction(data => {
      if (!data.targets.some(item => item.id === id)) throw new AppError('Target not found', 404)
      data.targets = data.targets.filter(item => item.id !== id)
    })
  }
}
