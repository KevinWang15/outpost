// The Linux host has one durable owner directory. Private session data remains
// in the execution account's home across disconnection and unenrollment.
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, readdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { driverStatus } from './drivers'
import { readRegistry } from './registry'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import { desktopOrigin } from '../shared/desktopAuth'
import { DirectTickets } from '../shared/node/directTickets'
import { locked, readJson, state, statePath, writeJson } from './state'

export type RelayInstall = { mode: 'relay'; origin: string; targetId: string; credential: string; socket?: string }
export type DirectInstall = { mode: 'direct'; origin: string; targetId: string; publicKey: string; endpoint: string }
type Configuration = RelayInstall | DirectInstall | { mode: 'ssh'; socket: string } | { mode: 'unpaired' }
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
const generation = () => randomUUID()
export function installation() {
  if (!existsSync(hostDirectory())) return null
  const current = readJson<Installation | null>(file(), null)
  if (current && current.home !== realpathSync(state.directory))
    throw Error('This host already belongs to another Outpost installation.')
  return current
}
export function writeInstallation(c: Configuration) {
  const record = { ...c, generation: generation(), home: realpathSync(state.directory) }
  writeJson(file(), record)
  if (c.mode !== 'unpaired') removeLegacyBindings()
  return record
}
export const installationLock = <T>(action: () => Promise<T> | T) => locked('ownership', action, 15000, directory())
export const runtimeLock = <T>(action: () => Promise<T> | T, timeout = 300) =>
  locked('connector', action, timeout, directory())
function legacy() {
  return readJson<Omit<RelayInstall, 'mode'> | null>(statePath('connector.json'), null)
}
export async function requireUnpaired() {
  const current = installation()
  if ((current && current.mode !== 'unpaired') || legacy())
    throw Error(
      'This machine already has an owner. Stop its Outpost service and run outpost-terminal unpair before changing servers.',
    )
  if (current?.mode === 'unpaired') {
    await runtimeLock(() => {})
    await nodeLock(() => {}, 300)
  }
  await checkLegacyNodes()
}
export function loadInstalled() {
  return installationLock(async () => {
    const current = installation()
    if (current) return current
    const old = legacy()
    if (!old) return null
    await checkLegacyNodes()
    const migrated = writeInstallation({ ...old, mode: 'relay' })
    rmSync(statePath('connector.json'), { force: true })
    return migrated
  })
}
export function validateDirect(value: unknown): DirectInstall {
  const c = value as DirectInstall
  if (
    !c ||
    typeof c.targetId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(c.targetId) ||
    typeof c.publicKey !== 'string' ||
    c.publicKey.length > 128
  )
    throw Error('Invalid direct installation.')
  new DirectTickets(c.publicKey, c.targetId)
  return {
    mode: 'direct',
    origin: desktopOrigin(c.origin),
    endpoint: desktopOrigin(c.endpoint),
    targetId: c.targetId,
    publicKey: c.publicKey,
  }
}
function removeLegacyBindings() {
  const path = statePath('bindings')
  if (!existsSync(path) || !lstatSync(path).isDirectory()) return
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isFile() && /^[a-f0-9-]{36}\.json$/.test(entry.name)) rmSync(join(path, entry.name))
  }
  if (!readdirSync(path).length) rmdirSync(path)
}
export const nodeLock = <T>(action: () => Promise<T> | T, timeout = 5000) =>
  locked('node-runtime', action, timeout, directory())
async function removableExecutable() {
  const path = statePath('bin', 'outpost-terminal')
  if (!existsSync(path) || !lstatSync(path).isFile() || realpathSync(process.execPath) !== realpathSync(path))
    throw Error(
      'Run uninstall from the installed ~/.outpost/bin/outpost-terminal. For a separately packaged executable, unpair it and remove it with its installer.',
    )
  for (const { id } of readRegistry().sessions) {
    const { terminal, chat } = await driverStatus(id)
    if (terminal || chat)
      throw Error('Stop running Outpost sessions before uninstalling. The executable and session files have been kept.')
  }
  return path
}
export async function unpair(removeExecutable = false) {
  const previous = await installationLock(async () => {
    const previous = installation() ?? legacy()
    if (removeExecutable) await removableExecutable()
    writeInstallation({ mode: 'unpaired' })
    rmSync(statePath('connector.json'), { force: true })
    // Pinning the ownership lock here prevents a new install during teardown.
    await runtimeLock(() => {}, 10000)
    await nodeLock(() => {}, 10000)
    await checkLegacyNodes()
    removeLegacyBindings()
    if (removeExecutable) rmSync(await removableExecutable())
    return previous
  })
  if (previous && 'credential' in previous) {
    try {
      const r = await fetch(desktopOrigin(previous.origin) + '/api/paired/revoke', {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + previous.credential, 'x-outpost-request': '1' },
        signal: AbortSignal.timeout(5000),
      })
      if (!r.ok && r.status !== 401) throw Error()
    } catch {
      console.error('Local credential removed. Remove the target in the old workspace to revoke its server credential.')
    }
  }
  if (removeExecutable) console.log('Removed the managed Outpost Terminal executable.')
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
export async function authorizeNode(socket: string) {
  return installationLock(async () => {
    const current = installation()
    if (!current) {
      if (legacy()) throw Error('Start the paired connector to migrate this installation first.')
      await checkLegacyNodes()
      return writeInstallation({ mode: 'ssh', socket })
    }
    if ((current.mode === 'ssh' || current.mode === 'relay') && current.socket === socket) return current
    throw Error('This node does not belong to the installed Outpost server.')
  })
}

// Pre-ownership releases could leave several nodes accepting agent requests.
async function checkLegacyNodes() {
  const dir = statePath('run')
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isSocket() || !/^node-[0-9a-f]{32}\.sock$/.test(entry.name)) continue
    const path = join(dir, entry.name)
    const inode = lstatSync(path).ino
    const active = await new Promise<boolean>(resolve => {
      const peer = connect(path)
      peer.setTimeout(500)
      peer.on('connect', () => {
        peer.destroy()
        resolve(true)
      })
      peer.on('timeout', () => {
        peer.destroy()
        resolve(true)
      })
      peer.on('error', (e: NodeJS.ErrnoException) => resolve(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT'))
    })
    if (active) throw Error('Stop the previous Outpost node or connector before changing machine ownership.')
    if (existsSync(path) && lstatSync(path).ino === inode) rmSync(path, { force: true })
  }
}

export async function installManaged(socket: string) {
  if (!/^run\/node-[0-9a-f]{32}\.sock$/.test(socket)) throw Error('Invalid managed installation identity.')
  await installationLock(async () => {
    const current = installation()
    if (current?.mode === 'ssh' && current.socket === socket) return
    await requireUnpaired()
    writeInstallation({ mode: 'ssh', socket })
  })
}
export async function pinRelaySocket(pair: RelayInstall, socket: string) {
  await installationLock(() => {
    const current = installation()
    if (
      current?.mode !== 'relay' ||
      current.credential !== pair.credential ||
      (current.socket && current.socket !== socket)
    )
      throw Error('Relay ownership changed.')
    writeJson(file(), { ...current, socket })
    pair.socket = socket
  })
}
