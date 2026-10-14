"""Real OS integrations, run on macOS and Windows CI runners (skipped elsewhere)."""

import base64
import json
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'connector'))
from outpost_connector import install, link, terminals  # noqa: E402
from outpost_connector.platforms import WINDOWS_CLIPBOARD, WSL, MacOS  # noqa: E402
from outpost_connector.terminals import iterm2, windows_terminal  # noqa: E402

PNG = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
)


def run(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise OSError(command[0] + ': ' + result.stderr)
    return result.stdout


class InstallerProcessTest(unittest.TestCase):
    def test_success_with_utf8_path_and_legacy_encoded_diagnostics(self):
        path = 'C:\\Users\\张三\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
        script = (
            'import sys; '
            'sys.stdout.buffer.write(' + repr(path.encode()) + '); '
            'sys.stderr.buffer.write(' + repr('正在准备模块'.encode('gbk')) + ')'
        )
        self.assertEqual(install.run([sys.executable, '-c', script]), path)

    def test_failure_preserves_exit_status_even_with_legacy_encoded_diagnostics(self):
        for stream in ('stdout', 'stderr'):
            with self.subTest(stream=stream):
                script = (
                    'import sys; sys.'
                    + stream
                    + '.buffer.write('
                    + repr(b'Native setup failed: ' + '拒绝访问'.encode('gbk'))
                    + '); sys.exit(1)'
                )
                with self.assertRaisesRegex(OSError, 'Native setup failed:'):
                    install.run([sys.executable, '-c', script])


class UninstallTest(unittest.TestCase):
    def test_data_deletion_errors_are_reported(self):
        adapter = mock.Mock(NAME='Test terminal')
        with (
            mock.patch.object(install, 'supported_platform', return_value=(None, [adapter])),
            mock.patch.object(install.shutil, 'rmtree', side_effect=PermissionError('Cannot delete trust file')),
        ):
            with self.assertRaisesRegex(OSError, 'Uninstall was incomplete:.*Cannot delete trust file'):
                install.uninstall()
        adapter.uninstall.assert_called_once()

    def test_macos_uninstall_removes_profile_handler_and_all_trust(self):
        home = Path(tempfile.mkdtemp(prefix='outpost-uninstall-'))
        self.addCleanup(shutil.rmtree, home, True)
        connector = home / '.outpost-connector'
        connector.mkdir()
        (connector / 'config.json').write_text(
            json.dumps({'servers': ['https://one.example', 'http://localhost:3000']})
        )
        context = terminals.Context(home, connector / 'bin' / 'outpost-connector', mock.Mock())
        profile, app = iterm2.profile_path(context), iterm2.handler_path(context)
        profile.parent.mkdir(parents=True)
        profile.write_text('{}')
        app.mkdir(parents=True)
        (app / 'handler').touch()
        with (
            mock.patch.object(install, 'supported_platform', return_value=(None, [iterm2])),
            mock.patch.object(install, 'context', return_value=context),
            mock.patch.object(link, 'HOME', connector),
        ):
            install.uninstall()
            install.uninstall()
        self.assertFalse(profile.exists())
        self.assertFalse(app.exists())
        self.assertFalse(connector.exists())
        context.run.assert_called_once_with([iterm2.LSREGISTER, '-u', str(app)])


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
        WSL().powershell(
            'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; '
            "[System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('" + str(image) + "'))"
        )
        result = WSL().read_clipboard(images_only=True)
        self.assertEqual(result.kind, 'image')
        self.assertTrue(result.value.startswith(b'\x89PNG'))
        self.assertIn('ConvertTo-Json', WINDOWS_CLIPBOARD)

    def test_terminal_setup_script_parses(self):
        script = windows_terminal.SETUP % base64.b64encode(b'{}').decode()
        check = (
            '$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput('
            '[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("'
            + base64.b64encode(script.encode()).decode()
            + '")), [ref]$null, [ref]$errors); '
            'if ($errors.Count) { exit 1 }'
        )
        WSL().powershell(check)

    def test_terminal_setup_uses_utf8_for_paths_and_errors(self):
        directory = Path(tempfile.mkdtemp(prefix='outpost-windows-'))
        self.addCleanup(shutil.rmtree, directory, True)
        local = directory / '张三'
        wt = local / 'Microsoft' / 'WindowsApps' / 'wt.exe'
        wt.parent.mkdir(parents=True)
        wt.touch()
        key = 'HKCU:\\Software\\Classes\\outpost-test-' + uuid.uuid4().hex
        self.addCleanup(
            WSL().powershell,
            "$ErrorActionPreference = 'Stop'; if (Test-Path -LiteralPath '"
            + key
            + "') { Remove-Item -LiteralPath '"
            + key
            + "' -Recurse -Force }",
        )
        # Exercise the real setup under a legacy code page, isolating only its
        # Windows paths and registry key from the user's actual installation.
        script = '[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)\n' + windows_terminal.SETUP
        script = script.replace(
            "[Environment]::GetFolderPath('LocalApplicationData')", "'" + str(local).replace("'", "''") + "'"
        ).replace('HKCU:\\Software\\Classes\\outpost', key)
        context = terminals.Context(directory, Path('/home/test/.outpost-connector/bin/outpost-connector'), install.run)
        fragment = json.dumps(windows_terminal.fragment('Ubuntu'))
        command = windows_terminal.handler_command('{wt}', 'Ubuntu', context.launcher)
        with mock.patch.object(windows_terminal, 'SETUP', script):
            self.assertEqual(
                windows_terminal.powershell(context, {'action': 'install', 'fragment': fragment, 'command': command}),
                str(wt),
            )
            installed = local / 'Microsoft' / 'Windows Terminal' / 'Fragments' / 'Outpost' / 'outpost.json'
            self.assertEqual(installed.read_text(encoding='utf-8'), fragment)
            registered = WSL().powershell(
                '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); '
                "[Console]::Write((Get-Item -LiteralPath '" + key + "\\shell\\open\\command').GetValue(''))"
            )
            self.assertEqual(registered, command.replace('{wt}', str(wt)))
            # Force a localized filesystem error after setup starts. The real
            # message and failing status must survive the Python boundary.
            installed.unlink()
            installed.mkdir()
            with self.assertRaises(OSError) as failed:
                windows_terminal.powershell(context, {'action': 'install', 'fragment': fragment, 'command': command})
            self.assertIn('张三', str(failed.exception))
            self.assertNotIn('#< CLIXML', str(failed.exception))
            # Removing Windows Terminal itself must not prevent connector cleanup.
            wt.unlink()
            windows_terminal.uninstall(context)
            self.assertFalse(installed.parent.exists())
            self.assertEqual(WSL().powershell("[Console]::Write((Test-Path -LiteralPath '" + key + "'))"), 'False')
            windows_terminal.uninstall(context)  # Missing files and registry keys are harmless.


if __name__ == '__main__':
    unittest.main()
