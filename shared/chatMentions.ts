// Handles name sessions in chat (`@api`), for people and for agents' tools.
// One handle per session across the owner's targets; names are not unique
// across targets, so a clash takes the target's name too.

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')

/** Mentions that address every member of a channel. */
export const everyone = ['all', 'channel', 'here'] as const

export interface Handled {
  sessionId: string
  targetId: string
  name: string
  target: string
}

/** Stable, unique handles in the given order. */
export function handles<T extends Handled>(items: readonly T[]): Map<string, string> {
  const result = new Map<string, string>()
  const used = new Set<string>(everyone)
  const base = new Map<string, number>()
  for (const item of items) {
    const handle = slug(item.name) || 'session'
    base.set(handle, (base.get(handle) ?? 0) + 1)
  }
  for (const item of items) {
    const own = slug(item.name) || 'session'
    let handle =
      (base.get(own) ?? 0) > 1 || used.has(own) ? `${own}-${slug(item.target) || 'target'}`.slice(0, 48) : own
    for (let suffix = 2; used.has(handle); suffix++) handle = `${own}-${suffix}`
    used.add(handle)
    result.set(`${item.targetId}/${item.sessionId}`, handle)
  }
  return result
}

const mentionPattern = /(?<![\w@./-])@([a-z0-9][a-z0-9-]{0,47})/gi

/** Handles mentioned in text, in order, restricted to the given handles. */
export function mentions(text: string, known: readonly string[]): { handles: string[]; everyone: boolean } {
  const found: string[] = []
  let all = false
  for (const match of text.matchAll(mentionPattern)) {
    const handle = match[1].toLowerCase().replace(/-+$/, '')
    if ((everyone as readonly string[]).includes(handle)) all = true
    else if (known.includes(handle) && !found.includes(handle)) found.push(handle)
  }
  return { handles: found, everyone: all }
}
