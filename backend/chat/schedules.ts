import { randomUUID } from 'node:crypto'
import { chatLimits, type Schedule, type ScheduleInput } from '../../shared/chatApi'
import { cronMatches, parseCron, validTimeZone, zonedParts } from '../../shared/cron'
import type { Owner } from '../deployment'
import { AppError } from '../errors'
import { broadcast, findSession, now, sessionOf, type Account, type HubRuntime } from './context'
import type { DeliveryManager } from './deliveries'
import { schedulePrompt } from './prompts'

export class ScheduleManager {
  constructor(
    private hub: HubRuntime,
    private deliveries: DeliveryManager,
  ) {}

  async saveSchedule(owner: Owner, input: ScheduleInput) {
    const account = await this.hub.account(owner)
    try {
      parseCron(input.cron)
    } catch (error) {
      throw new AppError((error as Error).message, 400)
    }
    if (!validTimeZone(input.timeZone)) throw new AppError('Unknown time zone.', 400)
    await this.hub.fresh(account)
    if (!findSession(account, input)) throw new AppError('The session was not found.', 404)
    const { schedule, edited } = await account.store.change(['schedules'], () => {
      const list = account.store.schedules.schedules
      const existing = input.id ? list.find(item => item.id === input.id) : undefined
      if (input.id && !existing) throw new AppError('Schedule not found.', 404)
      if (!existing && list.length >= chatLimits.schedules) throw new AppError('Too many schedules.', 409)
      const schedule: Schedule = {
        ...input,
        id: existing?.id ?? randomUUID(),
        name: input.name.trim(),
        createdAt: existing?.createdAt ?? now(),
        lastRun: existing?.lastRun ?? null,
      }
      const index = list.findIndex(item => item.id === schedule.id)
      if (index >= 0) list[index] = schedule
      else list.push(schedule)
      return { schedule, edited: Boolean(existing) }
    })
    broadcast(account, { type: 'schedule', schedule })
    this.hub.log(account, {
      kind: 'schedule',
      type: edited ? 'edited' : 'created',
      message: `Schedule ${schedule.name} was ${edited ? 'edited' : 'created'}`,
      ...sessionOf(account, schedule),
      details: { schedule: schedule.name, cron: schedule.cron, timeZone: schedule.timeZone, enabled: schedule.enabled },
    })
    return schedule
  }

  async deleteSchedule(owner: Owner, scheduleId: string) {
    const account = await this.hub.account(owner)
    const removed = await account.store.change(['schedules'], () => {
      const found = account.store.schedules.schedules.find(item => item.id === scheduleId) ?? null
      account.store.schedules.schedules = account.store.schedules.schedules.filter(item => item.id !== scheduleId)
      delete account.store.schedules.fired[scheduleId]
      return found
    })
    broadcast(account, { type: 'schedule-removed', scheduleId })
    if (removed)
      this.hub.log(account, {
        kind: 'schedule',
        type: 'deleted',
        message: `Schedule ${removed.name} was deleted`,
        ...sessionOf(account, removed),
        details: { schedule: removed.name },
      })
  }

  async runSchedule(owner: Owner, scheduleId: string) {
    const account = await this.hub.account(owner)
    const schedule = account.store.schedules.schedules.find(item => item.id === scheduleId)
    if (!schedule) throw new AppError('Schedule not found.', 404)
    await this.fire(account, schedule)
  }

  private async fire(account: Account, schedule: Schedule) {
    this.hub.log(account, {
      kind: 'schedule',
      type: 'fired',
      message: `Schedule ${schedule.name} ran`,
      ...sessionOf(account, schedule),
      details: { schedule: schedule.name },
    })
    const delivery = this.deliveries.create(
      schedule,
      { kind: 'schedule', scheduleId: schedule.id },
      schedulePrompt(schedule.name, schedule.prompt),
      {
        kind: 'schedule',
        scheduleId: schedule.id,
        name: schedule.name,
      },
    )
    await this.deliveries.add(account, delivery)
    void this.deliveries
      .send(account, delivery)
      .catch(error => this.deliveries.fail(account, delivery, (error as Error).message))
  }

  async ran(account: Account, scheduleId: string, ok: boolean, message: string | null) {
    const schedule = await account.store.change(['schedules'], () => {
      const found = account.store.schedules.schedules.find(item => item.id === scheduleId)
      if (!found) return null
      found.lastRun = { at: now(), ok, message }
      return found
    })
    if (schedule) broadcast(account, { type: 'schedule', schedule })
  }

  /** Fire each enabled schedule once in each matching minute while the server runs. */
  async tick() {
    if (this.hub.stopped) return
    const at = new Date()
    for (const [userId, pending] of [...this.hub.accounts.entries()]) {
      const account = await pending.catch(() => null)
      if (!account) continue
      if (!this.hub.dependencies.deployment.account(userId)) {
        this.hub.evictAccount(userId)
        continue
      }
      for (const schedule of [...account.store.schedules.schedules]) {
        if (!schedule.enabled) continue
        let matches: boolean
        try {
          matches = cronMatches(parseCron(schedule.cron), at, schedule.timeZone)
        } catch {
          continue
        }
        const zoned = zonedParts(at, schedule.timeZone)
        const minute = `${zoned.year}-${zoned.month}-${zoned.day} ${zoned.hour}:${zoned.minute}`
        if (!matches || account.store.schedules.fired[schedule.id] === minute) continue
        await account.store.change(['schedules'], () => {
          account.store.schedules.fired[schedule.id] = minute
        })
        await this.fire(account, schedule).catch(error =>
          this.ran(account, schedule.id, false, (error as Error).message),
        )
      }
    }
  }
}
