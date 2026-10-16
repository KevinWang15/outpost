import { existsSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { userInfo } from 'node:os'
import type { ShellProfileSummary } from '../../shared/localTerminal'

export interface ShellProfile extends ShellProfileSummary {
  executable: string
  args: string[]
  syntax: 'posix' | 'powershell' | 'cmd'
  wsl: boolean
}

/** Resolve executables natively; the renderer selects a profile ID, never a command. */
export function shellProfiles(): ShellProfile[] {
  if (process.platform !== 'win32') {
    const executable = userInfo().shell || process.env.SHELL || '/bin/sh'
    return [{ id: 'login', name: basename(executable), executable, args: ['-l'], syntax: 'posix', wsl: false }]
  }
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const path = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
  const pwsh = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ...path
      .split(delimiter)
      .filter(Boolean)
      .map(directory => join(directory.replace(/^"|"$/g, ''), 'pwsh.exe')),
  ].find(existsSync)
  const profiles: ShellProfile[] = []
  if (pwsh)
    profiles.push({
      id: 'pwsh',
      name: 'PowerShell',
      executable: pwsh,
      args: ['-NoLogo'],
      syntax: 'powershell',
      wsl: false,
    })
  const powershell = join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (existsSync(powershell))
    profiles.push({
      id: 'powershell',
      name: 'Windows PowerShell',
      executable: powershell,
      args: ['-NoLogo'],
      syntax: 'powershell',
      wsl: false,
    })
  profiles.push({
    id: 'cmd',
    name: 'Command Prompt',
    executable: join(system, 'cmd.exe'),
    args: [],
    syntax: 'cmd',
    wsl: false,
  })
  const wsl = join(system, 'wsl.exe')
  if (existsSync(wsl))
    profiles.push({
      id: 'wsl',
      name: 'WSL (default distribution)',
      executable: wsl,
      args: ['--cd', '~'],
      syntax: 'posix',
      wsl: true,
    })
  return profiles
}
