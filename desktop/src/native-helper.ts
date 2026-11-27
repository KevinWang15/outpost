// Child-process adapter for V3's shared protocol and account services. Stdin/stdout
// are private inherited pipes. Credentials stay here and never enter the terminal grid.
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { parseDesktopEntry, type DesktopSessionChoice, type DesktopSessionReference } from '../../shared/desktopAuth'
import { softwareLabel } from '../../shared/model'
import { uuidRegexCaseInsensitive } from '../../shared/schemas'
import { serverOrigin } from '../../shared/serverOrigin'
import { errorMessage, type HelperCommand } from './helper-protocol'
import { PaneRegistry } from './pane-session'
import { Preferences } from './preferences'
import { RecentSessions } from './recent-sessions'
import { ServerAccounts } from './server-accounts'
import { ServerTrust } from './server-trust'
import { shellProfiles } from './shell-profiles'

const dir = process.argv[2]
let closing = false
const emit = (event: string, payload: object = {}) => {
  if (!closing) process.stdout.write(JSON.stringify({ event, ...payload }) + '\n')
}
const pending = new Set<Promise<unknown>>()
function run(work: Promise<unknown>, context: object = {}) {
  const task = work.catch(error => {
    if (closing) console.error(errorMessage(error))
    else emit('error', { ...context, message: errorMessage(error) })
  })
  pending.add(task)
  void task.finally(() => pending.delete(task))
}

const prompts = new Map<number, (answer: boolean) => void>()
let serial = 0
const trust = new ServerTrust(
  join(dir, 'server-trust.json'),
  origin =>
    new Promise(resolve => {
      if (closing) return resolve(false)
      const id = ++serial
      prompts.set(id, resolve)
      emit('trust', { id, origin })
    }),
)
const accounts = new ServerAccounts(join(dir, 'server-logins.json'), trust, {
  openBrowser: async url => {
    emit('browser', { url })
  },
  changed: () => snapshot(),
  accountRemoved: removeAccount,
  failed: error => emit('error', { message: error.message }),
})
const recent = new RecentSessions(join(dir, 'recent-sessions.json'))
const prefs = new Preferences(join(dir, 'preferences.json'))
const profiles = shellProfiles()
let catalogue: DesktopSessionChoice[] = []
let listing: AbortController | undefined

const ownsSession = (ref: DesktopSessionReference) => accounts.hasAccount(ref.server, ref.accountId)
const effectiveLastUsedAt = (session: DesktopSessionChoice) =>
  Math.max(session.lastUsedAt ?? 0, recent.get(session.id)?.lastConnectedAt ?? 0)
const snapshot = () =>
  emit('accounts', {
    ...accounts.snapshot(),
    recent: recent.list(ownsSession),
    sessions: catalogue
      .filter(ownsSession)
      .map(session => ({ ...session, lastUsedAt: effectiveLastUsedAt(session) }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.title.localeCompare(b.title)),
  })

const refresh = async () => {
  if (closing) return
  listing?.abort()
  const controller = (listing = new AbortController())
  await accounts.refresh()
  await accounts.sessions(
    controller.signal,
    data => {
      catalogue = data.sessions
      snapshot()
      if (data.errors.length) emit('error', { message: data.errors.join('\n') })
    },
    catalogue,
  )
}

const panes = new PaneRegistry({
  emit,
  nextId: () => ++serial,
  closing: () => closing,
  ownsSession,
  launch: (ref, signal) => accounts.launch(ref, signal),
  scrollback: () => prefs.scrollback,
  knownTool: key => (catalogue.find(session => session.id === key) ?? recent.get(key))?.tool,
  rememberSession: entry => run(recent.remember(entry).then(snapshot)),
})

interface TrackedLookup {
  origin: string
  accountId: string
  controller: AbortController
}
const creations = new Map<number, { origin: string; accountId: string; key: string; id: string }>()
const targetLookups = new Map<number, TrackedLookup>()
const optionLookups = new Map<number, TrackedLookup>()
const directoryLookups = new Map<number, TrackedLookup>()

function startLookup(map: Map<number, TrackedLookup>, window: number, origin: string, accountId: string) {
  map.get(window)?.controller.abort()
  const entry: TrackedLookup = { origin, accountId, controller: new AbortController() }
  map.set(window, entry)
  return entry
}

function finishLookup(map: Map<number, TrackedLookup>, window: number, entry: TrackedLookup) {
  if (map.get(window) === entry) map.delete(window)
}

function abortAllLookups(filter?: (entry: TrackedLookup) => boolean) {
  for (const map of [targetLookups, optionLookups, directoryLookups]) {
    for (const [window, entry] of map) {
      if (filter && !filter(entry)) continue
      entry.controller.abort()
      map.delete(window)
    }
  }
}

async function removeAccount(origin: string, accountId: string) {
  const keep = (ref: DesktopSessionReference) => ref.server !== origin || ref.accountId !== accountId
  listing?.abort()
  catalogue = catalogue.filter(keep)
  for (const [window, item] of creations) {
    if (item.origin === origin && item.accountId === accountId) creations.delete(window)
  }
  abortAllLookups(entry => entry.origin === origin && entry.accountId === accountId)
  panes.removeAccount(keep)
  await recent.retain(keep)
}

async function openSessionCommand(c: Extract<HelperCommand, { op: 'openSession' }>) {
  const sessionId = typeof c.sessionId === 'string' ? c.sessionId.trim() : ''
  if (!uuidRegexCaseInsensitive.test(sessionId)) throw new Error('Invalid open-session request.')
  let preferredOrigin: string | undefined
  if (typeof c.origin === 'string' && c.origin.trim()) {
    try {
      preferredOrigin = serverOrigin(c.origin)
    } catch {
      preferredOrigin = undefined
    }
  }
  const targetId = typeof c.targetId === 'string' && c.targetId.trim() ? c.targetId.trim() : undefined
  const paneServer = typeof c.paneServer === 'string' && c.paneServer.trim() ? c.paneServer.trim() : undefined
  const signedIn = accounts.snapshot().accounts
  // Fast path: outbound-enrolled machine told us its exact Outpost server origin and target ID.
  if (preferredOrigin && targetId) {
    const account = signedIn.find(entry => entry.origin === preferredOrigin)
    if (account) {
      try {
        const launch = await accounts.launch({
          server: preferredOrigin,
          accountId: account.account.id,
          targetId,
          sessionId,
        })
        await panes.attach(launch, c.window)
        void refresh().catch(() => {})
        return
      } catch {
        // Fall through to catalogue discovery across all signed-in servers.
      }
    }
  }
  const findMatch = () => {
    const matches = catalogue.filter(item => item.sessionId === sessionId && ownsSession(item))
    if (!matches.length) return undefined
    if (preferredOrigin) {
      const byOrigin = matches.find(item => item.server === preferredOrigin)
      if (byOrigin) return byOrigin
    }
    if (paneServer) {
      const byPaneServer = matches.find(item => item.server === paneServer)
      if (byPaneServer) return byPaneServer
    }
    if (targetId) {
      const byTarget = matches.find(item => item.targetId === targetId)
      if (byTarget) return byTarget
    }
    return matches[0]
  }
  let match = findMatch()
  if (!match) {
    await refresh()
    match = findMatch()
  }
  if (match) {
    await panes.attach(await accounts.launch(match), c.window)
    return
  }
  if (!signedIn.length) throw new Error('Sign in to an Outpost server first to open sessions from the CLI.')
  const label = typeof c.name === 'string' && c.name.trim() ? `"${c.name.trim()}"` : sessionId
  const hint = preferredOrigin ? ` (${preferredOrigin})` : c.hostname ? ` on ${c.hostname}` : ''
  throw new Error(`Could not find session ${label}${hint} in your signed-in Outpost servers.`)
}

async function handle(c: HelperCommand) {
  switch (c.op) {
    case 'answer':
      prompts.get(c.id)?.(c.answer)
      prompts.delete(c.id)
      return
    case 'link':
      if (c.value.startsWith('outpost://login/')) {
        for (const ref of (await accounts.complete(c.value)) ?? [])
          await panes.attach(await accounts.launch(ref), c.window)
      } else {
        const launch = await accounts.connect(parseDesktopEntry(c.value))
        if (launch) await panes.attach(launch, c.window)
      }
      return refresh()
    case 'login':
      await accounts.connect({ server: c.origin })
      return refresh()
    case 'cancel':
      accounts.cancel(c.origin)
      return
    case 'logout':
      await accounts.logout(c.origin)
      return refresh()
    case 'refresh':
      return refresh()
    case 'forget':
      await recent.clear()
      return snapshot()
    case 'choose': {
      const ref = catalogue.find(s => s.id === c.value) ?? recent.get(c.value)
      if (!ref) throw new Error('Session is no longer available')
      return panes.attach(await accounts.launch(ref), c.window)
    }
    case 'openSession':
      return openSessionCommand(c)
    case 'prefs':
      await prefs.set(
        {
          fontSize: c.fontSize,
          sound: c.sound,
          scrollbackLines: c.scrollbackLines,
          unlimitedScrollback: c.unlimitedScrollback,
        },
        c.localShell,
      )
      panes.setScrollback(prefs.scrollback)
      emit('prefs', { ...prefs.value, localShell: prefs.localShell, profiles })
      return
    case 'targets':
    case 'options': {
      const map = c.op === 'targets' ? targetLookups : optionLookups
      const lookup = startLookup(map, c.window, c.origin, c.accountId)
      const context = { window: c.window, origin: c.origin, accountId: c.accountId }
      try {
        const server = accounts.creationServer(c.origin, c.accountId)
        if (c.op === 'targets') {
          const targets = await server.targets(lookup.controller.signal)
          if (!lookup.controller.signal.aborted) emit('targets', { ...context, targets })
        } else {
          const { tools, missing } = await server.options(c.target, lookup.controller.signal)
          if (!lookup.controller.signal.aborted)
            emit('options', { ...context, target: c.target, tools, missing: missing.map(softwareLabel) })
        }
      } catch (error) {
        if (!lookup.controller.signal.aborted) throw error
      } finally {
        finishLookup(map, c.window, lookup)
      }
      return
    }
    case 'directories': {
      const lookup = startLookup(directoryLookups, c.window, c.origin, c.accountId)
      const context = {
        window: c.window,
        id: c.id,
        origin: c.origin,
        accountId: c.accountId,
        target: c.target,
        path: c.path,
      }
      try {
        const server = accounts.creationServer(c.origin, c.accountId)
        const result = await server.directories(c.target, c.path ?? '', lookup.controller.signal)
        if (!lookup.controller.signal.aborted) emit('directories', { ...context, ...result })
      } catch (error) {
        if (!lookup.controller.signal.aborted) emit('directories', { ...context, error: errorMessage(error) })
      } finally {
        finishLookup(directoryLookups, c.window, lookup)
      }
      return
    }
    case 'create': {
      const server = accounts.creationServer(c.origin, c.accountId)
      const key = JSON.stringify([c.origin, c.accountId, c.target, c.input])
      let request = creations.get(c.window)
      if (request?.key !== key) {
        request = { origin: c.origin, accountId: c.accountId, key, id: randomUUID() }
        creations.set(c.window, request)
      }
      const item = await server.create(c.target, c.input, request.id)
      await panes.attach(await accounts.launch(item), c.window)
      creations.delete(c.window)
      return
    }
    default:
      return panes.handle(c)
  }
}

async function main() {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await trust.load()
  await accounts.load()
  await recent.load()
  await recent.retain(ownsSession)
  await prefs.load()
  emit('prefs', { ...prefs.value, localShell: prefs.localShell, profiles })
  snapshot()
  const lines = createInterface({ input: process.stdin })
  lines.on('line', line => {
    try {
      const c = JSON.parse(line) as HelperCommand
      const context: Record<string, unknown> = {}
      if ('window' in c && c.window !== undefined) context.window = c.window
      if ('pane' in c && c.pane !== undefined) context.pane = c.pane
      if (c.op === 'openSession') context.toast = true
      run(handle(c), context)
    } catch (error) {
      emit('error', { message: errorMessage(error) })
    }
  })
  lines.on('close', async () => {
    closing = true
    for (const answer of prompts.values()) answer(false)
    prompts.clear()
    abortAllLookups()
    creations.clear()
    accounts.dispose()
    panes.closeAll()
    // Every command preceding EOF was dispatched. Wait for its local writes before
    // ending the helper, including a credential exchange already in its saving phase.
    await Promise.all(pending)
    process.exit(0)
  })
  void refresh().catch(error => emit('error', { message: errorMessage(error) }))
}

main().catch(error => {
  emit('error', { message: errorMessage(error) })
  process.exitCode = 1
})
