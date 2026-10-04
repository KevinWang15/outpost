import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { terminalApps, terminalOS, type DesktopAvailability, type DesktopLaunchInput, type DesktopTerminal, type TerminalId } from '../shared/terminals'
import { AppError } from './errors'
import { quote } from './shell'

const execute = promisify(execFile)
const encodePowerShell = (script: string) => Buffer.from(script, 'utf16le').toString('base64')

export interface DesktopHost {
  platform: string
  env: NodeJS.ProcessEnv
  executable(name: string): Promise<string | null>
  application(name: string): Promise<string | null>
  query(executable: string, args: string[]): Promise<string>
  ownsConsole(): Promise<boolean>
  start(executable: string, args: string[], hidden?: boolean, waitForExit?: boolean): Promise<void>
}

export function desktopHost(env = process.env): DesktopHost {
  return {
    platform: process.platform, env,
    async executable(name) {
      const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
      const directories = path.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
      if (process.platform === 'win32') {
        const value = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
        const system = value('SystemRoot')
        const local = value('LOCALAPPDATA')
        if (name === 'powershell.exe' && system) directories.push(join(system, 'System32', 'WindowsPowerShell', 'v1.0'))
        if (name === 'wt.exe' && local) directories.push(join(local, 'Microsoft', 'WindowsApps'))
        const folders: Record<string, string[]> = { 'pwsh.exe': ['PowerShell', '7'], 'wezterm.exe': ['WezTerm'], 'wezterm-gui.exe': ['WezTerm'], 'alacritty.exe': ['Alacritty'] }
        if (folders[name]) {
          for (const base of [value('ProgramFiles'), local && join(local, 'Programs')]) {
            if (base) directories.push(join(base, ...folders[name]))
          }
        }
      }
      for (const directory of directories) {
        const file = join(directory.replace(/^"|"$/g, ''), name)
        try {
          await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
          if (process.platform === 'win32' || (await stat(file)).isFile()) return file
        } catch { /* Try the next PATH entry. */ }
      }
      return null
    },
    async application(name) {
      for (const directory of [env.HOME && join(env.HOME, 'Applications'), '/Applications', '/System/Applications/Utilities', '/Applications/Utilities']) {
        if (!directory) continue
        const file = join(directory, `${name}.app`)
        try { if ((await stat(file)).isDirectory()) return file }
        catch { /* Try the next application directory. */ }
      }
      return null
    },
    async query(executable, args) {
      return (await execute(executable, args, { env, windowsHide: true, timeout: 5000, maxBuffer: 16_000 })).stdout.trim()
    },
    async ownsConsole() {
      try { return process.getuid?.() !== 0 && (await stat('/dev/console')).uid === process.getuid?.() }
      catch { return false }
    },
    async start(executable, args, hidden = false, waitForExit = false) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, args, { env, detached: true, stdio: waitForExit ? ['ignore', 'ignore', 'pipe'] : 'ignore', windowsHide: hidden })
        let detail = ''
        child.stderr?.on('data', data => { detail = (detail + data.toString()).slice(-4096) })
        // GUI launchers may exit after handing off to an existing terminal process.
        // Catch immediate startup failures without waiting for the terminal to close.
        const timer = setTimeout(() => {
          if (waitForExit) { child.kill(); reject(new Error('Terminal automation timed out. Check macOS Automation permissions for Outpost.')) }
          else { child.unref(); resolve() }
        }, waitForExit ? 30_000 : 750)
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once(waitForExit ? 'close' : 'exit', code => {
          clearTimeout(timer)
          if (code === 0) resolve()
          else reject(new Error(detail.trim() || `Terminal launcher exited with code ${code}`))
        })
      })
    },
  }
}

type TerminalPlan = { terminal: DesktopTerminal; executable: string; hidden?: boolean; waitForExit?: boolean; args(file: string, directory: string): string[] }

// Paths are encoded as data, including Unicode quotes that PowerShell treats as syntax.
export function powershellBootstrap(file: string, directory: string) {
  const paths = Buffer.from(JSON.stringify({ file, directory })).toString('base64')
  return `$ErrorActionPreference = 'Stop'
$paths = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${paths}')))
$script = [IO.File]::ReadAllText($paths.file)
Remove-Item -LiteralPath $paths.file -Force
Remove-Item -LiteralPath $paths.directory -Force
# A GUI shell inherits the manager's PATH, which may put Git's MSYS ssh first.
# Windows OpenSSH preserves long attach commands that Git's SSH can truncate.
if ($env:OS -eq 'Windows_NT') {
  $sshDirectory = Join-Path $env:WINDIR 'System32\\OpenSSH'
  if (Test-Path -LiteralPath (Join-Path $sshDirectory 'ssh.exe') -PathType Leaf) {
    $env:PATH = $sshDirectory + ';' + $env:PATH
  }
}
& ([scriptblock]::Create($script))`
}

function plan(id: TerminalId, executable: string, args: TerminalPlan['args'], hidden = false): TerminalPlan {
  return { terminal: terminalApps.find(app => app.id === id)!, executable, args, hidden }
}

async function detect(host: DesktopHost): Promise<TerminalPlan[]> {
  if (host.platform === 'win32') {
    const powershell = await host.executable('pwsh.exe') ?? await host.executable('powershell.exe')
    if (!powershell) return []
    try {
      const interactive = await host.query(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        '[Environment]::UserInteractive -and ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0)'])
      if (interactive.toLowerCase() !== 'true') return []
    } catch { return [] }
    const [wt, weztermGui, weztermCli, alacritty] = await Promise.all([
      host.executable('wt.exe'), host.executable('wezterm-gui.exe'), host.executable('wezterm.exe'), host.executable('alacritty.exe'),
    ])
    const wezterm = weztermGui ?? weztermCli
    const shellArgs = (file: string, directory: string) => ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand', encodePowerShell(powershellBootstrap(file, directory))]
    const console = plan('windows-console', powershell, (file, directory) => {
      // Start-Process gives PowerShell a new console with real terminal handles.
      // The hidden Node child is only the launcher, not the interactive shell.
      const target = Buffer.from(powershell).toString('base64')
      return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(
        `$ErrorActionPreference = 'Stop'; Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${target}'))) -ArgumentList ${shellArgs(file, directory).map(value => `'${value}'`).join(',')}`,
      )]
    }, true)
    return [
      wt && plan('windows-terminal', wt, (file, directory) => ['-w', 'new', 'new-tab', powershell, ...shellArgs(file, directory)]),
      { ...console, waitForExit: true },
      wezterm && plan('windows-wezterm', wezterm, (file, directory) => ['start', '--always-new-process', '--', powershell, ...shellArgs(file, directory)], !weztermGui),
      alacritty && plan('windows-alacritty', alacritty, (file, directory) => ['-e', powershell, ...shellArgs(file, directory)]),
    ].filter((candidate): candidate is TerminalPlan => !!candidate)
  }
  if (host.platform === 'darwin') {
    if (!await host.ownsConsole()) return []
    const [iterm, terminal, wezterm, kitty, alacritty] = await Promise.all(['iTerm', 'Terminal', 'WezTerm', 'kitty', 'Alacritty'].map(name => host.application(name)))
    // AppleScript source is fixed; paths are passed as argv and quoted by
    // AppleScript itself. No simulated typing into a user's existing session.
    const itermScript = `on run argv
  tell application id "com.googlecode.iterm2"
    create window with default profile command ("/bin/bash " & quoted form of (item 1 of argv))
    activate
  end tell
end run`
    return [
      iterm && { ...plan('macos-iterm2', '/usr/bin/osascript', file => ['-e', itermScript, file]), waitForExit: true },
      terminal && plan('macos-terminal', '/usr/bin/open', file => ['-a', terminal, file]),
      wezterm && plan('macos-wezterm', '/usr/bin/open', file => ['-n', '-a', wezterm, '--args', 'start', '--always-new-process', '--', '/bin/bash', file]),
      kitty && plan('macos-kitty', '/usr/bin/open', file => ['-n', '-a', kitty, '--args', '--session', 'none', '/bin/bash', file]),
      alacritty && plan('macos-alacritty', '/usr/bin/open', file => ['-n', '-a', alacritty, '--args', '-e', '/bin/bash', file]),
    ].filter((candidate): candidate is TerminalPlan => !!candidate)
  }
  if (host.platform !== 'linux' || !(host.env.DISPLAY || host.env.WAYLAND_DISPLAY)) return []
  const bash = await host.executable('bash')
  if (!bash) return []
  const candidates = [
    { id: 'linux-gnome', command: 'gnome-terminal', args: (file: string) => ['--', bash, file] },
    { id: 'linux-ptyxis', command: 'ptyxis', args: (file: string) => ['--standalone', '--', bash, file] },
    { id: 'linux-konsole', command: 'konsole', args: (file: string) => ['-e', bash, file] },
    { id: 'linux-wezterm', command: 'wezterm', args: (file: string) => ['start', '--always-new-process', '--', bash, file] },
    { id: 'linux-kitty', command: 'kitty', args: (file: string) => ['--detach', '--session', 'none', bash, file] },
    { id: 'linux-alacritty', command: 'alacritty', args: (file: string) => ['-e', bash, file] },
    { id: 'linux-xfce', command: 'xfce4-terminal', args: (file: string) => ['--disable-server', '--execute', bash, file] },
    { id: 'linux-xterm', command: 'xterm', args: (file: string) => ['-e', bash, file] },
  ] satisfies { id: TerminalId; command: string; args: TerminalPlan['args'] }[]
  return (await Promise.all(candidates.map(async candidate => {
    const executable = await host.executable(candidate.command)
    return executable ? plan(candidate.id, executable, candidate.args) : null
  }))).filter((candidate): candidate is TerminalPlan => !!candidate)
}

export interface DesktopService {
  available(): Promise<DesktopAvailability>
  launch(makeScript: (shell: 'bash' | 'powershell') => string, input?: DesktopLaunchInput): Promise<DesktopTerminal>
}

export class DesktopLauncher implements DesktopService {
  constructor(private host: DesktopHost = desktopHost(), private temporaryRoot = tmpdir()) {}

  async available(): Promise<DesktopAvailability> {
    const plans = await detect(this.host)
    return { os: terminalOS(this.host.platform), terminals: plans.map(plan => plan.terminal), recommendedId: plans[0]?.terminal.id ?? null }
  }

  async launch(makeScript: (shell: 'bash' | 'powershell') => string, input: DesktopLaunchInput = {}) {
    let plans = await detect(this.host)
    if (input.terminalId) {
      plans = plans.filter(plan => plan.terminal.id === input.terminalId)
      if (!plans.length) throw new AppError('The selected terminal is unavailable on the computer running Outpost. Choose another terminal or use Copy command.', 409)
    } else {
      const os = terminalOS(this.host.platform)
      const favorite = os && input.preferences?.[os]
      if (favorite) plans.sort((a, b) => Number(b.terminal.id === favorite) - Number(a.terminal.id === favorite))
    }
    if (!plans.length) throw new AppError('No desktop terminal is available on the computer running Outpost. Use Copy command instead.', 409)
    const failures: string[] = []
    for (const candidate of plans) {
      try { return await this.open(candidate, makeScript) }
      catch (error) { failures.push(`${candidate.terminal.name}: ${(error as Error).message}`) }
    }
    throw new AppError(`Could not launch a terminal. ${failures.join('; ')}. Use Copy command instead.`, 502)
  }

  private async open(plan: TerminalPlan, makeScript: (shell: 'bash' | 'powershell') => string) {
    const directory = await mkdtemp(join(this.temporaryRoot, 'outpost-terminal-'))
    const file = join(directory, plan.terminal.shell === 'powershell' ? 'connect.ps1' : 'connect.command')
    try {
      const script = makeScript(plan.terminal.shell)
      const contents = plan.terminal.shell === 'powershell' ? script : `#!/usr/bin/env bash
rm -f -- ${quote(file)}
rmdir -- ${quote(directory)} 2>/dev/null || true
${script}
`
      await writeFile(file, contents, { mode: 0o700, flag: 'wx' })
      await this.host.start(plan.executable, plan.args(file, directory), plan.hidden, plan.waitForExit)
      // Normally the script deletes itself immediately. Also clean up if a GUI
      // launcher accepts the request but never starts the script.
      setTimeout(() => { void rm(directory, { recursive: true, force: true }).catch(() => {}) }, 60_000).unref()
      return plan.terminal
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
}
