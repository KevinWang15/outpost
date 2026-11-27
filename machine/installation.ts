// The Linux host has one durable owner directory. Private session data remains
// in the execution account's home across disconnection and unenrollment.
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { uuidRegex } from '../shared/schemas'
import { removeSupervisor } from './supervisor'
import { driverStatus } from './drivers'
import { installHelpers } from './launch'
import { readRegistry } from './registry'
import { randomBytes, randomUUID } from 'node:crypto'
import { locked, machineExecutable, readJson, state, statePath, syncDirectory, writeJson } from './state'
import { serverOrigin } from '../shared/serverOrigin'
export type OutboundEnrollment = {
  mode: 'outbound'
  origin: string
  targetId: string
  credential: string
  socket: string
}
type PendingOutbound = Omit<OutboundEnrollment, 'socket'> & { socket: null }
type Configuration = OutboundEnrollment | { mode: 'ssh'; socket: string }
type Owner = { home: string; generation: string }
export type Installation = Configuration & Owner
type Ownership = Installation | (PendingOutbound & Owner)
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
    throw Error(
      'This host directory belongs to another account or its permissions are unsafe. See Machine setup and removal before changing accounts.',
    )
  return path
}
const file = () => join(directory(), 'machine.json')
function validConfiguration(config: Configuration | PendingOutbound) {
  switch (config.mode) {
    case 'ssh':
      return validNodeSocket(config.socket)
    case 'outbound':
      return (
        typeof config.targetId === 'string' &&
        uuidRegex.test(config.targetId) &&
        (config.socket === null || validNodeSocket(config.socket)) &&
        typeof config.credential === 'string' &&
        config.credential.startsWith(config.targetId + '.') &&
        /^[A-Za-z0-9_-]{43}$/.test(config.credential.slice(config.targetId.length + 1)) &&
        serverOrigin(config.origin) === config.origin
      )
    default:
      return false
  }
}

export function ownership() {
  if (!existsSync(hostDirectory())) return null
  const current = readJson<Ownership | undefined>(file(), undefined)
  if (current === undefined) return null
  if (!current || !uuidRegex.test(current.generation) || !validConfiguration(current))
    throw Error('Invalid machine installation record.')
  if (current.home !== realpathSync(state.directory))
    throw Error('This host already belongs to another Outpost installation.')
  return current
}
export function installation(): Installation | null {
  const current = ownership()
  return current?.socket === null ? null : current
}

/** Both installers verify the downloaded executable in a private directory on the
 * destination filesystem. Promote it under the ownership lock before recording a claim. */
function installExecutable() {
  const bin = realpathSync(dirname(machineExecutable()))
  const source = realpathSync(process.execPath)
  if (!/^\.setup\.[^/]+\/machine$/.test(relative(bin, source)))
    throw Error('Run the machine setup command to install the verified executable.')
  syncDirectory(source)
  renameSync(source, machineExecutable())
  syncDirectory(bin)
  installHelpers()
}

export function writeOwnership<T extends Configuration | PendingOutbound>(configuration: T) {
  const record = { ...configuration, generation: randomUUID(), home: realpathSync(state.directory) }
  writeJson(file(), record)
  syncDirectory(directory())
  return record
}
export const installationLock = <T>(action: () => Promise<T> | T) => locked('ownership', action, 15000, directory())
export const runtimeLock = <T>(action: () => Promise<T> | T, timeout = 300) =>
  locked('outbound', action, timeout, directory())
async function requireUnenrolled(current: Ownership | null) {
  if (current)
    throw Error('This machine already has an owner. Run outpost-terminal unenroll before enrolling it elsewhere.')
  await runtimeLock(() => {})
  await nodeLock(() => {}, 300)
}

/** Under the ownership lock, save the machine's credential before sending it to the server. */
export async function reserveOutbound(
  origin: string,
  targetId: string,
  install: boolean,
): Promise<PendingOutbound | null> {
  if (!uuidRegex.test(targetId)) throw Error('Invalid Outpost machine ID.')
  const current = ownership()
  const same = current?.mode === 'outbound' && current.origin === origin && current.targetId === targetId
  if (!same) await requireUnenrolled(current)
  if (install) installExecutable()
  if (same) return current.socket === null ? current : null
  return writeOwnership({
    mode: 'outbound',
    origin,
    targetId,
    credential: targetId + '.' + randomBytes(32).toString('base64url'),
    socket: null,
  })
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
async function revokeOutbound(owner: OutboundEnrollment | PendingOutbound) {
  try {
    const response = await fetch(owner.origin + '/api/machine/revoke', {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: 'Bearer ' + owner.credential, 'x-outpost-request': '1' },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok && response.status !== 401) throw Error()
  } catch {
    console.error('Could not confirm credential revocation. Remove this machine from its workspace to revoke it there.')
  }
}
export async function unenroll(removeExecutable = false) {
  if (!removeExecutable && !existsSync(hostDirectory())) {
    console.log('Machine is not enrolled.')
    return
  }
  await installationLock(async () => {
    const previous = ownership()
    const executable = removeExecutable ? await removableExecutable() : null
    if (previous?.mode === 'outbound' && previous.socket !== null) {
      try {
        await removeSupervisor()
      } catch (error) {
        throw Error(
          'Could not remove the Outpost boot service. Authorize sudo for this account or ask an administrator to remove the service, then retry.',
          { cause: error },
        )
      }
    }
    if (previous?.mode === 'outbound') await revokeOutbound(previous)
    rmSync(file(), { force: true })
    syncDirectory(directory())
    // Pinning the ownership lock here prevents a new install during teardown.
    await runtimeLock(() => {}, 10000)
    await nodeLock(() => {}, 10000)
    if (previous?.socket) {
      const path = statePath(previous.socket)
      if (lstatSync(path, { throwIfNoEntry: false })?.isSocket()) rmSync(path)
    }
    if (executable) rmSync(executable)
  })
  if (removeExecutable) console.log('Removed the installed Outpost machine service executable.')
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

export async function enrollSsh(socket: string, install = false) {
  if (!validNodeSocket(socket)) throw Error('Invalid SSH enrollment identity.')
  await installationLock(async () => {
    const current = ownership()
    const same = current?.mode === 'ssh' && current.socket === socket
    if (!same) await requireUnenrolled(current)
    if (install) installExecutable()
    if (!same) writeOwnership({ mode: 'ssh', socket })
  })
}
