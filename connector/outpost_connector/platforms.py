"""Operating system adapters: clipboard, links and TLS trust on your computer.

Terminal adapters (terminals/) build on these, so supporting another terminal
on an existing OS never touches clipboard code.
"""
import base64
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys

MAX_IMAGE = 16 * 1024 * 1024
MAX_TEXT = 1024 * 1024
PNG = b'\x89PNG\r\n\x1a\n'


class ClipboardError(OSError):
    pass


class Clipboard:
    """What a paste gesture found: ('image', png bytes) | ('text', str) | ('empty', None)."""
    def __init__(self, kind, value=None):
        self.kind = kind
        self.value = value


def parse_clipboard(output):
    try:
        result = json.loads(output)
    except ValueError:
        raise ClipboardError('Invalid clipboard response.')
    kind = result.get('kind') if isinstance(result, dict) else None
    if kind == 'empty':
        return Clipboard('empty')
    if kind == 'text' and isinstance(result.get('text'), str) and len(result['text'].encode()) <= MAX_TEXT:
        return Clipboard('text', result['text'])
    if kind == 'image' and isinstance(result.get('data'), str):
        data = base64.b64decode(result['data'])
        if 0 < len(data) <= MAX_IMAGE and data.startswith(PNG):
            return Clipboard('image', data)
    raise ClipboardError('The clipboard image is too large or unreadable.')


class Platform:
    name = 'unsupported'

    def read_clipboard(self, images_only=False):
        raise ClipboardError('Clipboard access is not supported on this computer.')

    def write_clipboard(self, text):
        raise ClipboardError('Clipboard access is not supported on this computer.')

    def open_url(self, url):
        raise OSError('Opening links is not supported on this computer.')

    def ssl_context(self):
        return ssl.create_default_context()


# Read only on a paste gesture; never polls or writes. PNG travels as base64.
MAC_CLIPBOARD = r'''ObjC.import('AppKit');
function present(value) { return value && !value.isNil(); }
var board = $.NSPasteboard.generalPasteboard;
var data = board.dataForType($.NSPasteboardTypePNG);
if (!present(data)) {
  var tiff = board.dataForType($.NSPasteboardTypeTIFF);
  if (present(tiff)) {
    var bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (!present(bitmap)) throw Error('Could not decode the clipboard image.');
    data = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  }
}
if (present(data)) {
  if (!data.length || data.length > %(max_image)d) throw Error('Images are limited to 16 MB.');
  JSON.stringify({ kind: 'image', data: ObjC.unwrap(data.base64EncodedStringWithOptions(0)) });
} else if (%(images_only)s) {
  JSON.stringify({ kind: 'empty' });
} else {
  var text = board.stringForType($.NSPasteboardTypeString);
  JSON.stringify(present(text) ? { kind: 'text', text: ObjC.unwrap(text) } : { kind: 'empty' });
}'''


class MacOS(Platform):
    name = 'macos'

    def read_clipboard(self, images_only=False):
        script = MAC_CLIPBOARD % {'max_image': MAX_IMAGE, 'images_only': 'true' if images_only else 'false'}
        result = subprocess.run(['/usr/bin/osascript', '-l', 'JavaScript', '-e', script], capture_output=True, timeout=10)
        if result.returncode:
            raise ClipboardError('Could not read the clipboard: ' + result.stderr.decode(errors='replace').strip()[:300])
        return parse_clipboard(result.stdout.decode())

    def write_clipboard(self, text):
        subprocess.run(['/usr/bin/pbcopy'], input=text.encode(), env={**os.environ, 'LANG': 'en_US.UTF-8'}, timeout=10, check=True)

    def open_url(self, url):
        subprocess.run(['/usr/bin/open', url], timeout=10, check=True)

    def ssl_context(self):
        context = ssl.create_default_context()
        capath = ssl.get_default_verify_paths().capath
        # Directory certificates load lazily, so they are not counted in the stats.
        if context.cert_store_stats().get('x509_ca') or (capath and os.path.isdir(capath) and os.listdir(capath)):
            return context
        # Some Python builds ship without a CA bundle; trust the system keychain roots.
        roots = subprocess.run(['/usr/bin/security', 'find-certificate', '-a', '-p',
                                '/System/Library/Keychains/SystemRootCertificates.keychain', '/Library/Keychains/System.keychain'],
                               capture_output=True, text=True, timeout=20)
        if roots.returncode == 0 and 'BEGIN CERTIFICATE' in roots.stdout:
            context.load_verify_locations(cadata=roots.stdout)
        return context


WINDOWS_CLIPBOARD = r'''$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$result = @{ kind = 'empty' }
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -ne $image) {
  $stream = New-Object IO.MemoryStream
  try {
    $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($stream.Length -eq 0 -or $stream.Length -gt %(max_image)d) { throw 'Images are limited to 16 MB.' }
    $result = @{ kind = 'image'; data = [Convert]::ToBase64String($stream.ToArray()) }
  } finally { $stream.Dispose(); $image.Dispose() }
} elseif (-not %(images_only)s -and [System.Windows.Forms.Clipboard]::ContainsText()) {
  $result = @{ kind = 'text'; text = [System.Windows.Forms.Clipboard]::GetText() }
}
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::Write(($result | ConvertTo-Json -Compress -Depth 3))'''
WINDOWS_WRITE = r'''$ErrorActionPreference = 'Stop'
$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
Set-Clipboard -Value $text'''


def encoded(script):
    return base64.b64encode(script.encode('utf-16-le')).decode()


class WSL(Platform):
    """WSL on Windows: Windows clipboard and browser through interop."""
    name = 'wsl'

    def windows(self, name, fallback):
        return shutil.which(name) or fallback

    def powershell(self, script, stdin=None, timeout=15):
        executable = self.windows('powershell.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
        # STA is required by the Windows clipboard API.
        result = subprocess.run([executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded(script)],
                                input=stdin, capture_output=True, timeout=timeout)
        if result.returncode:
            raise ClipboardError('Windows PowerShell failed: ' + result.stderr.decode(errors='replace').strip()[:300])
        return result.stdout.decode('utf-8', 'replace')

    def read_clipboard(self, images_only=False):
        return parse_clipboard(self.powershell(WINDOWS_CLIPBOARD % {'max_image': MAX_IMAGE, 'images_only': '$true' if images_only else '$false'}).strip())

    def write_clipboard(self, text):
        self.powershell(WINDOWS_WRITE, stdin=base64.b64encode(text.encode()))

    def open_url(self, url):
        # No shell parses the URL: rundll32 receives it as a single argument.
        subprocess.run([self.windows('rundll32.exe', '/mnt/c/Windows/System32/rundll32.exe'), 'url.dll,FileProtocolHandler', url], timeout=10, check=True)


class Fake(Platform):
    """Test seam: OUTPOST_CONNECTOR_FAKE=<directory> uses files instead of the OS."""
    name = 'fake'

    def __init__(self, directory):
        self.directory = Path(directory)

    def read_clipboard(self, images_only=False):
        image, text = self.directory / 'clipboard.png', self.directory / 'clipboard.txt'
        if image.exists():
            return Clipboard('image', image.read_bytes())
        if text.exists() and not images_only:
            return Clipboard('text', text.read_text())
        return Clipboard('empty')

    def write_clipboard(self, text):
        with open(self.directory / 'copied.txt', 'a') as stream:
            stream.write(text + '\n')

    def open_url(self, url):
        with open(self.directory / 'opened.txt', 'a') as stream:
            stream.write(url + '\n')


def is_wsl():
    if os.environ.get('WSL_DISTRO_NAME'):
        return True
    try:
        return 'microsoft' in Path('/proc/sys/kernel/osrelease').read_text().lower()
    except OSError:
        return False


def detect():
    if os.environ.get('OUTPOST_CONNECTOR_FAKE'):
        return Fake(os.environ['OUTPOST_CONNECTOR_FAKE'])
    if sys.platform == 'darwin':
        return MacOS()
    if sys.platform.startswith('linux') and is_wsl():
        return WSL()
    return Platform()
