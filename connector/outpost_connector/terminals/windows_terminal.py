"""Windows Terminal, running the connector inside WSL.

Installs an Outpost fragment profile (Windows Terminal does not let fragments
bind keys, so the connector handles Alt+V and Ctrl+V-with-an-image itself) using the shared desktop `outpost://` handler.
"""

import json
import shutil
import subprocess

from ..desktop import windows

ID = 'windows-terminal'
NAME = 'Windows Terminal'
PLATFORMS = ('wsl',)
PROFILE_NAME = 'Outpost'


def fragment(distro):
    return {
        'profiles': [
            {
                'name': PROFILE_NAME,
                'commandline': subprocess.list2cmdline(['wsl.exe', '-d', distro]),
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


SETUP = r"""
$local = [Environment]::GetFolderPath('LocalApplicationData')
$wt = Join-Path $local 'Microsoft\WindowsApps\wt.exe'
$fragments = Join-Path $local 'Microsoft\Windows Terminal\Fragments\Outpost'
if ($settings.action -eq 'install-profile') {
  if (-not (Test-Path -LiteralPath $wt)) {
    [Console]::Write('Windows Terminal is not installed; its optional profile was skipped.')
  } else {
    New-Item -ItemType Directory -Force -Path $fragments | Out-Null
    [IO.File]::WriteAllText((Join-Path $fragments 'outpost.json'), $settings.fragment, (New-Object Text.UTF8Encoding($false)))
    [Console]::Write('Windows Terminal: added the Outpost profile (Alt+V pastes images, Ctrl+Enter inserts a newline)')
  }
} elseif (Test-Path -LiteralPath $fragments) {
  Remove-Item -LiteralPath $fragments -Recurse -Force
}
"""


def install(context):
    message = windows.powershell(
        context,
        SETUP,
        {'action': 'install-profile', 'fragment': json.dumps(fragment(windows.distribution()), indent=2)},
    )
    return [message.strip()] if message.strip() else []


def uninstall(context):
    windows.powershell(context, SETUP, {'action': 'uninstall-profile'})


def open(url, context):
    wt = shutil.which('wt.exe')
    if not wt:
        raise OSError('Windows Terminal was not found. Enable Windows PATH in WSL or reinstall the connector.')
    context.run([wt, *tab_arguments(windows.distribution(), context.launcher, url)])
