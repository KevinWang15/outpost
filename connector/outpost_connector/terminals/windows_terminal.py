"""Windows Terminal, running the connector inside WSL.

Installs an Outpost fragment profile (Windows Terminal does not let fragments
bind keys, so the connector handles Alt+V and Ctrl+V-with-an-image itself) and
an `outpost://` handler in HKCU that opens a WSL tab directly, without a
console window flashing first.
"""

import base64
import json
import os
import shutil

ID = 'windows-terminal'
NAME = 'Windows Terminal'
PLATFORM = 'wsl'
PROFILE_NAME = 'Outpost'


def distribution():
    name = os.environ.get('WSL_DISTRO_NAME', '')
    if not name:
        raise OSError('Run the Outpost installer inside your WSL distribution.')
    return name


def fragment(distro):
    return {
        'profiles': [
            {
                'name': PROFILE_NAME,
                'commandline': 'wsl.exe -d ' + distro,
                'hidden': True,
                'closeOnExit': 'graceful',
                'tabTitle': 'Outpost',
                'suppressApplicationTitle': False,
            }
        ]
    }


def tab_arguments(distro, launcher, url):
    return [
        '-w',
        '0',
        'new-tab',
        '--profile',
        PROFILE_NAME,
        'wsl.exe',
        '-d',
        distro,
        '--exec',
        str(launcher),
        'attach',
        url,
    ]


def handler_command(wt, distro, launcher):
    # CreateProcess-style command line; the URL contains only base64url characters.
    return (
        '"'
        + wt
        + '" -w 0 new-tab --profile "'
        + PROFILE_NAME
        + '" wsl.exe -d "'
        + distro
        + '" --exec "'
        + str(launcher)
        + '" attach "%1"'
    )


SETUP = r"""$ErrorActionPreference = 'Stop'
$settings = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('%s')))
$local = [Environment]::GetFolderPath('LocalApplicationData')
$wt = Join-Path $local 'Microsoft\WindowsApps\wt.exe'
if (-not (Test-Path -LiteralPath $wt)) { throw 'Windows Terminal is not installed. Install it from the Microsoft Store, then run the installer again.' }
$fragments = Join-Path $local 'Microsoft\Windows Terminal\Fragments\Outpost'
if ($settings.action -eq 'install') {
  New-Item -ItemType Directory -Force -Path $fragments | Out-Null
  [IO.File]::WriteAllText((Join-Path $fragments 'outpost.json'), $settings.fragment, (New-Object Text.UTF8Encoding($false)))
  $command = $settings.command.Replace('{wt}', $wt)
  $key = 'HKCU:\Software\Classes\outpost'
  New-Item -Path "$key\shell\open\command" -Force | Out-Null
  Set-Item -Path $key -Value 'URL:Outpost Connector'
  New-ItemProperty -Path $key -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  Set-Item -Path "$key\shell\open\command" -Value $command
} else {
  Remove-Item -LiteralPath $fragments -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path 'HKCU:\Software\Classes\outpost' -Recurse -Force -ErrorAction SilentlyContinue
}
[Console]::Write($wt)
"""


def powershell(context, settings):
    script = SETUP % base64.b64encode(json.dumps(settings).encode()).decode()
    encoded = base64.b64encode(script.encode('utf-16-le')).decode()
    executable = shutil.which('powershell.exe') or '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
    return context.run([executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])


def install(context):
    distro = distribution()
    powershell(
        context,
        {
            'action': 'install',
            'fragment': json.dumps(fragment(distro), indent=2),
            'command': handler_command('{wt}', distro, context.launcher),
        },
    )
    return [
        'Windows Terminal: added the Outpost profile (Alt+V pastes images, Ctrl+Enter inserts a newline)',
        'Registered outpost:// links for the ' + distro + ' distribution',
    ]


def uninstall(context):
    powershell(context, {'action': 'uninstall'})


def open(url, context):
    wt = shutil.which('wt.exe')
    if not wt:
        raise OSError('Windows Terminal was not found. Enable Windows PATH in WSL or reinstall the connector.')
    context.run([wt, *tab_arguments(distribution(), context.launcher, url)])
