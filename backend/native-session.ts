import { homedir } from 'node:os'
import { join } from 'node:path'
import headless from '@xterm/headless'
import type { Command } from './process'
import type { SessionImage, SessionImageInput } from '../shared/session-manager'
import type { NativeClipboard } from './native-clipboard'
import { NativeInput } from './native-input'
import { NativePaste } from './native-paste'
import { disconnectedBanner, terminalReset } from './terminal'
import { terminalPaste } from '../shared/terminal-paste'

// node-pty is optional on hosted/Linux installations. Keep the small bridge
// contract here so those installations can typecheck without native bindings.
export interface NativePty {
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}
export interface NativePtyModule {
  spawn(executable: string, args: string[], options: { cols: number; rows: number; name: string; env: NodeJS.ProcessEnv; cwd: string }): NativePty
}

export async function loadNativePty(): Promise<NativePtyModule> {
  const packageName = 'node-pty'
  try { return await import(packageName) }
  catch { throw new Error('Native clipboard support requires node-pty. Run npm ci including optional dependencies, or use Copy command to connect.') }
}

// eslint-disable-next-line no-control-regex -- Keep terminal controls out of status messages.
const cleanMessage = (message: string) => message.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1500)

export async function nativeSession(command: Command, options: {
  pty: NativePtyModule
  readClipboard: (signal: AbortSignal) => Promise<NativeClipboard>
  upload: (image: SessionImageInput, signal: AbortSignal) => Promise<SessionImage>
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
}): Promise<number> {
  const input = options.input ?? process.stdin, output = options.output ?? process.stdout
  if (!input.isTTY || !output.isTTY) throw new Error('Run this command in an interactive terminal.')
  const wasRaw = input.isRaw
  const size = () => ({ cols: Math.max(2, output.columns || 80), rows: Math.max(2, output.rows || 24) })
  type Connection = { pty: NativePty; screen: InstanceType<typeof headless.Terminal>; dispose(): void }
  let connection: Connection | null = null, stopped = false
  const status = (message: string) => { if (!stopped) output.write(`\r\n[Outpost] ${cleanMessage(message)}\r\n`) }
  const paste = new NativePaste<Connection>({
    connection: () => connection,
    read: options.readClipboard, upload: options.upload, status,
    insert: (active, text) => active.pty.write(terminalPaste(text, active.screen.modes.bracketedPasteMode)),
  })
  const keys = new NativeInput(data => connection?.pty.write(data), retry => { void paste.paste(retry) })
  const args = command.args.map(arg => command.expandHome && /^~[/\\]/.test(arg) ? join(homedir(), arg.slice(2)) : arg)
  return new Promise<number>(resolve => {
    const disconnected = (message?: string) => {
      output.write(terminalReset)
      if (message) status(message)
      output.write(`\r\n${disconnectedBanner}\r\n`)
    }
    const start = () => {
      if (stopped || connection) return
      keys.reset()
      status('Connecting. F8 pastes your local clipboard; Shift+F8 retries a failed paste. Detach with Ctrl-\\.')
      try {
        const dimensions = size()
        const name = process.env.TERM && process.env.TERM !== 'dumb' ? process.env.TERM : 'xterm-256color'
        const pty = options.pty.spawn(command.executable, args, {
          ...dimensions, name, env: { ...process.env, TERM: name }, cwd: process.cwd(),
        })
        // Only track negotiated paste mode. Terminal replies come from the real
        // terminal emulator; the shadow parser must never write back to the PTY.
        const screen = new headless.Terminal({ ...dimensions, scrollback: 0, allowProposedApi: true, logLevel: 'off' })
        const active: Connection = { pty, screen, dispose: () => { data.dispose(); exit.dispose(); screen.dispose() } }
        connection = active
        const data = pty.onData(text => {
          if (connection !== active) return
          screen.write(text)
          if (!output.write(text)) pty.pause()
        })
        const exit = pty.onExit(({ exitCode }) => {
          if (connection !== active) return
          connection = null; keys.reset(); active.dispose()
          // ConPTY owns a worker even after the attached process exits. Release
          // it before reconnecting or it keeps the Node process alive on Windows.
          if (process.platform === 'win32') pty.kill()
          disconnected(exitCode ? `${command.label} exited with code ${exitCode}.` : undefined)
        })
      } catch (error) { disconnected((error as Error).message) }
    }
    const finish = (code: number, restoreOutput = true) => {
      if (stopped) return
      stopped = true
      paste.dispose(); keys.reset()
      const active = connection; connection = null
      if (active) { active.dispose(); try { active.pty.kill() } catch { /* Already exited. */ } }
      input.off('data', onInput); input.off('end', onEnd); input.off('error', onError)
      output.off('resize', resize); output.off('drain', drain); output.off('error', onError)
      process.off('SIGTERM', terminate); process.off('SIGHUP', hangup); process.off('SIGINT', interrupt)
      input.pause()
      try { input.setRawMode(wasRaw) } catch { /* The terminal may have closed. */ }
      if (restoreOutput && !output.destroyed) output.write(terminalReset)
      resolve(code)
    }
    const onInput = (data: string) => {
      if (connection) keys.push(data)
      else if (data.includes('\x03')) finish(0)
      else if (data.includes('\r') || data.includes('\n')) start()
    }
    const resize = () => {
      if (connection) {
        const { cols, rows } = size()
        try { connection.pty.resize(cols, rows); connection.screen.resize(cols, rows) }
        catch { /* An exit can race the resize event. */ }
      }
    }
    const drain = () => connection?.pty.resume()
    const terminate = () => finish(143), hangup = () => finish(129), interrupt = () => finish(130)
    const onEnd = () => finish(0), onError = () => finish(1, false)
    try {
      input.setEncoding('utf8'); input.setRawMode(true)
      input.on('data', onInput); input.once('end', onEnd); input.once('error', onError)
      output.on('resize', resize); output.on('drain', drain); output.once('error', onError)
      process.on('SIGTERM', terminate); process.on('SIGHUP', hangup); process.on('SIGINT', interrupt)
      input.resume(); start()
    } catch (error) { status((error as Error).message); finish(1) }
  })
}
