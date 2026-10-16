import { spawn, type IPty } from 'node-pty'
import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { imageMediaTypes, maxImageBytes, type ImageMediaType } from '../../shared/model'
import { terminalSize } from '../../shared/terminalService'
import type { LocalTerminalEvent } from '../../shared/localTerminal'
import type { ShellProfile } from './shell-profiles'

const execute = promisify(execFile)
const highWater = 256 * 1024
const lowWater = 64 * 1024
const extensions: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** A local tab owns its PTY. Native pause/resume bounds unread output without
 * consuming Ctrl+S/Ctrl+Q; xterm acknowledges only output it has rendered. */
export class LocalTerminal {
  private pty?: IPty
  private generation = ''
  private pending = 0
  private paused = false
  private images = join(app.getPath('userData'), 'clipboard', randomUUID())
  private imageBusy = false
  private imageBytes = 0
  private disposed = false

  constructor(
    readonly profile: ShellProfile,
    private send: (event: LocalTerminalEvent) => void,
  ) {}

  get running() {
    return Boolean(this.pty)
  }

  start(generation: string, cols: number, rows: number) {
    if (this.disposed) throw new Error('This terminal tab has closed.')
    if (typeof generation !== 'string' || !/^[a-f0-9-]{36}$/.test(generation) || !terminalSize(cols, rows))
      throw new Error('Invalid local terminal request.')
    this.stop()
    this.generation = generation
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Outpost',
      TERM_PROGRAM_VERSION: app.getVersion(),
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ASAR
    const pty = spawn(this.profile.executable, this.profile.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: homedir(),
      env,
      // The bundled ConPTY closes its process tree without node-pty's legacy
      // child_process.fork helper, which requires Electron's disabled RunAsNode fuse.
      useConptyDll: process.platform === 'win32',
    })
    this.pty = pty
    this.send({ type: 'ready', generation, name: this.profile.name, cols, rows })
    pty.onData(data => {
      if (this.pty !== pty) return
      this.pending += data.length
      if (!this.paused && this.pending >= highWater) {
        this.paused = true
        pty.pause()
      }
      this.send({ type: 'data', generation, data })
    })
    pty.onExit(({ exitCode }) => {
      if (this.pty !== pty) return
      this.pty = undefined
      this.send({ type: 'exit', generation, code: exitCode })
    })
  }

  private current(generation: string) {
    if (generation !== this.generation || !this.pty) throw new Error('The local shell is no longer running.')
    return this.pty
  }

  write(generation: string, data: string | Uint8Array) {
    const pty = this.current(generation)
    if ((typeof data !== 'string' && !(data instanceof Uint8Array)) || Buffer.byteLength(data) > 1024 * 1024)
      throw new Error('Terminal input is limited to 1 MB.')
    pty.write(typeof data === 'string' ? data : Buffer.from(data))
  }

  resize(generation: string, cols: number, rows: number) {
    const pty = this.current(generation)
    if (!terminalSize(cols, rows)) throw new Error('Invalid terminal dimensions.')
    if (pty.cols === cols && pty.rows === rows) return
    // Geometry and redraw output travel over the same ordered IPC channel.
    this.send({ type: 'geometry', generation, cols, rows })
    pty.resize(cols, rows)
  }

  acknowledge(generation: string, length: number) {
    if (generation !== this.generation || !Number.isInteger(length) || length < 0 || length > this.pending) return
    this.pending -= length
    if (this.paused && this.pending <= lowWater) {
      this.paused = false
      this.pty?.resume()
    }
  }

  async pasteImage(generation: string, data: string, mediaType: ImageMediaType) {
    const pty = this.current(generation)
    if (this.imageBusy) throw new Error('Wait for the previous image to finish.')
    if (
      !(imageMediaTypes as readonly string[]).includes(mediaType) ||
      typeof data !== 'string' ||
      data.length > Math.ceil(maxImageBytes / 3) * 4
    )
      throw new Error('Images are limited to PNG, JPEG, GIF or WebP up to 16 MB.')
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length || bytes.length > maxImageBytes || this.imageBytes + bytes.length > 256 * 1024 * 1024)
      throw new Error('This tab has reached its image storage limit. Open another local tab.')
    this.imageBusy = true
    try {
      await mkdir(this.images, { recursive: true, mode: 0o700 })
      let path = join(this.images, `${randomUUID()}.${extensions[mediaType]}`)
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
      this.imageBytes += bytes.length
      if (this.profile.wsl) {
        const result = await execute(this.profile.executable, ['--exec', 'wslpath', '-u', path], {
          windowsHide: true,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        })
        path = result.stdout.trim()
        if (!path.startsWith('/')) throw new Error('Could not resolve the image path in WSL.')
      }
      if (this.current(generation) !== pty) throw new Error('The shell changed before the image was pasted.')
      const quoted =
        this.profile.syntax === 'powershell'
          ? `'${path.replaceAll("'", "''")}'`
          : this.profile.syntax === 'cmd'
            ? `"${path}"`
            : `'${path.replaceAll("'", "'\\''")}'`
      pty.write(quoted + ' ')
      return path
    } finally {
      this.imageBusy = false
      if (this.disposed) await rm(this.images, { recursive: true, force: true }).catch(() => {})
    }
  }

  stop(generation?: string) {
    if (generation !== undefined && generation !== this.generation) return
    const pty = this.pty
    this.pty = undefined
    this.generation = ''
    this.pending = 0
    this.paused = false
    try {
      pty?.kill()
    } catch {
      /* The shell may already have exited. */
    }
  }

  dispose() {
    this.disposed = true
    this.stop()
    void rm(this.images, { recursive: true, force: true }).catch(() => {})
  }
}
