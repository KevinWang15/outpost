// Facts about the machine's own processes, read from /proc (machines run Linux).
import { readFileSync } from 'node:fs'

interface ProcessStat {
  /** The executable's name, at most 15 characters (`comm`). */
  command: string
  parent: number
  /** The process session it belongs to: the PID of that session's leader. */
  session: number
}

/** A process's name, parent and process session, or null once it has gone. */
export function processStat(pid: number): ProcessStat | null {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  } catch {
    return null
  }
  // The name sits in parentheses and may itself contain spaces or parentheses.
  const close = stat.lastIndexOf(')')
  const fields = stat.slice(close + 2).split(' ')
  return { command: stat.slice(stat.indexOf('(') + 1, close), parent: Number(fields[1]), session: Number(fields[3]) }
}

const shells = new Set(['sh', 'bash', 'dash', 'zsh', 'ash', 'ksh', 'mksh', 'busybox'])

/** The process session of the program that ran this process. Coding tools run hook
 * commands through a shell, so the program is the nearest ancestor that is not one. */
export function runnerSession(pid = process.pid): number | null {
  let ancestor = processStat(pid)?.parent ?? 0
  for (let depth = 0; ancestor > 1 && depth < 32; depth++) {
    const stat = processStat(ancestor)
    if (!stat) return null
    if (!shells.has(stat.command)) return stat.session
    ancestor = stat.parent
  }
  return null
}
