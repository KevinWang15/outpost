"""Connector shims and terminal integrations, without a real terminal app."""

import atexit
import base64
import json
import os
import plistlib
import shlex
import shutil
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'connector'))
os.environ['OUTPOST_CONNECTOR_HOME'] = tempfile.mkdtemp(prefix='outpost-connector-')
atexit.register(shutil.rmtree, os.environ['OUTPOST_CONNECTOR_HOME'], True)
from outpost_connector import VERSION, link, terminals  # noqa: E402
from outpost_connector.keys import InputRouter, bracketed  # noqa: E402
from outpost_connector.platforms import ClipboardError, parse_clipboard  # noqa: E402
from outpost_connector.screen import OutputFilter  # noqa: E402
from outpost_connector.terminals import iterm2, windows_terminal  # noqa: E402
from outpost_connector.websocket import BINARY, TEXT, WebSocket  # noqa: E402


def outpost_link(**fields):
    data = {
        'v': 1,
        'server': 'https://outpost.example.com',
        'token': 'abc.DEF-_1',
        'terminal': 'iterm2',
        'title': 'Build · dev',
        **fields,
    }
    return 'outpost://connect/' + base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip('=')


class InputRouterTest(unittest.TestCase):
    def test_plain_text_passes_through(self):
        self.assertEqual(InputRouter().feed(b'hello\r'), [('data', b'hello\r')])

    def test_paste_gestures(self):
        router = InputRouter()
        self.assertEqual(router.feed(b'a\x16b'), [('data', b'a'), ('paste', 'image', b'\x16'), ('data', b'b')])
        self.assertEqual(router.feed(b'\x1bv'), [('paste', 'image', b'\x1bv')])
        self.assertEqual(router.feed(b'\x1b[9001~'), [('paste', 'any', b'')])

    def test_gestures_inside_pastes_and_replies_are_opaque(self):
        router = InputRouter()
        pasted = b'\x1b[200~text \x16 \x1bv \x1b[9001~\x1b[201~'
        self.assertEqual(router.feed(pasted), [('data', pasted)])
        reply = b'\x1b]11;rgb:0000/0000/0000\x1b\\'
        self.assertEqual(router.feed(reply + b'\x1b[9001~'), [('data', reply), ('paste', 'any', b'')])

    def test_split_sequences_and_lone_escape(self):
        router = InputRouter()
        self.assertEqual(router.feed(b'\x1b[90'), [])
        self.assertEqual(router.feed(b'01~'), [('paste', 'any', b'')])
        self.assertEqual(router.feed(b'\x1b'), [])
        self.assertTrue(router.waiting)
        self.assertEqual(router.flush(force=True), [('data', b'\x1b')])
        self.assertEqual(router.feed(b'\x1b[A'), [('data', b'\x1b[A')])

    def test_large_pastes_stream_without_buffering(self):
        router = InputRouter()
        self.assertEqual(router.feed(b'\x1b[200~' + b'x' * 100000)[0][1][:6], b'\x1b[200~')
        self.assertLessEqual(len(router.pending), 5)
        self.assertEqual(router.feed(b'\x1b[201~\x16')[-1], ('paste', 'image', b'\x16'))

    def test_bracketed_text(self):
        self.assertEqual(bracketed('a\r\nb\nc', True), '\x1b[200~a\rb\rc\x1b[201~')
        self.assertEqual(bracketed('x\x1b[201~y', True), '\x1b[200~xy\x1b[201~')
        self.assertEqual(bracketed('a\nb', False), 'a\rb')


class OutputFilterTest(unittest.TestCase):
    def setUp(self):
        self.copied = []
        self.screen = OutputFilter(self.copied.append)

    def test_osc52_is_copied_and_removed(self):
        encoded = base64.b64encode('héllo'.encode()).decode().encode()
        self.assertEqual(self.screen.feed(b'a\x1b]52;c;' + encoded + b'\x07b'), b'ab')
        self.assertEqual(self.copied, ['héllo'])

    def test_split_osc52_and_queries(self):
        encoded = base64.b64encode(b'split').decode().encode()
        output = b''
        for byte in b'x\x1b]52;c;' + encoded + b'\x1b\\y':
            output += self.screen.feed(bytes([byte]))
        self.assertEqual((output, self.copied), (b'xy', ['split']))
        self.assertEqual(self.screen.feed(b'\x1b]52;c;?\x07'), b'')
        self.assertEqual(self.copied, ['split'], 'clipboard reads are never answered')

    def test_held_prefix_is_released(self):
        self.assertEqual(self.screen.feed(b'abc\x1b]'), b'abc')
        self.assertEqual(self.screen.flush(), b'\x1b]')
        self.assertEqual(self.screen.feed(b'\x1b]0;title\x07'), b'\x1b]0;title\x07')

    def test_tracks_bracketed_paste(self):
        self.screen.feed(b'\x1b[?2004h')
        self.assertTrue(self.screen.bracketed_paste)
        self.screen.feed(b'\x1b[?1004;2004l')
        self.assertFalse(self.screen.bracketed_paste)


class LinkTest(unittest.TestCase):
    def test_parse_and_trust(self):
        parsed = link.parse(outpost_link())
        self.assertEqual(
            (parsed.server, parsed.terminal, parsed.title), ('https://outpost.example.com', 'iterm2', 'Build · dev')
        )
        self.assertEqual(
            parsed.websocket_url('t', 80, 24),
            'wss://outpost.example.com/api/terminal?token=t&cols=80&rows=24'
            '&client=connector&protocol=2&version=' + VERSION,
        )
        with self.assertRaisesRegex(link.LinkError, 'does not trust'):
            link.trusted(parsed)
        link.trust('https://OUTPOST.example.com/')
        self.assertIs(link.trusted(parsed), parsed)

    def test_rejects_bad_links(self):
        for bad in (
            'https://example.com',
            'outpost://connect/%%%',
            outpost_link(v=2),
            outpost_link(server='file:///etc'),
            outpost_link(server='https://user:pw@example.com'),
            outpost_link(token='a b'),
        ):
            with self.assertRaises(link.LinkError, msg=bad):
                link.parse(bad)
        self.assertEqual(
            link.parse(outpost_link(server='http://127.0.0.1:3000')).websocket_url('t', 1, 1)[:22],
            'ws://127.0.0.1:3000/ap',
        )


class WebSocketTest(unittest.TestCase):
    def test_handshake_frames_and_fragments(self):
        server = socket.socket()
        server.bind(('127.0.0.1', 0))
        server.listen(1)
        received = {}

        def serve():
            connection, _ = server.accept()
            request = b''
            while b'\r\n\r\n' not in request:
                request += connection.recv(4096)
            key = next(
                line.split(': ')[1] for line in request.decode().split('\r\n') if line.startswith('Sec-WebSocket-Key')
            )
            import hashlib

            accept = base64.b64encode(
                hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()
            ).decode()
            connection.sendall(
                (
                    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
                ).encode()
                + bytes([0x01, 3])
                + b'hel'
                + bytes([0x80, 2])
                + b'lo'
                + bytes([0x82, 1])
                + b'\x00'
            )
            data = connection.recv(4096)
            mask, payload = data[2:6], data[6 : 6 + (data[1] & 0x7F)]
            received['text'] = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            connection.close()

        thread = threading.Thread(target=serve)
        thread.start()
        client = WebSocket.connect('ws://127.0.0.1:' + str(server.getsockname()[1]) + '/api/terminal?token=x')
        messages = []
        import select

        while len(messages) < 2:
            select.select([client], [], [], 2)
            messages += client.read()
        self.assertEqual(messages, [(TEXT, b'hello'), (BINARY, b'\x00')])
        client.send_text('{"type":"ack"}')
        client.sock.setblocking(True)
        client.flush()
        thread.join(5)
        self.assertEqual(received['text'], b'{"type":"ack"}')
        client.shutdown()
        server.close()

    def test_large_masked_frames_round_trip(self):
        client = WebSocket(mock.Mock())
        payload = os.urandom(70000)
        client.send_binary(payload)
        frame = bytes(client.outgoing)
        self.assertEqual(frame[1], 0x80 | 127)
        mask = frame[10:14]
        unmasked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(frame[14:]))
        self.assertEqual(unmasked, payload)


class ClipboardTest(unittest.TestCase):
    def test_parses_helper_output(self):
        png = b'\x89PNG\r\n\x1a\n' + b'0' * 10
        self.assertEqual(
            parse_clipboard(json.dumps({'kind': 'image', 'data': base64.b64encode(png).decode()})).value, png
        )
        self.assertEqual(parse_clipboard('{"kind":"text","text":"hi"}').value, 'hi')
        self.assertEqual(parse_clipboard('{"kind":"empty"}').kind, 'empty')
        with self.assertRaises(ClipboardError):
            parse_clipboard(json.dumps({'kind': 'image', 'data': base64.b64encode(b'GIF89a').decode()}))


class TerminalTest(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix='outpost-terminal-'))
        self.addCleanup(shutil.rmtree, self.home, True)
        self.commands = []
        self.context = terminals.Context(
            self.home, self.home / '.outpost-connector' / 'bin' / 'outpost-connector', self.execute
        )

    def execute(self, command):
        self.commands.append(command)
        if command[0] == '/usr/bin/osacompile':
            contents = Path(command[2]) / 'Contents'
            contents.mkdir(parents=True)
            with (contents / 'Info.plist').open('wb') as stream:
                plistlib.dump({'CFBundleExecutable': 'applet'}, stream)
            self.handler = Path(command[3]).read_text()
        return 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'

    def test_iterm2_profile_and_handler(self):
        iterm2.install(self.context)
        profile = json.loads(iterm2.profile_path(self.context).read_text())['Profiles'][0]
        self.assertEqual(profile['Name'], 'Outpost')
        self.assertEqual(profile['Keyboard Map']['0x76-0x100000'], {'Action': 10, 'Text': '[9001~'})
        self.assertEqual(profile['Keyboard Map']['0xd-0x20000'], {'Action': 10, 'Text': '[13;2u'})
        info = plistlib.loads((iterm2.handler_path(self.context) / 'Contents' / 'Info.plist').read_bytes())
        self.assertEqual(info['CFBundleURLTypes'][0]['CFBundleURLSchemes'], ['outpost'])
        self.assertEqual(info['CFBundleExecutable'], 'applet', 'keeps osacompile settings')
        self.assertIn('on open location theURL', self.handler)
        self.assertIn(json.dumps(shlex.quote(str(self.context.launcher)) + ' open '), self.handler)
        self.assertEqual(
            [command[0] for command in self.commands], ['/usr/bin/osacompile', '/usr/bin/codesign', iterm2.LSREGISTER]
        )
        iterm2.open(outpost_link(), self.context)
        self.assertEqual(
            self.commands[-1][-1], shlex.quote(str(self.context.launcher)) + ' attach ' + shlex.quote(outpost_link())
        )

    def test_windows_terminal_fragment_and_handler(self):
        with mock.patch.dict(os.environ, {'WSL_DISTRO_NAME': 'Ubuntu'}):
            windows_terminal.install(self.context)
        script = base64.b64decode(self.commands[0][-1]).decode('utf-16-le')
        settings = json.loads(base64.b64decode(script.split("FromBase64String('")[1].split("'")[0]))
        fragment = json.loads(settings['fragment'])
        self.assertEqual(fragment['profiles'][0]['commandline'], 'wsl.exe -d Ubuntu')
        self.assertEqual(
            settings['command'],
            '"{wt}" -w 0 new-tab --profile "Outpost" wsl.exe -d "Ubuntu" --exec "'
            + str(self.context.launcher)
            + '" attach "%1"',
        )
        self.assertIn('HKCU:\\Software\\Classes\\outpost', script)


if __name__ == '__main__':
    unittest.main()
