// Bun runtime entrypoint for the experimental interactive SSH bridge (`ssh-shell` and `ssh-wrap`).
// Pure Node-compatible logic lives in `machine/sshBridgeCore.ts`.
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { isHarnessId } from '../shared/harnesses'
import { imageExtensions } from '../shared/images'
import { formatProgramStatusReport } from '../shared/programStatus'
import { encodeSshBridgeOsc, SshBridgeOscScanner, type SshRemoteMessage } from '../shared/sshBridgeProtocol'
import { saveImageInDirectory } from './files'
import { harness } from './harnesses'
import { installation } from './installation'
import {
  buildShellInitFiles,
  installSshHelpers,
  prepareSshWrapLaunch,
  resolveRealExecutable,
  sshBinDir,
  sshBridgeEnabled,
  SshImageReceiver,
  sshInitDir,
  writeIfChanged,
} from './sshBridgeCore'
import { machineExecutable, state, statePath } from './state'
import { openTerminalClipboard } from './terminalClipboard'

function spawnPassthrough(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise(resolveExit => {
    const child = spawn(executable, args, { cwd, env, stdio: 'inherit' })
    child.on('error', error => {
      process.stderr.write(`outpost: ${(error as Error).message}\n`)
      resolveExit(127)
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        try {
          process.kill(process.pid, signal)
        } catch {
          /* Best effort signal propagation. */
        }
        resolveExit(128)
      } else {
        resolveExit(code ?? 0)
      }
    })
  })
}

/** Launch the user's real login shell with Outpost SSH harness wrappers activated. */
export async function runSshShell(initialCwd: string) {
  const shell = process.env.SHELL || '/bin/sh'
  if (!sshBridgeEnabled()) {
    process.exitCode = await spawnPassthrough(shell, ['-l'], initialCwd, process.env)
    return
  }
  mkdirSync(state.directory, { recursive: true, mode: 0o700 })
  installSshHelpers()
  const initDir = sshInitDir()
  const files = buildShellInitFiles(machineExecutable(), sshBinDir())
  for (const [rel, content] of Object.entries(files)) {
    writeIfChanged(join(initDir, rel), content, 0o600)
  }

  const name = basename(shell)
  const env: NodeJS.ProcessEnv = { ...process.env, OUTPOST_SSH_BRIDGE: '1' }
  let args: string[]
  if (name === 'bash') {
    args = ['--rcfile', join(initDir, 'bash.rc'), '-i']
  } else if (name === 'zsh') {
    if (process.env.ZDOTDIR) env.OUTPOST_ORIG_ZDOTDIR = process.env.ZDOTDIR
    env.ZDOTDIR = join(initDir, 'zsh')
    args = ['-l']
  } else if (name === 'fish') {
    const existingXdg = process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'
    env.XDG_DATA_DIRS = `${initDir}:${existingXdg}`
    args = ['-l']
  } else {
    env.PATH = `${sshBinDir()}${delimiter}${process.env.PATH ?? ''}`
    args = ['-l']
  }
  process.exitCode = await spawnPassthrough(shell, args, initialCwd, env)
}

/** Wrap one manually invoked coding harness inside an interactive SSH session. */
export async function runSshWrap(toolArg: string | undefined, userArgs: string[], initialCwd: string) {
  if (!toolArg || !isHarnessId(toolArg)) {
    throw new Error('Usage: outpost ssh-wrap <tool> [ARGS...]')
  }
  const adapter = harness(toolArg)
  const { executable, cleanPath } = resolveRealExecutable(adapter.command, process.env.PATH ?? '', [sshBinDir()])
  if (!executable) {
    process.stderr.write(`${adapter.command}: command not found\n`)
    process.exitCode = 127
    return
  }

  const bypassEnv: NodeJS.ProcessEnv = { ...process.env, PATH: cleanPath }
  const shouldBypass =
    !sshBridgeEnabled() ||
    Boolean(process.env.OUTPOST_SSH_WRAP_ACTIVE) ||
    Boolean(process.env.OUTPOST_SESSION_ID) ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    !adapter.isInteractiveInvocation(userArgs)

  if (shouldBypass) {
    process.exitCode = await spawnPassthrough(executable, userArgs, initialCwd, bypassEnv)
    return
  }

  mkdirSync(state.directory, { recursive: true, mode: 0o700 })
  let enrolled = false
  try {
    enrolled = Boolean(installation())
  } catch {
    /* Unenrolled or unreadable ownership record. */
  }
  const { argv, env: agentEnv } = await prepareSshWrapLaunch(toolArg, userArgs, initialCwd, process.env, {
    enrolled,
    executable,
    cleanPath,
  })

  const writeOuter = (data: string | Buffer) => {
    if (!process.stdout.destroyed && process.stdout.writable) process.stdout.write(data)
  }
  const sendBridge = (message: SshRemoteMessage) => writeOuter(encodeSshBridgeOsc(message, 'bel'))

  const clipboard = adapter.definition.clipboard
    ? await openTerminalClipboard(agentEnv, osc52 => writeOuter(osc52))
    : null
  if (clipboard) {
    Object.assign(agentEnv, {
      DISPLAY: clipboard.display,
      XAUTHORITY: clipboard.authority,
      XDG_SESSION_TYPE: 'x11',
      GDK_BACKEND: 'x11',
    })
    delete agentEnv.WAYLAND_DISPLAY
    delete agentEnv.WAYLAND_SOCKET
  }

  const sessionNonce = randomUUID().replace(/-/g, '')
  let childExited = false
  let bracketedPaste = false
  const cols = Math.max(2, Math.min(400, process.stdout.columns || 80))
  const rows = Math.max(2, Math.min(200, process.stdout.rows || 24))

  const pty = new Bun.Terminal({
    cols,
    rows,
    data(_terminal, data) {
      const chunk = Buffer.from(data)
      // Track bracketed paste mode toggles without instantiating a headless VT emulator.
      const text = chunk.toString('latin1')
      const onIdx = text.lastIndexOf('\x1b[?2004h')
      const offIdx = text.lastIndexOf('\x1b[?2004l')
      if (onIdx > offIdx) bracketedPaste = true
      else if (offIdx > onIdx) bracketedPaste = false
      writeOuter(chunk)
    },
  })

  const writePty = (data: string | Uint8Array) => {
    if (!childExited && !pty.closed) pty.write(data)
  }

  const receiver = new SshImageReceiver(sessionNonce, sendBridge, {
    exited: () => childExited,
    clipboard,
    sendKey: () => writePty('\x16'),
    pastePath: image => {
      const path = saveImageInDirectory(statePath('clipboard', 'ssh'), imageExtensions[image.mime], image.bytes)
      writePty(bracketedPaste ? `\x1b[200~${path}\x1b[201~` : path)
    },
  })

  const scanner = new SshBridgeOscScanner()
  let escTimer: ReturnType<typeof setTimeout> | undefined
  const clearEscTimer = () => {
    if (escTimer) {
      clearTimeout(escTimer)
      escTimer = undefined
    }
  }

  const onStdin = (chunk: Buffer) => {
    clearEscTimer()
    const { passthrough, messages } = scanner.scan(chunk)
    if (passthrough.length) writePty(passthrough)
    for (const msg of messages) {
      if (msg.t === 'img.begin' || msg.t === 'img.data' || msg.t === 'img.cancel') receiver.handle(msg)
    }
    if (scanner.hasPendingEsc) {
      escTimer = setTimeout(() => {
        escTimer = undefined
        const esc = scanner.flushPendingEsc()
        if (esc) writePty(esc)
      }, 25)
    }
  }

  const onResize = () => {
    if (childExited || pty.closed) return
    const nextCols = Math.max(2, Math.min(400, process.stdout.columns || 80))
    const nextRows = Math.max(2, Math.min(200, process.stdout.rows || 24))
    pty.resize(nextCols, nextRows)
  }

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    clearEscTimer()
    process.stdin.off('data', onStdin)
    process.stdout.off('resize', onResize)
    try {
      process.stdin.setRawMode(false)
    } catch {
      /* Already restored or not a TTY. */
    }
    process.stdin.pause()
    receiver.close()
    clipboard?.close()
    try {
      pty.close()
    } catch {
      /* Already closed. */
    }
    // Always clear wrapper capability and any latched OSC 7501 status when returning to the shell.
    sendBridge({ v: 1, t: 'bye', session: sessionNonce })
    writeOuter(formatProgramStatusReport({ state: 'clear' }, 'st'))
  }

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', onStdin)
  process.stdout.on('resize', onResize)

  sendBridge({ v: 1, t: 'ready', session: sessionNonce, tool: adapter.id, clipboard: Boolean(clipboard) })

  const child = Bun.spawn([executable, ...argv], {
    cwd: initialCwd,
    env: agentEnv,
    terminal: pty,
  })

  const forwardSignal = (sig: NodeJS.Signals) => {
    try {
      child.kill(sig)
    } catch {
      /* Already exited. */
    }
  }
  const onSigTerm = () => forwardSignal('SIGTERM')
  const onSigHup = () => forwardSignal('SIGHUP')
  process.on('SIGTERM', onSigTerm)
  process.on('SIGHUP', onSigHup)

  try {
    const exitCode = await child.exited
    childExited = true
    process.exitCode = exitCode
  } finally {
    process.off('SIGTERM', onSigTerm)
    process.off('SIGHUP', onSigHup)
    cleanup()
  }
}
