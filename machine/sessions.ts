// Session operations on the machine: the registry plus what drives each
// session now. Creation is idempotent per request key; edits name the revision
// they were based on.
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { Conversation, Session, SessionInput, SessionRecord, SessionUpdate } from '../shared/model'
import { acknowledgeResting, restingActivity } from './activity'
import { driverStatus, request, stopDriver } from './drivers'
import { removeSessionFiles } from './files'
import { harness } from './harnesses'
import { chatSocket, terminalSocket, which } from './launch'
import {
  changeRegistry,
  readRegistry,
  RegistryError,
  session as findSession,
  switchConversation,
  type Registry,
} from './registry'
import { locked, now, statePath } from './state'
import { Scan } from './stores'

export async function describe(record: SessionRecord, registry: Registry): Promise<Session> {
  const { terminal, chat } = await driverStatus(record.id)
  const running = terminal ?? chat
  const adapter = harness(record.tool)
  const scan = new Scan(2, 16 * 1024 * 1024)
  const title = (id: string) => {
    try {
      return adapter.title(record, id, scan)
    } catch {
      return null
    }
  }
  const conversations: Conversation[] = record.conversations.map(item => {
    const owner = item.movedTo ? registry.sessions.find(session => session.id === item.movedTo) : null
    return {
      id: item.id,
      startedAt: item.startedAt,
      movedTo: item.movedTo ? { id: item.movedTo, name: owner?.name ?? 'another session' } : null,
      title: title(item.id),
    }
  })
  return {
    ...record,
    conversations,
    title: conversations.at(-1)!.title,
    status: running ? (running.clients ? 'attached' : 'detached') : record.lastConnectedAt ? 'stopped' : 'ready',
    driver: terminal ? 'terminal' : chat ? 'chat' : null,
    runningRevision: running?.revision ?? null,
    activity: running?.activity ?? restingActivity(record.id),
  }
}

export async function listSessions() {
  const registry = readRegistry()
  return Promise.all(registry.sessions.map(record => describe(record, registry)))
}

export async function getSession(id: unknown) {
  const registry = readRegistry()
  return describe(findSession(registry, id), registry)
}

function validLaunch(env: Record<string, string>, args: string) {
  if (Buffer.byteLength(JSON.stringify({ env, args })) > 16 * 1024)
    throw new RegistryError('Environment variables and arguments must fit within 16 KiB.', 400)
  const syntax = spawnSync('bash', ['-n', '-c', `exec "$1" ${args}`], { encoding: 'utf8' })
  if (syntax.error) throw new RegistryError('Bash is missing on this machine. Open Required Software to install it.')
  if (syntax.status !== 0) throw new RegistryError(`Invalid Bash argument syntax: ${syntax.stderr.trim()}`, 400)
}

function uniqueName(registry: Registry, name: string, except?: string) {
  if (registry.sessions.some(item => item.id !== except && item.name.toLowerCase() === name.toLowerCase()))
    throw new RegistryError('A session with this name already exists on this machine', 409)
}

function createWorktree(source: string, destination: string, branch: string) {
  const git = which('git')
  if (!git) throw new RegistryError('Git is missing on this machine. Install Git before forking a session.')
  if (existsSync(destination)) throw new RegistryError('The worktree directory already exists. Choose a new directory.')
  const run = (...args: string[]) => {
    const result = spawnSync(git, ['-C', source, ...args], {
      encoding: 'utf8',
      timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (result.error)
      throw new RegistryError('Git worktree creation timed out. Check the machine before retrying.', 504)
    if (result.status !== 0)
      throw new RegistryError(
        `Could not create Git worktree: ${(result.stderr.trim() || result.stdout.trim()).slice(-4096)}`,
      )
    return result.stdout.trim()
  }
  // --branch accepts checkout shorthand such as @{-1}; require a literal name.
  if (run('check-ref-format', '--branch', branch) !== branch)
    throw new RegistryError('Enter a literal new Git branch name.', 400)
  run('worktree', 'add', '-b', branch, '--', destination, 'HEAD')
}

interface Creation {
  name: string
  rootDir: string
  createDirectory?: boolean
  tool: SessionInput['tool']
  env: Record<string, string>
  args: string
  instructions: string | null
  conversation?: string
  storage?: Record<string, string>
  /** Fork: a new worktree for this branch from the source session's directory. */
  worktree?: { source: string; branch: string }
}

/** Serialize creations, without holding the registry lock through Git or CLI work. */
async function create(input: Creation, creationKey?: string): Promise<Session> {
  if (creationKey !== undefined && !/^[0-9a-f]{64}$/.test(creationKey))
    throw new RegistryError('Invalid creation request identity.', 400)
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  return locked('creation', async () => {
    const before = readRegistry()
    const receipt = creationKey ? before.creations[creationKey] : undefined
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new RegistryError('This creation request was already used with different session settings.', 409)
      const existing = before.sessions.find(item => item.id === receipt.sessionId)
      if (!existing) throw new RegistryError('The session from this creation request has been deleted.', 410)
      return describe(existing, before)
    }
    const name = input.name.trim()
    uniqueName(before, name)
    validLaunch(input.env, input.args)
    const path = input.rootDir.startsWith('~/') ? homedir() + input.rootDir.slice(1) : input.rootDir
    if (!isAbsolute(path)) throw new RegistryError('Root directory must be absolute or begin with ~/', 400)
    const adapter = harness(input.tool)
    let tokens: string[] = []
    try {
      tokens = input.args.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? []
    } catch {
      /* Bash validated the syntax; expanded arguments are checked at launch. */
    }
    if (adapter.selectsSession(tokens))
      throw new RegistryError(
        'Outpost controls the coding tool conversation. Find conversations to resume one instead.',
        400,
      )
    const environment = { ...(process.env as Record<string, string>), ...input.env, ...(input.storage ?? {}) }
    const executable = which(adapter.command, environment.PATH)
    if (!executable)
      throw new RegistryError(
        `${adapter.command} is missing on this machine. Check Required Software and your login PATH.`,
      )
    // A Git failure never allocates a conversation or a session.
    if (input.worktree) createWorktree(input.worktree.source, resolve(path), input.worktree.branch)
    if (input.createDirectory) mkdirSync(path, { recursive: true })
    if (!existsSync(path) || !statSync(path).isDirectory())
      throw new RegistryError(
        'Root directory does not exist. Enable Create directory or choose an existing directory.',
        400,
      )
    const root = realpathSync(path)
    let conversation: string
    let storage: Record<string, string>
    try {
      if (input.conversation) {
        const found = adapter.find(input.conversation, environment, root, new Scan())
        if (!found)
          throw new RegistryError('The conversation was not found on this machine. Search again to refresh it.')
        if (!found.root || realpathSync(found.root) !== root)
          throw new RegistryError('Use the conversation’s working directory when linking it to a session.', 400)
        conversation = found.id
        storage = found.storage
      } else {
        storage = adapter.storage(adapter.home(environment, root))
        conversation = await adapter.create(root, environment, executable)
      }
    } catch (error) {
      if (input.worktree)
        throw new RegistryError(`Worktree created at ${root}, but session creation failed: ${(error as Error).message}`)
      throw error
    }
    const record: SessionRecord = {
      id: randomUUID(),
      name,
      tool: input.tool,
      rootDir: root,
      createdAt: now(),
      lastConnectedAt: null,
      storage,
      config: { revision: 1, env: input.env, args: input.args, instructions: input.instructions?.trim() || null },
      conversations: [{ id: conversation, startedAt: now(), movedTo: null }],
    }
    return changeRegistry(registry => {
      // Re-check after slow external work; never overwrite concurrent changes.
      uniqueName(registry, name)
      if (
        registry.sessions.some(
          item =>
            item.tool === record.tool &&
            JSON.stringify(item.storage) === JSON.stringify(storage) &&
            item.conversations.some(entry => entry.id === conversation && !entry.movedTo),
        )
      )
        throw new RegistryError('This conversation already has an Outpost session on this machine.', 409)
      registry.sessions.push(record)
      if (creationKey) registry.creations[creationKey] = { fingerprint, sessionId: record.id }
      return record
    }).then(async created => describe(created, readRegistry()))
  })
}

export async function createSession(input: SessionInput, creationKey?: string) {
  return create(
    {
      name: input.name,
      rootDir: input.rootDir,
      createDirectory: input.createDirectory,
      tool: input.tool,
      env: input.env ?? {},
      args: input.args ?? '',
      instructions: input.instructions ?? null,
      conversation: input.conversation,
      storage: input.storage,
    },
    creationKey,
  )
}

/** A new session in a new Git worktree, with the source's settings and a new conversation. */
export async function forkSession(id: unknown, branch: unknown, rootDir: unknown) {
  const source = findSession(readRegistry(), id)
  if (typeof branch !== 'string' || !branch || branch !== branch.trim() || branch.length > 256)
    throw new RegistryError('Enter a valid new Git branch name.', 400)
  if (typeof rootDir !== 'string') throw new RegistryError('Choose a directory for the worktree.', 400)
  const registry = readRegistry()
  let name = branch.slice(0, 80)
  for (let suffix = 2; registry.sessions.some(item => item.name.toLowerCase() === name.toLowerCase()); suffix++)
    name = `${branch.slice(0, 80 - ` (${suffix})`.length)} (${suffix})`
  return create({
    name,
    rootDir,
    tool: source.tool,
    env: source.config.env,
    args: source.config.args,
    instructions: source.config.instructions,
    worktree: { source: source.rootDir, branch },
  })
}

/** Edit a session. Launch settings apply when it next starts. */
export async function updateSession(id: unknown, update: SessionUpdate) {
  const record = await changeRegistry(registry => {
    const record = findSession(registry, id)
    if (record.config.revision !== update.revision)
      throw new RegistryError('This session changed; review the new settings.', 409)
    if (update.name !== undefined) {
      uniqueName(registry, update.name.trim(), record.id)
      record.name = update.name.trim()
    }
    const env = update.env ?? record.config.env
    const args = update.args ?? record.config.args
    if (update.env !== undefined || update.args !== undefined) validLaunch(env, args)
    if (update.env !== undefined || update.args !== undefined || update.instructions !== undefined)
      record.config = {
        revision: record.config.revision + 1,
        env,
        args,
        instructions:
          update.instructions === undefined ? record.config.instructions : update.instructions?.trim() || null,
      }
    return record
  })
  return describe(record, readRegistry())
}

/** Make an earlier conversation current; it is resumed at the next start. */
export async function switchSession(id: unknown, conversation: unknown) {
  const { terminal, chat } = await driverStatus(String(id))
  if (terminal || chat) throw new RegistryError('Stop the session before switching its conversation.')
  const record = await changeRegistry(registry => {
    const record = findSession(registry, id)
    const entry = record.conversations.find(item => item.id === conversation)
    if (!entry) throw new RegistryError('This conversation is not in the session.', 404)
    if (entry.movedTo) throw new RegistryError('This conversation moved to another session.')
    switchConversation(registry, record.id, entry.id)
    return record
  })
  return describe(record, readRegistry())
}

export async function deleteSession(id: unknown) {
  const { terminal, chat } = await driverStatus(String(id))
  if (terminal || chat) throw new RegistryError('Stop the session or exit the coding tool before deleting it.')
  const record = await changeRegistry(registry => {
    const record = findSession(registry, id)
    registry.sessions = registry.sessions.filter(item => item !== record)
    return record
  })
  for (const path of [
    terminalSocket(record.id),
    chatSocket(record.id),
    `logs/${record.id}.log`,
    `logs/${record.id}.chat.log`,
    `activity/${record.id}.json`,
    `bindings/${record.id}.json`,
    `clipboard/${record.id}`,
  ])
    rmSync(statePath(path), { recursive: true, force: true })
  await removeSessionFiles(record.id)
}

export async function terminateSession(id: unknown) {
  const record = findSession(readRegistry(), id)
  await stopDriver(record.id)
  return getSession(record.id)
}

export async function acknowledgeSession(id: unknown, completionId: unknown) {
  if (typeof completionId !== 'string' || !/^[0-9a-f]{64}$/.test(completionId))
    throw new RegistryError('Invalid completion ID', 400)
  const record = findSession(readRegistry(), id)
  const { terminal, chat } = await driverStatus(record.id)
  if (terminal) await request(terminalSocket(record.id), { type: 'acknowledge', completionId })
  else if (chat) await request(chatSocket(record.id), { type: 'seen', completionId })
  else acknowledgeResting(record.id, completionId)
  return getSession(record.id)
}

export const touchSession = (id: string) =>
  changeRegistry(registry => {
    findSession(registry, id).lastConnectedAt = now()
  })
