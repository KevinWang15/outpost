// Standard five-field cron (minute hour day-of-month month day-of-week),
// evaluated in an IANA time zone. Lists, ranges and steps; 0 or 7 is Sunday.

const fields = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const

interface Cron {
  sets: Set<number>[]
  /** Whether day-of-month / day-of-week were restricted (cron's OR rule). */
  restricted: [boolean, boolean]
}

export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('A schedule needs five fields: minute hour day month weekday.')
  const sets = parts.map((part, index) => {
    const { name, min, max } = fields[index]
    const values = new Set<number>()
    for (const item of part.split(',')) {
      const match = item.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/)
      if (!match) throw new Error(`Invalid ${name}: ${item}`)
      const step = match[4] ? Number(match[4]) : 1
      const start = match[1] === '*' ? min : Number(match[2])
      const end = match[1] === '*' ? max : match[3] !== undefined ? Number(match[3]) : match[4] ? max : start
      if (step < 1 || start < min || end > max || start > end) throw new Error(`Invalid ${name}: ${item}`)
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value)
    }
    return values
  })
  return { sets, restricted: [parts[2] !== '*', parts[4] !== '*'] }
}

const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** The wall-clock fields of an instant in a time zone. */
export function zonedParts(date: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      minute: 'numeric',
      hour: 'numeric',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      weekday: 'short',
    })
      .formatToParts(date)
      .map(part => [part.type, part.value]),
  )
  return {
    minute: Number(values.minute),
    hour: Number(values.hour),
    day: Number(values.day),
    month: Number(values.month),
    year: Number(values.year),
    weekday: weekdays[values.weekday],
  }
}

export function cronMatches(cron: Cron, date: Date, timeZone: string) {
  const at = zonedParts(date, timeZone)
  const [minutes, hours, days, months, weekdays] = cron.sets
  if (!minutes.has(at.minute) || !hours.has(at.hour) || !months.has(at.month)) return false
  const day = days.has(at.day),
    weekday = weekdays.has(at.weekday)
  return cron.restricted[0] && cron.restricted[1] ? day || weekday : day && weekday
}

/** The next matching minute after `from`, within a year. */
export function nextRun(cron: Cron, timeZone: string, from = new Date()) {
  const date = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000)
  for (let index = 0; index < 366 * 24 * 60; index++, date.setTime(date.getTime() + 60_000))
    if (cronMatches(cron, date, timeZone)) return new Date(date)
  return null
}

export function validTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Plain-language summary of common schedules; other expressions are shown as written. */
export function describeCron(expression: string) {
  const parts = expression.trim().split(/\s+/)
  const [minute, hour, day, month, weekday] = parts
  if (parts.length !== 5) return expression
  const time = /^\d+$/.test(minute) && /^\d+$/.test(hour) ? `${pad(Number(hour))}:${pad(Number(minute))}` : null
  if (time && day === '*' && month === '*') {
    if (weekday === '*') return `Every day at ${time}`
    if (weekday === '1-5') return `Weekdays at ${time}`
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    if (/^[0-7]$/.test(weekday)) return `Every ${names[Number(weekday) % 7]} at ${time}`
  }
  if (/^\d+$/.test(minute) && hour === '*' && day === '*' && month === '*' && weekday === '*')
    return `Every hour at :${pad(Number(minute))}`
  const every = hour.match(/^\*\/(\d+)$/)
  if (/^\d+$/.test(minute) && every && day === '*' && month === '*' && weekday === '*')
    return `Every ${every[1]} hours at :${pad(Number(minute))}`
  return expression
}
