"""Real OS integrations, run on macOS and Windows CI runners (skipped elsewhere)."""
import base64
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'connector'))
from outpost_connector import terminals  # noqa: E402
from outpost_connector.platforms import WINDOWS_CLIPBOARD, WSL, MacOS  # noqa: E402
from outpost_connector.terminals import iterm2, windows_terminal  # noqa: E402

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==')


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise OSError(command[0] + ': ' + result.stderr)
    return result.stdout


@unittest.skipUnless(sys.platform == 'darwin', 'macOS only')
class MacOSTest(unittest.TestCase):
    def test_iterm2_install_builds_a_signed_registered_handler(self):
        home = Path(tempfile.mkdtemp(prefix='outpost-macos-'))
        self.addCleanup(shutil.rmtree, home, True)
        context = terminals.Context(home, home / '.outpost-connector' / 'bin' / 'outpost-connector', run)
        iterm2.install(context)
        app = iterm2.handler_path(context)
        run(['/usr/bin/plutil', '-lint', str(app / 'Contents' / 'Info.plist')])
        run(['/usr/bin/codesign', '--verify', '--deep', str(app)])
        info = plistlib.loads((app / 'Contents' / 'Info.plist').read_bytes())
        self.assertEqual(info['CFBundleURLTypes'][0]['CFBundleURLSchemes'], ['outpost'])
        json.loads(iterm2.profile_path(context).read_text())
        # The tab-opening script must compile; it is never run against iTerm2 in CI.
        source = home / 'open.applescript'
        source.write_text(iterm2.OPEN_SCRIPT)
        run(['/usr/bin/osacompile', '-o', str(home / 'open.scpt'), str(source)])
        iterm2.uninstall(context)
        self.assertFalse(app.exists())

    def test_clipboard_round_trip(self):
        platform = MacOS()
        platform.write_clipboard('Outpost ✓ clipboard')
        self.assertEqual(platform.read_clipboard().value, 'Outpost ✓ clipboard')
        self.assertEqual(platform.read_clipboard(images_only=True).kind, 'empty')

    def test_tls_context_trusts_public_servers(self):
        context = MacOS().ssl_context()
        self.assertTrue(context.check_hostname)


@unittest.skipUnless(sys.platform == 'win32', 'Windows only')
class WindowsTest(unittest.TestCase):
    """The WSL adapter drives Windows PowerShell; on a Windows runner it runs natively."""

    def test_clipboard_round_trip(self):
        platform = WSL()
        platform.write_clipboard('Outpost ✓ clipboard')
        self.assertEqual(platform.read_clipboard().value, 'Outpost ✓ clipboard')

    def test_clipboard_images_become_png(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        image = Path(directory) / 'image.png'
        image.write_bytes(PNG)
        WSL().powershell("Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; "
                         "[System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('" + str(image) + "'))")
        result = WSL().read_clipboard(images_only=True)
        self.assertEqual(result.kind, 'image')
        self.assertTrue(result.value.startswith(b'\x89PNG'))
        self.assertIn('ConvertTo-Json', WINDOWS_CLIPBOARD)

    def test_terminal_setup_script_parses(self):
        script = windows_terminal.SETUP % base64.b64encode(b'{}').decode()
        check = ('$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput('
                 '[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("' + base64.b64encode(script.encode()).decode() + '")), [ref]$null, [ref]$errors); '
                 'if ($errors.Count) { exit 1 }')
        WSL().powershell(check)


if __name__ == '__main__':
    unittest.main()
