import type { Command } from './process'
import { quote } from './shell'

const disconnectedBanner = `+--------------------------------------------------+
|                                                  |
|                   DISCONNECTED                   |
|                                                  |
|             Press Enter to reconnect             |
|                 Ctrl+C to exit                   |
|                                                  |
+--------------------------------------------------+`

// Leave alternate screens and input protocols behind after an abrupt disconnect.
const terminalReset = '\x1b7\x1b[?1049l\x1b8\x1b[0m\x1b[?25h\x1b[?1l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l\x1b[<u\x1b[>4;0m'

export function terminalScript(command: Command, shell: 'bash' | 'powershell') {
  if (shell === 'powershell') return powershellScript(command)
  // tmux needs a real PTY path opened read/write, not the /dev/tty alias or a read-only fd.
  return `#!/usr/bin/env bash
set -euo pipefail
if ! terminal=$(tty <&1 2>/dev/null) && ! terminal=$(tty <&2 2>/dev/null); then
  echo 'Run this command in an interactive terminal.' >&2
  exit 1
fi
exec 3<>"$terminal"
# Reclaim the foreground TTY after a local login shell hands it to its child.
set -m
terminal_settings=$(stty -g <&3)
restore_terminal() {
  stty "$terminal_settings" <&3 2>/dev/null || true
  if [[ \${TERM:-dumb} != dumb ]]; then printf '%s' ${quote(terminalReset)} >&3; fi
}
trap restore_terminal EXIT
trap 'exit 130' INT
trap 'exit 129' HUP
trap 'exit 143' TERM
while true; do
  printf '%s\\n' 'Connecting. Detach with Ctrl-\\; your session keeps running.' >&3
  status=0
  if command -v ${quote(command.executable)} >/dev/null; then
    ${quote(command.executable)} ${command.args.map(arg => command.expandHome && /^~[/\\]/.test(arg) ? `"$HOME/"${quote(arg.slice(2))}` : quote(arg)).join(' ')} 0<>"$terminal" 1>&0 2>&0 3>&- || status=$?
  else
    printf '%s\\n' ${quote(command.label + ' executable is required.')} >&3
    status=127
  fi
  restore_terminal
  printf '\\r\\n' >&3
  if (( status != 0 )); then printf '%s\\n' ${quote(command.label + ' exited with code ')}"$status." >&3; fi
  if [[ \${TERM:-dumb} != dumb ]]; then printf '\\033[30;43m' >&3; fi
  printf '\\n%s\\n\\n' ${quote(disconnectedBanner)} >&3
  if [[ \${TERM:-dumb} != dumb ]]; then printf '\\033[0m' >&3; fi
  # The downloaded script owns stdin; read reconnect input from the actual TTY.
  # Handle Ctrl+C as a key here, including shells that inherited ignored SIGINT.
  stty -isig <&3
  while true; do
    IFS= read -r -s -n 1 key <&3 || exit "$status"
    if [[ "$key" == $'\\003' ]]; then exit 0; fi
    if [[ -z "$key" || "$key" == $'\\r' ]]; then break; fi
  done
  stty "$terminal_settings" <&3
done
`
}

function powershellScript(command: Command) {
  const encodedArgs = Buffer.from(JSON.stringify(command)).toString('base64')
  return String.raw`# Requires PowerShell 5.1+.
$ErrorActionPreference = 'Stop'
# Decode command and arguments as data, including Unicode smart quotes.
$command = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedArgs}')))
$nativeArguments = @($command.args)
for ($index = 0; $index -lt $nativeArguments.Length; $index++) {
  if ($command.expandHome -and $nativeArguments[$index] -match '^~[/\\]') {
    $nativeArguments[$index] = Join-Path $HOME $nativeArguments[$index].Substring(2)
  }
}
# Pass native arguments directly, with CRT quoting. This works with both Windows
# PowerShell 5.1 and PowerShell 7 without depending on their different & quoting.
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.UseShellExecute = $false
$startInfo.Arguments = ($nativeArguments | ForEach-Object {
  '"' + ($_ -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}) -join ' '
# Inherit the console handles: piping terminal input/output breaks interactive TUIs.
$previousTerm = $env:TERM
# A manager started under a non-terminal shell can leak TERM=dumb into the
# launched window; tmux rejects terminal types without a clear capability.
if (-not $env:TERM -or $env:TERM -eq 'dumb') { $env:TERM = 'xterm-256color' }
$interactive = -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
$stty = $null
if ($interactive -and [Environment]::OSVersion.Platform -eq [PlatformID]::Unix) {
  $stty = Get-Command stty -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($stty) { $terminalSettings = & $stty.Source -g }
}
try {
  :connection while ($true) {
    Write-Host 'Connecting. Detach with Ctrl-\; your session keeps running.'
    $failure = $null
    try {
      $nativeCommand = Get-Command $command.executable -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $nativeCommand) { throw ($command.label + ' executable is required.') }
      $startInfo.FileName = $nativeCommand.Source
      $nativeProcess = [System.Diagnostics.Process]::Start($startInfo)
      try {
        $nativeProcess.WaitForExit()
        $global:LASTEXITCODE = $nativeProcess.ExitCode
        if ($nativeProcess.ExitCode -ne 0) { $failure = $command.label + ' exited with code ' + $nativeProcess.ExitCode + '. Check the message above.' }
      } finally { $nativeProcess.Dispose() }
    } catch { $failure = $_; $global:LASTEXITCODE = 1 }
    if ($stty) {
      $connectionCode = $global:LASTEXITCODE
      & $stty.Source $terminalSettings
      $global:LASTEXITCODE = $connectionCode
    }
    if ($interactive -and $Host.UI.SupportsVirtualTerminal) { [Console]::Write('${terminalReset}') }
    if ($failure) { Write-Host $failure -ForegroundColor Red }
    Write-Host ""
    Write-Host '${disconnectedBanner}' -ForegroundColor Black -BackgroundColor Yellow
    Write-Host ""
    # A redirected/closed input stream cannot offer an interactive reconnect.
    if (-not $interactive) {
      if ($failure) { throw $failure }
      break
    }
    $previousControlC = [Console]::TreatControlCAsInput
    try {
      [Console]::TreatControlCAsInput = $true
      # OpenSSH can restore a different mode than .NET's cached console mode.
      if ($stty) { & $stty.Source -icanon -echo -isig min 1 time 0 }
      while ($true) {
        $key = [Console]::ReadKey($true)
        if ($key.KeyChar -eq [char]3) { break connection }
        if ($key.Key -eq [ConsoleKey]::Enter) { break }
      }
    } finally {
      [Console]::TreatControlCAsInput = $previousControlC
      if ($stty) { & $stty.Source $terminalSettings }
    }
  }
} finally {
  if ($stty) {
    $connectionCode = $global:LASTEXITCODE
    & $stty.Source $terminalSettings
    $global:LASTEXITCODE = $connectionCode
  }
  $env:TERM = $previousTerm
}
`
}
