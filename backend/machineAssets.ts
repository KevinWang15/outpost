import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SoftwareId } from '../shared/model'
import { terminalService } from '../shared/terminalService'
import { AppError } from './errors'

const platformPattern = /^(x64|arm64)-(glibc|musl)$/
export function platformName(value: string) {
  if (!platformPattern.test(value)) throw new AppError('Unsupported Linux machine architecture or libc.', 400)
  return value
}
interface Asset {
  path: string
  sha256: string
}
function checksum(manifest: string, name: string) {
  const matches = manifest
    .split(/\r?\n/)
    .map(line => /^([a-f0-9]{64}) [ *](\S+)$/.exec(line))
    .filter(row => row?.[2] === name)
  if (matches.length !== 1) throw new AppError(`Expected one SHA-256 checksum for ${name}.`, 502)
  return matches[0]![1]
}

/** Only the four immutable service builds are public. Operator-provided tool
 * packages are private to the server and travel to selected machines over SSH. */
export class MachineAssets {
  private pending = new Map<string, Promise<Asset>>()
  constructor(
    private directory: string,
    private env: NodeJS.ProcessEnv = process.env,
  ) {}
  service(platform: string): Promise<Asset> {
    const file = 'outpost-terminal-linux-' + platformName(platform)
    const current = this.pending.get(file)
    if (current) return current
    const work = this.load(file).catch(error => {
      this.pending.delete(file)
      throw error
    })
    this.pending.set(file, work)
    return work
  }
  async approvedTool(platform: string, id: SoftwareId): Promise<Asset | null> {
    if (!this.env.OUTPOST_TOOL_ASSET_DIR) return null
    const dir = join(this.env.OUTPOST_TOOL_ASSET_DIR, platformName(platform))
    const file = id + '.tar.gz'
    try {
      return { path: join(dir, file), sha256: checksum(await readFile(join(dir, 'SHA256SUMS'), 'utf8'), file) }
    } catch {
      throw new AppError(`Supply ${platform}/${file} and its SHA256SUMS in OUTPOST_TOOL_ASSET_DIR.`, 409)
    }
  }
  private async load(file: string): Promise<Asset> {
    const local = this.env.OUTPOST_TERMINAL_ASSET_DIR
    const base =
      this.env.OUTPOST_TERMINAL_RELEASE_BASE ??
      `https://github.com/${terminalService.repository}/releases/download/terminal-v${terminalService.version}`
    const remote = async (name: string) => {
      if (new URL(base).protocol !== 'https:') throw new AppError('Machine release downloads require HTTPS.', 502)
      const response = await fetch(base.replace(/\/$/, '') + '/' + name, { signal: AbortSignal.timeout(300_000) })
      if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:')
        throw new AppError(`Could not obtain ${name} from the machine release (HTTP ${response.status}).`, 502)
      return response
    }
    let manifest = ''
    if (local) manifest = await readFile(join(local, 'SHA256SUMS'), 'utf8')
    else {
      const { body } = await remote('SHA256SUMS')
      for await (const chunk of body!) {
        manifest += Buffer.from(chunk).toString('ascii')
        if (manifest.length > 64 * 1024)
          throw new AppError('Machine release checksum manifest exceeds the size limit.', 502)
      }
    }
    const sha256 = checksum(manifest, file)
    const dir = join(this.directory, 'machine-releases', terminalService.version)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const path = join(dir, sha256)
    if ((await stat(path).catch(() => null))?.isFile()) {
      const existing = createHash('sha256')
      for await (const bytes of createReadStream(path)) existing.update(bytes)
      if (existing.digest('hex') === sha256) return { path, sha256 }
    }
    const temp = join(dir, randomUUID() + '.tmp')
    try {
      const input = local ? createReadStream(join(local, file)) : (await remote(file)).body!
      const hash = createHash('sha256')
      let bytes = 0
      const verify = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          if (bytes > 192 * 1024 * 1024) {
            callback(new Error('Machine release exceeds size limit.'))
            return
          }
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(input, verify, createWriteStream(temp, { mode: 0o600, flags: 'wx' }))
      if (hash.digest('hex') !== sha256) throw new AppError(`Checksum mismatch for ${file}.`, 502)
      await rename(temp, path)
      return { path, sha256 }
    } finally {
      await rm(temp, { force: true })
    }
  }
}
