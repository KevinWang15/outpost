// Pure Node-compatible core of the experimental interactive SSH bridge.
// Kept free of Bun-only APIs so unit tests and `machine/launch.ts` / `machine/node.ts`
// import it cleanly without pulling Bun PTY/clipboard bindings into Node.
import { mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { isHarnessId } from '../shared/harnesses'
import { quote } from '../shared/shell'
import {
  encodeSshBridgeOsc,
  SSH_BRIDGE_ENABLED,
  SSH_IMAGE_CHUNK_BYTES,
  type SshDesktopMessage,
  type SshRemoteMessage,
} from '../shared/sshBridgeProtocol'
import { allHarnesses, harness } from './harnesses'
import type { McpStdioServer } from './harnesses/harness'
import { which } from './launch'
import { machineExecutable, state, statePath, writeFile } from './state'
import { pasteTerminalImage, type TerminalClipboard } from './terminalFileRequests'
import { TerminalImages, type TerminalImage } from './terminalImages'

export { SSH_BRIDGE_ENABLED }

export const sshBridgeEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  SSH_BRIDGE_ENABLED && env.OUTPOST_DISABLE_SSH_BRIDGE !== '1'

export const sshBinDir = () => statePath('ssh-bin')
export const sshInitDir = () => statePath('ssh-init')
export const sshShellLauncher = () => statePath('bin', 'ssh-shell')

export function writeIfChanged(path: string, content: string, mode = 0o700) {
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch {
    /* Missing or unreadable. */
  }
  writeFile(path, content, mode)
}

function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return resolve(dir)
  }
}

/** Strip wrapper directories (raw and canonical) from PATH before resolving the real binary.
 * Prevents any possibility of infinite recursion when `ssh-wrap` invokes the real harness. */
export function resolveRealExecutable(
  command: string,
  pathEnv: string,
  excludedDirs: readonly string[],
): { executable: string | null; cleanPath: string } {
  const excluded = new Set<string>()
  for (const dir of excludedDirs) {
    excluded.add(resolve(dir))
    excluded.add(canonicalDir(dir))
  }
  const cleanEntries = pathEnv
    .split(delimiter)
    .filter(Boolean)
    .filter(entry => !excluded.has(resolve(entry)) && !excluded.has(canonicalDir(entry)))
  const cleanPath = cleanEntries.join(delimiter)
  return { executable: which(command, cleanPath), cleanPath }
}

function terminalHarnesses() {
  return allHarnesses().filter(adapter => adapter.terminal)
}

/** Install (or remove when disabled) `~/.outpost/bin/ssh-shell` and `~/.outpost/ssh-bin/*`. */
export function installSshHelpers() {
  if (!SSH_BRIDGE_ENABLED) {
    rmSync(sshShellLauncher(), { force: true })
    rmSync(sshBinDir(), { recursive: true, force: true })
    rmSync(sshInitDir(), { recursive: true, force: true })
    return
  }
  mkdirSync(state.directory, { recursive: true, mode: 0o700 })
  const executable = machineExecutable()
  writeIfChanged(sshShellLauncher(), `#!/bin/sh\nexec ${quote(executable)} ssh-shell "$@"\n`, 0o700)
  for (const adapter of terminalHarnesses()) {
    const shim = `#!/bin/sh\nexec ${quote(executable)} ssh-wrap ${quote(adapter.id)} "$@"\n`
    writeIfChanged(join(sshBinDir(), adapter.command), shim, 0o700)
  }
}

/** Build deterministic per-shell post-rc init files that run AFTER user dotfiles. */
export function buildShellInitFiles(executable: string, binDir: string): Record<string, string> {
  const shellOsc = encodeSshBridgeOsc({ v: 1, t: 'shell' }, 'bel')
  const quotedExec = quote(executable)
  const quotedBin = quote(binDir)
  // `function <name> { ... }` avoids alias expansion on the function name in both Bash and Zsh
  // while allowing existing user aliases like `alias claude='claude --dangerously-skip-permissions'`
  // to expand cleanly into our wrapper function.
  const posixFunctions = terminalHarnesses()
    .map(adapter => `function ${adapter.command} {\n  ${quotedExec} ssh-wrap ${quote(adapter.id)} "$@"\n}`)
    .join('\n')
  const fishFunctions = terminalHarnesses()
    .map(
      adapter =>
        `function ${adapter.command} --wraps ${adapter.command}\n  ${quotedExec} ssh-wrap ${quote(adapter.id)} $argv\nend`,
    )
    .join('\n')

  const pathPrependPosix = [
    `case ":\${PATH:-}:" in`,
    `  *:${quotedBin}:*) ;;`,
    `  *) export PATH=${quotedBin}\${PATH:+":$PATH"} ;;`,
    `esac`,
  ].join('\n')

  // Bash login sequence: /etc/profile -> first of (~/.bash_profile, ~/.bash_login, ~/.profile),
  // falling back to ~/.bashrc only if no login profile exists. Then activate Outpost wrappers.
  const bashRc = [
    'export OUTPOST_SSH_BRIDGE=1',
    '[ -r /etc/profile ] && . /etc/profile',
    'if [ -r "$HOME/.bash_profile" ]; then',
    '  . "$HOME/.bash_profile"',
    'elif [ -r "$HOME/.bash_login" ]; then',
    '  . "$HOME/.bash_login"',
    'elif [ -r "$HOME/.profile" ]; then',
    '  . "$HOME/.profile"',
    'elif [ -r "$HOME/.bashrc" ]; then',
    '  . "$HOME/.bashrc"',
    'fi',
    pathPrependPosix,
    posixFunctions,
    '__outpost_ssh_prompt() {',
    `  [ -t 1 ] && printf '%s' ${quote(shellOsc)}`,
    '}',
    'if [ "${BASH_VERSINFO[0]:-0}" -ge 5 ] && declare -p PROMPT_COMMAND 2>/dev/null | grep -q "declare -a"; then',
    '  PROMPT_COMMAND+=(__outpost_ssh_prompt)',
    'elif [ -n "${PROMPT_COMMAND:-}" ]; then',
    '  PROMPT_COMMAND="__outpost_ssh_prompt; $PROMPT_COMMAND"',
    'else',
    '  PROMPT_COMMAND="__outpost_ssh_prompt"',
    'fi',
    '',
  ].join('\n')

  // Zsh trampoline via ZDOTDIR: immediately restore the user's ZDOTDIR while sourcing each file.
  const zshZshenv = [
    'export OUTPOST_SSH_BRIDGE=1',
    '__outpost_zdotdir="${OUTPOST_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -r "$__outpost_zdotdir/.zshenv" ]; then',
    '  ZDOTDIR="$__outpost_zdotdir" . "$__outpost_zdotdir/.zshenv"',
    'fi',
    '',
  ].join('\n')
  const zshZprofile = [
    '__outpost_zdotdir="${OUTPOST_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -r "$__outpost_zdotdir/.zprofile" ]; then',
    '  ZDOTDIR="$__outpost_zdotdir" . "$__outpost_zdotdir/.zprofile"',
    'fi',
    '',
  ].join('\n')
  const zshZshrc = [
    '__outpost_zdotdir="${OUTPOST_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -r "$__outpost_zdotdir/.zshrc" ]; then',
    '  ZDOTDIR="$__outpost_zdotdir" . "$__outpost_zdotdir/.zshrc"',
    'fi',
    pathPrependPosix,
    posixFunctions,
    '__outpost_ssh_prompt() {',
    `  [ -t 1 ] && printf '%s' ${quote(shellOsc)}`,
    '}',
    'precmd_functions+=(__outpost_ssh_prompt)',
    '',
  ].join('\n')
  const zshZlogin = [
    '__outpost_zdotdir="${OUTPOST_ORIG_ZDOTDIR:-$HOME}"',
    'if [ -n "${OUTPOST_ORIG_ZDOTDIR:-}" ]; then',
    '  export ZDOTDIR="$OUTPOST_ORIG_ZDOTDIR"',
    'else',
    '  unset ZDOTDIR',
    'fi',
    'unset OUTPOST_ORIG_ZDOTDIR',
    'if [ -r "$__outpost_zdotdir/.zlogin" ]; then',
    '  . "$__outpost_zdotdir/.zlogin"',
    'fi',
    'unset __outpost_zdotdir',
    '',
  ].join('\n')

  const fishConf = [
    'set -gx OUTPOST_SSH_BRIDGE 1',
    `fish_add_path -p ${quote(binDir)}`,
    fishFunctions,
    'function __outpost_ssh_prompt --on-event fish_prompt',
    `  if isatty stdout; printf '%s' ${quote(shellOsc)}; end`,
    'end',
    '',
  ].join('\n')

  return {
    'bash.rc': bashRc,
    'zsh/.zshenv': zshZshenv,
    'zsh/.zprofile': zshZprofile,
    'zsh/.zshrc': zshZshrc,
    'zsh/.zlogin': zshZlogin,
    'fish/vendor_conf.d/outpost-ssh.fish': fishConf,
  }
}

/** Receives chunked SSH bridge image paste frames and executes the unified `pasteTerminalImage` pipeline. */
export class SshImageReceiver {
  private images = new TerminalImages()
  private lifetime = new AbortController()
  private activePaste?: { id: string; abort: AbortController }
  private active?: {
    id: string
    mime: string
    size: number
    mode: 'attachment' | 'path'
    offset: number
  }

  constructor(
    private sessionNonce: string,
    private send: (message: SshRemoteMessage) => void,
    private options: {
      exited: () => boolean
      clipboard: TerminalClipboard | null
      sendKey: () => void
      pastePath: (image: TerminalImage) => void
    },
  ) {}

  close() {
    this.lifetime.abort()
    this.activePaste?.abort.abort()
    this.activePaste = undefined
    this.images.close()
    this.active = undefined
  }

  handle(message: SshDesktopMessage) {
    if (message.t === 'img.cancel') {
      if (this.active?.id === message.id) {
        this.active = undefined
        this.images.close()
      }
      if (this.activePaste?.id === message.id) {
        this.activePaste.abort.abort()
        this.activePaste = undefined
      }
      return
    }
    if (message.t === 'img.begin') {
      if (message.session !== this.sessionNonce) return
      this.activePaste?.abort.abort()
      this.activePaste = undefined
      this.images.close()
      this.active = {
        id: message.id,
        mime: message.mime,
        size: message.size,
        mode: message.mode,
        offset: 0,
      }
      this.send({ v: 1, t: 'img.ack', id: message.id, next: 0, chunkSize: SSH_IMAGE_CHUNK_BYTES })
      return
    }
    if (message.t === 'img.data') {
      const active = this.active
      if (!active || active.id !== message.id) return
      if (message.offset !== active.offset) {
        this.active = undefined
        this.images.close()
        this.send({ v: 1, t: 'img.done', id: message.id, ok: false, message: 'Image transfer out of order.' })
        return
      }
      try {
        const chunk = Buffer.from(message.data, 'base64')
        this.images.writeBytes(active.id, active.mime, active.size, message.offset, chunk)
        active.offset += chunk.length
        this.send({ v: 1, t: 'img.ack', id: active.id, next: active.offset })
        if (active.offset === active.size) {
          const { id, mode } = active
          this.active = undefined
          const pasteAbort = new AbortController()
          this.activePaste = { id, abort: pasteAbort }
          const signal = AbortSignal.any([this.lifetime.signal, pasteAbort.signal])
          void this.images
            .paste(id, image =>
              pasteTerminalImage(image, mode, signal, {
                exited: this.options.exited,
                held: () => false,
                clipboard: this.options.clipboard,
                sendKey: this.options.sendKey,
                pastePath: this.options.pastePath,
              }),
            )
            .then(
              usedMode => {
                if (this.activePaste?.id === id) this.activePaste = undefined
                this.send({ v: 1, t: 'img.done', id, ok: true, mode: usedMode })
              },
              error => {
                if (this.activePaste?.id === id) this.activePaste = undefined
                if (pasteAbort.signal.aborted) return
                this.send({
                  v: 1,
                  t: 'img.done',
                  id,
                  ok: false,
                  message: (error as Error).message || 'Image paste failed.',
                })
              },
            )
        }
      } catch (error) {
        this.active = undefined
        this.images.close()
        this.send({
          v: 1,
          t: 'img.done',
          id: active.id,
          ok: false,
          message: (error as Error).message || 'Invalid image chunk.',
        })
      }
    }
  }
}

/** Build the launch environment and argv for a wrapped interactive harness invocation. */
export async function prepareSshWrapLaunch(
  toolId: string,
  userArgs: readonly string[],
  initialCwd: string,
  baseEnv: Record<string, string | undefined>,
  options: { enrolled: boolean; executable: string; cleanPath: string },
): Promise<{ argv: string[]; env: Record<string, string> }> {
  if (!isHarnessId(toolId)) throw new Error(`Unknown coding tool: ${toolId}`)
  const adapter = harness(toolId)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) env[key] = value
  env.PATH = options.cleanPath
  env.OUTPOST_SSH_WRAP_ACTIVE = adapter.id
  env.TERM = env.TERM || 'xterm-256color'
  env.COLORTERM = 'truecolor'

  let argv = [...userArgs]
  if (options.enrolled) {
    delete env.OUTPOST_SESSION_ID
    env.OUTPOST_DRIVER = 'ssh'
    env.OUTPOST_STATE_DIRECTORY = state.directory
    const outpostServer: McpStdioServer = {
      name: 'outpost',
      command: machineExecutable(),
      args: ['mcp'],
      env: {
        OUTPOST_DRIVER: 'ssh',
        OUTPOST_STATE_DIRECTORY: state.directory,
      },
    }
    try {
      argv = await adapter.attachStandaloneMcp(env, initialCwd, outpostServer, [machineExecutable(), 'hook'], userArgs)
    } catch {
      // Never block launching the user's coding tool if optional MCP preparation fails.
      argv = [...userArgs]
    }
  }
  return { argv, env }
}
