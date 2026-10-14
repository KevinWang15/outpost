"""Install, update and remove the connector on this computer."""

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from . import VERSION, link, terminals
from .desktop import HANDLERS
from .platforms import detect

ARCHIVE = link.HOME / 'outpost-connector.pyz'
LAUNCHER = link.HOME / 'bin' / 'outpost-connector'


def run(command):
    # Our scripts emit UTF-8. Native startup errors may still use a Windows
    # code page; decoding diagnostics must not hide the process's exit status.
    result = subprocess.run(command, capture_output=True, encoding='utf-8', errors='replace', timeout=120)
    if result.returncode:
        raise OSError(' '.join(command[:1]) + ' failed: ' + (result.stderr or result.stdout).strip()[:500])
    return result.stdout


def context():
    return terminals.Context(Path.home(), LAUNCHER, run)


def supported_platform():
    platform = detect()
    adapters = terminals.for_platform(platform.name)
    if not adapters:
        raise OSError('Outpost Connector supports macOS and Windows with WSL. Use the web terminal on this computer.')
    return platform, adapters


def install(server, archive):
    platform, adapters = supported_platform()
    link.HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    link.HOME.chmod(0o700)
    if os.path.abspath(archive) != str(ARCHIVE):
        temporary = ARCHIVE.with_name('.outpost-connector.pyz.tmp')
        shutil.copyfile(archive, temporary)
        os.replace(temporary, ARCHIVE)
    LAUNCHER.parent.mkdir(mode=0o700, exist_ok=True)
    LAUNCHER.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(ARCHIVE)) + ' "$@"\n')
    LAUNCHER.chmod(0o700)
    trusted = link.trust(server)
    messages = HANDLERS[platform.name].install(context())
    for adapter in adapters:
        messages += adapter.install(context())
    print('Outpost Connector ' + VERSION + ' is installed.')
    for message in messages + ['Trusted Outpost server: ' + trusted]:
        print('  • ' + message)
    print('Click Connect in Outpost and choose ' + ' or '.join(adapter.NAME for adapter in adapters) + '.')


def uninstall():
    platform, adapters = supported_platform()
    errors = []
    for adapter in adapters:
        try:
            adapter.uninstall(context())
        except OSError as error:
            errors.append(adapter.NAME + ': ' + str(error))
    try:
        HANDLERS[platform.name].uninstall(context())
    except OSError as error:
        errors.append('URL handler: ' + str(error))
    # Revoke all trusted servers even if removing the OS integration failed.
    # Only an absent installation is ignored; permission errors must surface.
    try:
        shutil.rmtree(link.HOME)
    except FileNotFoundError:
        pass
    except OSError as error:
        errors.append(str(error))
    if errors:
        raise OSError('Uninstall was incomplete: ' + '; '.join(errors))
    print('Outpost Connector, its terminal integration, and all trusted servers were removed.')
    print('  Connector data directory: ' + str(link.HOME))


def open_link(url):
    """Entry point of the outpost:// handler: validate, then open the right terminal."""
    target = link.trusted(link.parse(url))
    platform, adapters = supported_platform()
    adapter = next((item for item in adapters if item.ID == target.terminal), None)
    if adapter is None:
        names = ', '.join(item.NAME for item in adapters)
        raise link.LinkError(
            'This link opens '
            + target.terminal
            + ', which is not available here. On this computer, choose '
            + names
            + ' in Outpost.'
        )
    adapter.open(url, context())
