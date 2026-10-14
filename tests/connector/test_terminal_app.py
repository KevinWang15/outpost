"""The app launcher crosses the OS boundary without acquiring a second connection."""

import base64
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'connector'))
from outpost_connector import install, link, terminals  # noqa: E402
from outpost_connector.desktop import macos, windows  # noqa: E402
from outpost_connector.terminals import terminal_app  # noqa: E402


def launch_link(server='https://outpost.example.com'):
    payload = {'v': 1, 'server': server, 'token': 'launch.signature', 'terminal': 'terminal-app'}
    return 'outpost://connect/' + base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')


class TerminalAppTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix='outpost-app-')) / 'user with spaces 张三'
        self.home.mkdir()
        self.addCleanup(shutil.rmtree, self.home.parent, True)
        self.context = terminals.Context(self.home, self.home / 'connector', mock.Mock(return_value=''))

    def test_dispatches_on_both_platforms_only_after_trust(self):
        for name, handler in (('macos', macos), ('wsl', windows)):
            platform = mock.Mock()
            platform.name = name
            with (
                mock.patch.object(install, 'detect', return_value=platform),
                mock.patch.object(terminal_app, 'detect', return_value=platform),
                mock.patch.object(install, 'context', return_value=self.context),
                mock.patch.object(handler, 'open_app') as opened,
                mock.patch.object(link, 'load', return_value={'servers': ['https://outpost.example.com']}),
            ):
                install.open_link(launch_link())
                opened.assert_called_once_with(
                    'https://outpost.example.com/terminal/app#token=launch.signature', self.context
                )
                opened.reset_mock()
                with self.assertRaisesRegex(link.LinkError, 'does not trust'):
                    install.open_link(launch_link('https://untrusted.example.com'))
                opened.assert_not_called()
                self.context.run.assert_not_called()

    def test_macos_launches_an_existing_browser_with_separate_arguments(self):
        url = 'https://outpost.example.com/terminal/app#token=launch.signature'
        # Isolate system installations; still exercise actual paths with spaces.
        original = Path.is_dir
        with mock.patch.object(
            Path, 'is_dir', lambda path: not str(path).startswith('/Applications/') and original(path)
        ):
            with self.assertRaisesRegex(OSError, 'needs Google Chrome or Microsoft Edge'):
                macos.open_app(url, self.context)
            for name in ('Microsoft Edge', 'Google Chrome'):
                app = self.home / 'Applications' / (name + '.app')
                app.mkdir(parents=True)
                macos.open_app(url, self.context)
                self.context.run.assert_called_with(
                    ['/usr/bin/open', '-n', '-a', str(app), '--args', '--app=' + url, '--new-window']
                )

    def test_windows_transfers_url_as_data_and_launches_browser_without_wt(self):
        url = 'http://127.0.0.1:3000/terminal/app#token=launch.signature'
        windows.open_app(url, self.context)
        command = self.context.run.call_args.args[0]
        script = base64.b64decode(command[-1]).decode('utf-16-le')
        self.assertNotIn(url, script)
        settings = json.loads(base64.b64decode(script.split("FromBase64String('")[1].split("'")[0]))
        self.assertEqual(settings, {'url': url})
        self.assertIn('Start-Process -FilePath $browser', script)
        self.assertNotIn('wt.exe', script)
        self.assertIn('--new-window', script)


if __name__ == '__main__':
    unittest.main()
