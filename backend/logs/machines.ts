// Machine events in the activity log: what sessions' drivers recorded on each
// machine (machine/events.ts), read by cursor whenever the machine's node says
// there is more and every minute, so a machine that was away catches up. It
// also notices when a machine stops answering, and when it is back.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MachineEvent, MachineEvents } from '../../shared/machine'
import type { Session } from '../../shared/model'
import { writeJsonFile } from '../../shared/node/jsonFile'
import type { Deployment, Owner } from '../deployment'
import type { TargetContext } from '../sessions'
import type { ActivityLog, LogInput } from './activity'

interface Dependencies {
  deployment: Deployment
  resolve(owner: Owner, targetId: string): Promise<TargetContext>
  list(context: TargetContext): Promise<Session[]>
  log: ActivityLog
}
interface Machine {
  /** Where reading continues; null until first read, which starts at the end. */
  cursor: string | null
  names: Map<string, string>
  reachable: boolean | null
  reading: Promise<void> | null
  again: boolean
}

const states: Record<string, (detail: string | null) => string> = {
  working: () => 'is working',
  waiting: () => 'is waiting for you',
  idle: () => 'is idle',
  finished: () => 'finished its turn',
  error: detail => `stopped with an error${detail ? `: ${detail}` : ''}`,
  unknown: () => 'is in a state Outpost cannot track',
}
const place = (driver: 'terminal' | 'chat') => (driver === 'terminal' ? 'in a terminal' : 'in chat')

export class MachineEventLog {
  private machines = new Map<string, Machine>()
  private loaded = new Map<string, Promise<Record<string, string>>>()
  private timer: NodeJS.Timeout | null = null

  constructor(private dependencies: Dependencies) {}

  start() {
    const sweep = () => {
      for (const owner of this.dependencies.deployment.backgroundOwners())
        void this.dependencies.deployment
          .workspace(owner)
          .list()
          .then(
            targets => targets.forEach(target => this.read(owner, target.id)),
            () => {},
          )
    }
    sweep()
    this.timer = setInterval(sweep, 60_000)
    this.timer.unref()
  }
  close() {
    if (this.timer) clearInterval(this.timer)
  }

  private cursorsPath(owner: Owner) {
    return join(this.dependencies.deployment.workspace(owner).directory, 'log-cursors.json')
  }
  private cursors(owner: Owner) {
    let cursors = this.loaded.get(owner.userId)
    if (!cursors) {
      cursors = readFile(this.cursorsPath(owner), 'utf8').then(
        text => (JSON.parse(text) as { cursors: Record<string, string> }).cursors,
        () => ({}),
      )
      this.loaded.set(owner.userId, cursors)
    }
    return cursors
  }

  private machine(owner: Owner, targetId: string) {
    const key = `${owner.userId}\0${targetId}`
    let machine = this.machines.get(key)
    if (!machine) {
      machine = { cursor: null, names: new Map(), reachable: null, reading: null, again: false }
      this.machines.set(key, machine)
    }
    return machine
  }

  /** Read what the machine recorded since last time. Calls while a read runs
   * fold into one more read after it. */
  read(owner: Owner, targetId: string) {
    const machine = this.machine(owner, targetId)
    if (machine.reading) {
      machine.again = true
      return machine.reading
    }
    machine.reading = this.drain(owner, targetId, machine).finally(() => {
      machine.reading = null
      if (machine.again) {
        machine.again = false
        void this.read(owner, targetId)
      }
    })
    return machine.reading
  }

  private async drain(owner: Owner, targetId: string, machine: Machine) {
    let context: TargetContext
    try {
      context = await this.dependencies.resolve(owner, targetId)
    } catch {
      return // Removed meanwhile.
    }
    const target = { id: context.target.id, name: context.target.name }
    const cursors = await this.cursors(owner)
    machine.cursor ??= cursors[targetId] ?? null
    try {
      for (let more = true; more;) {
        const page: MachineEvents = await context.machine.call<MachineEvents>('events', { after: machine.cursor })
        for (const event of page.events) await this.recordEvent(owner, context, target, machine, event)
        machine.cursor = page.cursor
        more = page.more
      }
      cursors[targetId] = machine.cursor!
      await writeJsonFile(this.cursorsPath(owner), { version: 1, cursors })
      if (machine.reachable === false)
        this.dependencies.log.record(owner, {
          kind: 'machine',
          type: 'reachable',
          message: `${target.name} is reachable again`,
          machine: target,
        })
      machine.reachable = true
    } catch (error) {
      if (machine.reachable !== false)
        this.dependencies.log.record(owner, {
          level: 'warning',
          kind: 'machine',
          type: 'unreachable',
          message: `${target.name} is not reachable: ${(error as Error).message}`,
          machine: target,
          details: { error: (error as Error).message },
        })
      machine.reachable = false
    }
  }

  private async sessionName(context: TargetContext, machine: Machine, id: string) {
    if (!machine.names.has(id))
      try {
        for (const session of await this.dependencies.list(context)) machine.names.set(session.id, session.name)
      } catch {
        /* Named by its id below. */
      }
    return machine.names.get(id) ?? id.slice(0, 8)
  }

  private async recordEvent(
    owner: Owner,
    context: TargetContext,
    target: { id: string; name: string },
    machine: Machine,
    event: MachineEvent,
  ) {
    const session = { id: event.session, name: await this.sessionName(context, machine, event.session) }
    const common = { time: event.at, machine: target, session }
    let input: LogInput
    if (event.type === 'activity')
      input = {
        ...common,
        level: event.state === 'error' ? 'error' : 'info',
        kind: 'agent',
        type: 'status',
        message: `${session.name} ${states[event.state](event.detail)}`,
        details: { state: event.state, previous: event.previous, detail: event.detail },
      }
    else if (event.type === 'started')
      input = {
        ...common,
        kind: 'session',
        type: 'started',
        message: `${session.name} started ${place(event.driver)}`,
        details: { driver: event.driver },
      }
    else
      input = {
        ...common,
        level: event.code ? 'warning' : 'info',
        kind: 'session',
        type: 'exited',
        message: `${session.name} stopped ${place(event.driver)}${event.code ? ` (exit code ${event.code})` : ''}`,
        details: { driver: event.driver, code: event.code },
      }
    this.dependencies.log.record(owner, input)
  }
}
