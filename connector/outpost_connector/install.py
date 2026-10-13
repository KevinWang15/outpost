"""Install, update and remove the connector on this computer."""

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from . import VERSION, link, terminals
from .platforms import detect

ARCHIVE = link.HOME / 'outpost-connector.pyz'
LAUNCHER = link.HOME / 'bin' / 'outpost-connector'


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise OSError(' '.join(command[:1]) + ' failed: ' + (result.stderr or result.stdout).strip()[:500])
    return result.stdout


def context():
    return terminals.Context(Path.home(), LAUNCHER, run)


def supported_platform():
    platform = detect()
    adapters = terminals.for_platform(platform.name)
    if not adapters:
        raise OSError(
            'Outpost native terminals support macOS with iTerm2 and Windows Terminal with WSL. '
            'Use the web terminal on this computer.'
        )
    return platform, adapters


def install(server, archive):
    platform, adapters = supported_platform()
    link.HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.path.abspath(archive) != str(ARCHIVE):
        temporary = ARCHIVE.with_name('.outpost-connector.pyz.tmp')
        shutil.copyfile(archive, temporary)
        os.replace(temporary, ARCHIVE)
    LAUNCHER.parent.mkdir(mode=0o700, exist_ok=True)
    LAUNCHER.write_text('#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(ARCHIVE)) + ' "$@"\n')
    LAUNCHER.chmod(0o700)
    trusted = link.trust(server)
    messages = []
    for adapter in adapters:
        messages += adapter.install(context())
    print('Outpost Connector ' + VERSION + ' is installed.')
    for message in messages + ['Trusted Outpost server: ' + trusted]:
        print('  • ' + message)
    print('Click Connect in Outpost and choose ' + ' or '.join(adapter.NAME for adapter in adapters) + '.')


def uninstall():
    _, adapters = supported_platform()
    for adapter in adapters:
        adapter.uninstall(context())
    shutil.rmtree(link.HOME, ignore_errors=True)
    print('Outpost Connector was removed.')


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
