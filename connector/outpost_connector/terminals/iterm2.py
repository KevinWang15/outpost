"""iTerm2 on macOS.

Installs a dynamic profile named Outpost (inheriting your default profile) that
maps ⌘V to the Outpost paste key, ⇧↩ to CSI u and left Option to Meta, plus a
small `outpost://` handler app that opens links in iTerm2.
"""
import json
import plistlib
import shlex
import shutil
import tempfile
from pathlib import Path

ID = 'iterm2'
NAME = 'iTerm2'
PLATFORM = 'macos'
PROFILE_NAME = 'Outpost'
PROFILE_GUID = '6f0c2a9e-3b7d-4c51-9e8a-2d4b7f1c0a35'
LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

# Keys: "0x<character>-0x<modifier flags>". Action 10 sends ESC + Text.
KEYS = {
    '0x76-0x100000': {'Action': 10, 'Text': '[9001~'},   # ⌘V → Outpost paste (text or image)
    '0xd-0x20000': {'Action': 10, 'Text': '[13;2u'},     # ⇧↩ → newline in coding tools
}


def profile():
    return {'Profiles': [{
        'Name': PROFILE_NAME,
        'Guid': PROFILE_GUID,
        'Keyboard Map': KEYS,
        'Option Key Sends': 2,         # Left Option acts as Meta (Esc+).
        'Right Option Key Sends': 0,   # Right Option still types special characters.
        'Close Sessions On End': True,
        'Mouse Reporting': True,
    }]}


def profile_path(context):
    return context.home / 'Library' / 'Application Support' / 'iTerm2' / 'DynamicProfiles' / 'outpost.json'


def handler_path(context):
    return context.home / 'Applications' / 'Outpost Connector.app'


def handler_script(launcher):
    # AppleScript string literals escape backslashes and quotes like JSON.
    command = json.dumps(shlex.quote(str(launcher)) + ' open ', ensure_ascii=False)
    return '\n'.join([
        'on open location theURL',
        '\ttry',
        '\t\tdo shell script ' + command + ' & quoted form of theURL',
        '\ton error message',
        '\t\tdisplay alert "Outpost" message message as critical',
        '\tend try',
        'end open location',
        'on run',
        '\tdisplay dialog "Outpost Connector opens your Outpost sessions in iTerm2. Click Connect in Outpost to use it."'
        ' buttons {"OK"} default button "OK" with title "Outpost Connector"',
        'end run',
    ]) + '\n'


OPEN_SCRIPT = '''on run argv
\tset theCommand to item 1 of argv
\ttell application id "com.googlecode.iterm2"
\t\tactivate
\t\ttry
\t\t\tif (count of windows) is 0 then
\t\t\t\tcreate window with profile "Outpost" command theCommand
\t\t\telse
\t\t\t\ttell current window to create tab with profile "Outpost" command theCommand
\t\t\tend if
\t\ton error
\t\t\tif (count of windows) is 0 then
\t\t\t\tcreate window with default profile command theCommand
\t\t\telse
\t\t\t\ttell current window to create tab with default profile command theCommand
\t\t\tend if
\t\tend try
\tend tell
end run
'''


def install(context):
    path = profile_path(context)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(profile(), indent=2) + '\n')
    app = handler_path(context)
    app.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'handler.applescript'
        source.write_text(handler_script(context.launcher))
        shutil.rmtree(app, ignore_errors=True)
        context.run(['/usr/bin/osacompile', '-o', str(app), str(source)])
    info = app / 'Contents' / 'Info.plist'
    with info.open('rb') as stream:
        plist = plistlib.load(stream)
    plist.update({
        'CFBundleIdentifier': 'dev.outpost.connector',
        'CFBundleName': 'Outpost Connector',
        'CFBundleURLTypes': [{'CFBundleURLName': 'Outpost connect link', 'CFBundleURLSchemes': ['outpost']}],
        'LSUIElement': True,
    })
    with info.open('wb') as stream:
        plistlib.dump(plist, stream)
    # Editing Info.plist invalidates the applet's signature; re-sign it ad hoc.
    context.run(['/usr/bin/codesign', '--force', '--sign', '-', str(app)])
    context.run([LSREGISTER, '-f', str(app)])
    return ['iTerm2: added the Outpost profile (⌘V pastes images, ⇧↩ inserts a newline)',
            'Registered outpost:// links with ' + str(app)]


def uninstall(context):
    profile_path(context).unlink(missing_ok=True)
    app = handler_path(context)
    if app.exists():
        context.run([LSREGISTER, '-u', str(app)])
        shutil.rmtree(app, ignore_errors=True)


def open(url, context):
    command = shlex.quote(str(context.launcher)) + ' attach ' + shlex.quote(url)
    context.run(['/usr/bin/osascript', '-e', OPEN_SCRIPT, command])
