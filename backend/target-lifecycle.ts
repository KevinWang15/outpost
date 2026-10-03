import { requiredSoftware, type SoftwareId } from '../shared/session-manager'
import { AppError } from './errors'
import type { Installations } from './installations'
import type { TargetStore } from './store'

// Installation startup and target removal share one critical section. The
// installer itself runs outside it; unrelated targets remain independent.
export class TargetLifecycle {
  private pending = new Map<string, Promise<void>>()
  constructor(private store: TargetStore, private installations: Installations) {}

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.pending.get(id) ?? Promise.resolve()).then(operation)
    const finished = result.then(() => {}, () => {})
    this.pending.set(id, finished)
    void finished.then(() => { if (this.pending.get(id) === finished) this.pending.delete(id) })
    return result
  }

  install(id: string, softwareId: SoftwareId, script: string) {
    return this.serialize(id, async () => {
      const target = await this.store.get(id)
      if (!target.environment) throw new AppError('Check Required Software before installing.', 409)
      if (!requiredSoftware(target, target.environment.platform).includes(softwareId))
        throw new AppError('Software is not required by this target', 400)
      return this.installations.start(target, softwareId, script)
    })
  }

  remove(id: string) {
    return this.serialize(id, async () => {
      if (this.installations.latest(id)?.status === 'running')
        throw new AppError('Wait for the installation to finish before removing this target.', 409)
      await this.store.remove(id)
      this.installations.forget(id)
    })
  }
}
