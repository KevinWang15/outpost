"""Windows desktop integration driven from WSL, without requiring Windows Terminal.

The registered PowerShell script dispatches every outpost:// link through
`connector open`. Data is passed as arguments/JSON, never interpolated as code.
"""

import base64
import json
import os
import shutil


def distribution():
    name = os.environ.get('WSL_DISTRO_NAME', '')
    if not name:
        raise OSError(
            'WSL_DISTRO_NAME is missing (sudo or su may clear it). '
            'Open your WSL distribution normally and run the installer as your usual Linux user, without sudo.'
        )
    return name


def powershell(context, script, settings):
    encoded_settings = base64.b64encode(json.dumps(settings).encode()).decode()
    script = (
        "$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n"
        '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)\n'
        'try {\n'
        "  $settings = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"
        + encoded_settings
        + "')))\n"
        + script
        + '\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }\n'
    )
    encoded = base64.b64encode(script.encode('utf-16-le')).decode()
    executable = shutil.which('powershell.exe') or '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
    return context.run([executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])


# Loaded by -File, so the URL is a value, not a PowerShell expression. Check
# its alphabet before passing it through WSL's Windows command-line boundary.
OPEN = r"""param([string]$Url)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
  if ($Url -cnotmatch '^outpost://connect/[A-Za-z0-9_-]+/?$') { throw 'Invalid Outpost link. Click Connect again.' }
  $settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'handler.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $result = & "$env:SystemRoot\System32\wsl.exe" -d $settings.distribution --exec $settings.launcher open $Url 2>&1
  if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show([string]$_, 'Outpost Connector')
  exit 1
}
"""

SETUP = r"""
$local = [Environment]::GetFolderPath('LocalApplicationData')
$directory = Join-Path $local 'Outpost Connector'
$key = 'HKCU:\Software\Classes\outpost'
if ($settings.action -eq 'install') {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $utf8 = New-Object Text.UTF8Encoding($true)
  $script = Join-Path $directory 'open.ps1'
  [IO.File]::WriteAllText($script, $settings.script, $utf8)
  [IO.File]::WriteAllText((Join-Path $directory 'handler.json'), $settings.handler, $utf8)
  $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $command = '"' + $shell + '" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $script + '" "%1"'
  New-Item -Path "$key\shell\open\command" -Force | Out-Null
  Set-Item -Path $key -Value 'URL:Outpost Connector'
  New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  Set-Item -Path "$key\shell\open\command" -Value $command
} else {
  foreach ($path in @($key, $directory)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
  }
}
"""

APP = r"""
$browser = $null
# App Paths covers machine and per-user installs, including custom locations.
foreach ($name in @('chrome.exe', 'msedge.exe')) {
  foreach ($hive in @('HKCU:', 'HKLM:')) {
    $key = "$hive\Software\Microsoft\Windows\CurrentVersion\App Paths\$name"
    if (Test-Path -LiteralPath $key) {
      $candidate = (Get-Item -LiteralPath $key).GetValue('')
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $browser = $candidate; break }
    }
  }
  if ($browser) { break }
}
if (-not $browser) { throw 'Terminal app needs Google Chrome or Microsoft Edge. Install either browser, then click Connect again.' }
# Quote the one URL argument for CreateProcess; Python supplies a normalized
# origin and an encoded fragment, neither of which may contain a quote.
if ($settings.url.Contains('"')) { throw 'Invalid terminal app URL.' }
Start-Process -FilePath $browser -ArgumentList @(('"--app=' + $settings.url + '"'), '--new-window')
"""


def install(context):
    distro = distribution()
    powershell(
        context,
        SETUP,
        {
            'action': 'install',
            'script': OPEN,
            'handler': json.dumps({'distribution': distro, 'launcher': str(context.launcher)}),
        },
    )
    return ['Registered outpost:// links for the ' + distro + ' distribution']


def uninstall(context):
    powershell(context, SETUP, {'action': 'uninstall'})


def open_app(url, context):
    powershell(context, APP, {'url': url})
