import type { Command } from './process'
import { quote } from './shell'

export function terminalScript(command: Command, shell: 'bash' | 'powershell') {
  if (shell === 'powershell') return powershellScript(command)
  // tmux needs a real PTY path opened read/write, not the /dev/tty alias or a read-only fd.
  return `#!/usr/bin/env bash
set -euo pipefail
command -v ${quote(command.executable)} >/dev/null || { echo ${quote(command.label + ' executable is required.')} >&2; exit 1; }
if ! terminal=$(tty <&1 2>/dev/null) && ! terminal=$(tty <&2 2>/dev/null); then
  echo 'Run this command in an interactive terminal.' >&2
  exit 1
fi
printf '%s\\n' 'Connecting. Detach with Ctrl-\\ or close this terminal; Your session keeps running.' >/dev/tty
exec ${quote(command.executable)} ${command.args.map(arg => command.expandHome && /^~[/\\]/.test(arg) ? `"$HOME/"${quote(arg.slice(2))}` : quote(arg)).join(' ')} 0<>"$terminal" 1>&0 2>&0
`
}

function powershellScript(command: Command) {
  const encodedArgs = Buffer.from(JSON.stringify(command)).toString('base64')
  return String.raw`# Requires PowerShell 5.1+.
$ErrorActionPreference = 'Stop'
# Decode command and arguments as data, including Unicode smart quotes.
$command = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')))
$nativeCommand = Get-Command $command.executable -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nativeCommand) { throw ($command.label + ' executable is required.') }
$nativeArguments = @($command.args)
for ($index = 0; $index -lt $nativeArguments.Length; $index++) {
  if ($command.expandHome -and $nativeArguments[$index] -match '^~[/\\]') {
    $nativeArguments[$index] = Join-Path $HOME $nativeArguments[$index].Substring(2)
  }
}
# Pass native arguments directly, with CRT quoting. This works with both Windows
# PowerShell 5.1 and PowerShell 7 without depending on their different & quoting.
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nativeCommand.Source
$startInfo.UseShellExecute = $false
$startInfo.Arguments = ($nativeArguments | ForEach-Object {
  '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}) -join ' '
# Inherit the console handles: piping terminal input/output breaks interactive TUIs.
$previousTerm = $env:TERM
# A manager started under a non-terminal shell can leak TERM=dumb into the
# launched window; tmux rejects terminal types without a clear capability.
if (-not $env:TERM -or $env:TERM -eq 'dumb') { $env:TERM = 'xterm-256color' }
Write-Host 'Connecting. Detach with Ctrl-\ or close this terminal; Your session keeps running.'
try {
  $nativeProcess = [System.Diagnostics.Process]::Start($startInfo)
  try {
    $nativeProcess.WaitForExit()
    $global:LASTEXITCODE = $nativeProcess.ExitCode
    if ($nativeProcess.ExitCode -ne 0) { throw ($command.label + ' exited with code ' + $nativeProcess.ExitCode + '. Check the message above.') }
  } finally { $nativeProcess.Dispose() }
} finally { $env:TERM = $previousTerm }
`
}
