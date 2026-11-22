// The Linux host has one durable owner directory. Private session data remains
// in the execution account's home across disconnection and unenrollment.
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { removeSupervisor } from './supervisor'
import { driverStatus } from './drivers'
import { readRegistry } from './registry'
import { randomUUID } from 'node:crypto'
import { locked, readJson, state, statePath, writeJson } from './state'
import { serverOrigin } from '../shared/serverOrigin'
export type OutboundInstall = {
  mode: 'outbound'
  origin: string
  targetId: string
  credential: string
  socket: string
}
type Configuration = OutboundInstall | { mode: 'ssh'; socket: string }
export type Installation = Configuration & { home: string; generation: string }
declare const OUTPOST_ISOLATED_TEST_HOST: boolean
export const hostDirectory = () =>
  process.platform === 'linux' && !(typeof OUTPOST_ISOLATED_TEST_HOST !== 'undefined' && OUTPOST_ISOLATED_TEST_HOST)
    ? '/var/lib/outpost-machine'
    : statePath('installation')
function directory() {
  const path = hostDirectory()
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw Error(
          'Provision /var/lib/outpost-machine for the Outpost execution account first. See the machine installation guide.',
          { cause: error },
        )
    }
  }
  const st = lstatSync(path)
  if (!st.isDirectory() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0)
    throw Error('This host is reserved for another Outpost installation or its ownership is unsafe.')
  return path
}
const file = () => join(directory(), 'machine.json')
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export function validOutboundIdentity(pair: Pick<OutboundInstall, 'targetId' | 'credential' | 'socket'>) {
  return (
    pair &&
    typeof pair.targetId === 'string' &&
    uuid.test(pair.targetId) &&
    validNodeSocket(pair.socket) &&
    typeof pair.credential === 'string' &&
    pair.credential.startsWith(pair.targetId + '.') &&
    /^[A-Za-z0-9_-]{43}$/.test(pair.credential.slice(pair.targetId.length + 1))
  )
}

function validConfiguration(config: Configuration) {
  switch (config.mode) {
    case 'ssh':
      return validNodeSocket(config.socket)
    case 'outbound':
      return validOutboundIdentity(config) && serverOrigin(config.origin) === config.origin
    default:
      return false
  }
}

export function installation() {
  if (!existsSync(hostDirectory())) return null
  const current = readJson<Installation | undefined>(file(), undefined)
  if (current === undefined) return null
  if (!current || !uuid.test(current.generation) || !validConfiguration(current))
    throw Error('Invalid machine installation record.')
  if (current.home !== realpathSync(state.directory))
    throw Error('This host already belongs to another Outpost installation.')
  return current
}
export function writeInstallation(c: Configuration) {
  const record = { ...c, generation: randomUUID(), home: realpathSync(state.directory) }
  writeJson(file(), record)
  return record
}
export const installationLock = <T>(action: () => Promise<T> | T) => locked('ownership', action, 15000, directory())
export const runtimeLock = <T>(action: () => Promise<T> | T, timeout = 300) =>
  locked('outbound', action, timeout, directory())
export async function requireUnenrolled() {
  const current = installation()
  if (current)
    throw Error(
      'This machine already has an owner. Stop the Outpost machine service and run outpost-terminal unenroll before changing servers.',
    )
  await runtimeLock(() => {})
  await nodeLock(() => {}, 300)
}
export const nodeLock = <T>(action: () => Promise<T> | T, timeout = 5000) =>
  locked('node-runtime', action, timeout, directory())
async function removableExecutable() {
  const path = statePath('bin', 'outpost-terminal')
  if (!existsSync(path) || !lstatSync(path).isFile() || realpathSync(process.execPath) !== realpathSync(path))
    throw Error(
      'Run uninstall from the installed ~/.outpost/bin/outpost-terminal. For a separately packaged executable, unenroll it and remove it with its installer.',
    )
  for (const { id } of readRegistry().sessions) {
    const { terminal, chat } = await driverStatus(id)
    if (terminal || chat)
      throw Error('Stop running Outpost sessions before uninstalling. The executable and session files have been kept.')
  }
  return path
}
export async function unenroll(removeExecutable = false) {
  if (!removeExecutable && !existsSync(hostDirectory())) {
    console.log('Machine is not enrolled.')
    return
  }
  const previous = await installationLock(async () => {
    const previous = installation()
    if (removeExecutable) await removableExecutable()
    if (previous?.mode === 'outbound') {
      try {
        await removeSupervisor()
      } catch (error) {
        throw Error(
          'Could not remove the Outpost boot service. Authorize sudo for this account or ask an administrator to remove the service, then retry.',
          { cause: error },
        )
      }
    }
    rmSync(file(), { force: true })
    // Pinning the ownership lock here prevents a new install during teardown.
    await runtimeLock(() => {}, 10000)
    await nodeLock(() => {}, 10000)
    if (previous && 'socket' in previous && validNodeSocket(previous.socket)) {
      const path = statePath(previous.socket)
      if (lstatSync(path, { throwIfNoEntry: false })?.isSocket()) rmSync(path)
    }
    if (removeExecutable) rmSync(await removableExecutable())
    return previous
  })
  if (previous && 'credential' in previous) {
    try {
      const r = await fetch(serverOrigin(previous.origin) + '/api/machine/revoke', {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + previous.credential, 'x-outpost-request': '1' },
        signal: AbortSignal.timeout(5000),
      })
      if (!r.ok && r.status !== 401) throw Error()
    } catch {
      console.error(
        'Local credential removed. Remove the machine from the old workspace to revoke its server credential.',
      )
    }
  }
  if (removeExecutable) console.log('Removed the managed Outpost machine service executable.')
  console.log('Machine disconnected. Remove its entry from the old workspace. Session data is kept.')
}
export function watchInstallation(record: Installation, onChange: () => void) {
  const timer = setInterval(() => {
    try {
      if (installation()?.generation === record.generation) return
    } catch {
      /* Fail closed on removal or corruption. */
    }
    clearInterval(timer)
    onChange()
  }, 250)
  return () => clearInterval(timer)
}
export function authorizeNode(socket: string) {
  const current = installation()
  if (current?.socket === socket) return current
  throw Error('This node does not belong to the installed Outpost server.')
}

export function validNodeSocket(value: unknown): value is string {
  return typeof value === 'string' && /^run\/node-[0-9a-f]{32}\.sock$/.test(value)
}

export async function enrollSsh(socket: string) {
  if (!validNodeSocket(socket)) throw Error('Invalid SSH enrollment identity.')
  await installationLock(async () => {
    const current = installation()
    if (current?.mode === 'ssh' && current.socket === socket) return
    await requireUnenrolled()
    writeInstallation({ mode: 'ssh', socket })
  })
}
