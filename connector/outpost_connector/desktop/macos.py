"""macOS outpost:// handler and browser app windows; independent of terminal profiles."""

import json
import plistlib
import shlex
import shutil
import tempfile
from pathlib import Path

from . import macos_pwa

LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'


def handler_path(context):
    return context.home / 'Applications' / 'Outpost Connector.app'


def handler_script(launcher):
    # AppleScript string literals escape backslashes and quotes like JSON.
    command = json.dumps(shlex.quote(str(launcher)) + ' open ', ensure_ascii=False)
    return (
        '\n'.join(
            [
                'on open location theURL',
                '\ttry',
                '\t\tdo shell script ' + command + ' & quoted form of theURL',
                '\ton error errorMessage',
                '\t\tdisplay alert "Outpost" message errorMessage as critical',
                '\tend try',
                'end open location',
                'on run',
                '\tdisplay dialog "Outpost Connector opens your Outpost sessions in your chosen terminal. Click Connect in Outpost to use it."'
                ' buttons {"OK"} default button "OK" with title "Outpost Connector"',
                'end run',
            ]
        )
        + '\n'
    )


def install(context):
    app = handler_path(context)
    app.parent.mkdir(parents=True, exist_ok=True)
    # Build beside the installed app so publication uses same-filesystem renames.
    # A compiler or signing failure must leave the existing handler intact.
    with tempfile.TemporaryDirectory(prefix='.outpost-install-', dir=app.parent) as directory:
        staged = Path(directory) / app.name
        source = Path(directory) / 'handler.applescript'
        source.write_text(handler_script(context.launcher))
        context.run(['/usr/bin/osacompile', '-o', str(staged), str(source)])
        info = staged / 'Contents' / 'Info.plist'
        with info.open('rb') as stream:
            plist = plistlib.load(stream)
        plist.update(
            {
                'CFBundleIdentifier': 'dev.outpost.connector',
                'CFBundleName': 'Outpost Connector',
                'CFBundleURLTypes': [{'CFBundleURLName': 'Outpost connect link', 'CFBundleURLSchemes': ['outpost']}],
                'LSUIElement': True,
            }
        )
        with info.open('wb') as stream:
            plistlib.dump(plist, stream)
        # Editing Info.plist invalidates the applet's signature; re-sign it ad hoc.
        context.run(['/usr/bin/codesign', '--force', '--sign', '-', str(staged)])
        previous = Path(directory) / 'previous.app'
        if app.exists():
            app.rename(previous)
        try:
            staged.rename(app)
        except OSError:
            if previous.exists():
                previous.rename(app)
            raise
    context.run([LSREGISTER, '-f', str(app)])
    return ['Registered outpost:// links with ' + str(app)]


def uninstall(context):
    app = handler_path(context)
    if app.exists():
        context.run([LSREGISTER, '-u', str(app)])
        shutil.rmtree(app)


def open_app(url, context):
    app = macos_pwa.installed_app(url, context.home)
    if app:
        # Target this server's browser-created app explicitly, even when a
        # different Outpost installation owns the global protocol association.
        context.run(['/usr/bin/open', '-a', str(app), macos_pwa.launch_url(url)])
        return
    for name in ('Google Chrome', 'Microsoft Edge'):
        for directory in (Path('/Applications'), context.home / 'Applications'):
            app = directory / (name + '.app')
            if app.is_dir():
                # -n forwards arguments even when the browser already runs.
                context.run(['/usr/bin/open', '-n', '-a', str(app), '--args', '--app=' + url, '--new-window'])
                return
    raise OSError(
        'Terminal app needs Google Chrome or Microsoft Edge. Install either browser, then click Connect again.'
    )
