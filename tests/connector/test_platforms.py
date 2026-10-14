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
from outpost_connector.desktop import macos, windows  # noqa: E402
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
            mock.patch.object(install, 'supported_platform', return_value=(MacOS(), [adapter])),
            mock.patch.object(macos, 'uninstall'),
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
        profile, app = iterm2.profile_path(context), macos.handler_path(context)
        profile.parent.mkdir(parents=True)
        profile.write_text('{}')
        app.mkdir(parents=True)
        (app / 'handler').touch()
        with (
            mock.patch.object(install, 'supported_platform', return_value=(MacOS(), [iterm2])),
            mock.patch.object(install, 'context', return_value=context),
            mock.patch.object(link, 'HOME', connector),
        ):
            install.uninstall()
            install.uninstall()
        self.assertFalse(profile.exists())
        self.assertFalse(app.exists())
        self.assertFalse(connector.exists())
        context.run.assert_called_once_with([macos.LSREGISTER, '-u', str(app)])


@unittest.skipUnless(sys.platform == 'darwin', 'macOS only')
class MacOSTest(unittest.TestCase):
    def test_iterm2_install_builds_a_signed_registered_handler(self):
        home = Path(tempfile.mkdtemp(prefix='outpost-macos-'))
        self.addCleanup(shutil.rmtree, home, True)
        context = terminals.Context(home, home / '.outpost-connector' / 'bin' / 'outpost-connector', run)
        macos.install(context)
        iterm2.install(context)
        app = macos.handler_path(context)
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
        macos.uninstall(context)
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

    def test_desktop_scripts_parse(self):
        for script in (windows.SETUP, windows.OPEN, windows.APP, windows_terminal.SETUP):
            check = (
                '$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput('
                '[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("'
                + base64.b64encode(script.encode()).decode()
                + '")), [ref]$null, [ref]$errors); '
                'if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }'
            )
            WSL().powershell(check)

    def test_setup_uses_utf8_and_installs_without_windows_terminal(self):
        directory = Path(tempfile.mkdtemp(prefix='outpost-windows-'))
        self.addCleanup(shutil.rmtree, directory, True)
        local = directory / '张三'
        key = 'HKCU:\\Software\\Classes\\outpost-test-' + uuid.uuid4().hex
        self.addCleanup(
            WSL().powershell,
            "if (Test-Path -LiteralPath '" + key + "') { Remove-Item -LiteralPath '" + key + "' -Recurse -Force }",
        )

        def isolated(script):
            return script.replace(
                "[Environment]::GetFolderPath('LocalApplicationData')", "'" + str(local).replace("'", "''") + "'"
            ).replace('HKCU:\\Software\\Classes\\outpost', key)

        context = terminals.Context(directory, Path('/home/张三/with spaces/connector'), install.run)
        with (
            mock.patch.object(windows, 'SETUP', isolated(windows.SETUP)),
            mock.patch.object(windows_terminal, 'SETUP', isolated(windows_terminal.SETUP)),
            mock.patch.dict('os.environ', {'WSL_DISTRO_NAME': 'Ubuntu Test'}),
        ):
            windows.install(context)
            self.assertIn('skipped', windows_terminal.install(context)[0])
            handler = local / 'Outpost Connector'
            config = json.loads((handler / 'handler.json').read_text(encoding='utf-8-sig'))
            self.assertEqual(config['launcher'], str(context.launcher))
            self.assertEqual(config['distribution'], 'Ubuntu Test')
            registered = WSL().powershell(
                '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); '
                "[Console]::Write((Get-Item -LiteralPath '" + key + "\\shell\\open\\command').GetValue(''))"
            )
            self.assertIn(str(handler / 'open.ps1'), registered)
            self.assertIn('-File', registered)
            self.assertNotIn('wt.exe', registered)
            wt = local / 'Microsoft' / 'WindowsApps' / 'wt.exe'
            wt.parent.mkdir(parents=True)
            wt.touch()
            windows_terminal.install(context)
            profile = local / 'Microsoft' / 'Windows Terminal' / 'Fragments' / 'Outpost' / 'outpost.json'
            self.assertEqual(
                json.loads(profile.read_text(encoding='utf-8'))['profiles'][0]['commandline'],
                'wsl.exe -d "Ubuntu Test"',
            )
            # A localized filesystem failure must survive the Python boundary.
            profile.unlink()
            profile.mkdir()
            with self.assertRaises(OSError) as failed:
                windows_terminal.install(context)
            self.assertIn('张三', str(failed.exception))
            self.assertNotIn('#< CLIXML', str(failed.exception))
            wt.unlink()
            for _ in range(2):
                windows_terminal.uninstall(context)
                windows.uninstall(context)
            self.assertFalse(profile.parent.exists())
            self.assertFalse(handler.exists())
            self.assertEqual(WSL().powershell("[Console]::Write((Test-Path -LiteralPath '" + key + "'))"), 'False')


if __name__ == '__main__':
    unittest.main()
