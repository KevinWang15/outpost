import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'
import { maxImageBytes, type SessionImageInput } from '../shared/session-manager'

const execute = promisify(execFile)
export type NativeClipboard = { kind: 'image'; image: SessionImageInput } | { kind: 'text'; text: string } | { kind: 'empty' }
const maxTextBytes = 1024 * 1024

// These scripts run only for a local paste gesture. Neither polls the clipboard
// nor writes to it. Images travel as PNG without temporary clipboard files.
export const macClipboardScript = `ObjC.import('AppKit');
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
  if (!data.length || data.length > ${maxImageBytes}) throw Error('Images are limited to 16 MB.');
  JSON.stringify({ kind: 'image', image: { mediaType: 'image/png', data: ObjC.unwrap(data.base64EncodedStringWithOptions(0)) } });
} else {
  var text = board.stringForType($.NSPasteboardTypeString);
  if (present(text) && text.lengthOfBytesUsingEncoding($.NSUTF8StringEncoding) > ${maxTextBytes}) throw Error('Clipboard text is limited to 1 MB.');
  JSON.stringify(present(text) ? { kind: 'text', text: ObjC.unwrap(text) } : { kind: 'empty' });
}`

export const windowsClipboardScript = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$result = @{ kind = 'empty' }
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -ne $image) {
  $stream = New-Object IO.MemoryStream
  try {
    $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($stream.Length -eq 0 -or $stream.Length -gt ${maxImageBytes}) { throw 'Images are limited to 16 MB.' }
    $result = @{ kind = 'image'; image = @{ mediaType = 'image/png'; data = [Convert]::ToBase64String($stream.ToArray()) } }
  } finally { $stream.Dispose(); $image.Dispose() }
} elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
  $text = [System.Windows.Forms.Clipboard]::GetText()
  if ([Text.Encoding]::UTF8.GetByteCount($text) -gt ${maxTextBytes}) { throw 'Clipboard text is limited to 1 MB.' }
  $result = @{ kind = 'text'; text = $text }
}
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::Write(($result | ConvertTo-Json -Compress -Depth 3))
`

export function clipboardCommand(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return { executable: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', macClipboardScript] }
  if (platform === 'win32') {
    // Windows PowerShell is available alongside PowerShell 7 and supplies the
    // desktop framework. STA is required by the Windows clipboard API.
    const root = Object.entries(env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1]
    const executable = root ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe'
    return { executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(windowsClipboardScript, 'utf16le').toString('base64')] }
  }
  throw new Error('Native clipboard paste supports macOS and Windows.')
}

export function parseClipboardResult(stdout: string): NativeClipboard {
  let result: NativeClipboard
  try { result = JSON.parse(stdout) }
  catch { throw new Error('Invalid clipboard response.') }
  if (result?.kind === 'empty') return result
  if (result?.kind === 'text' && typeof result.text === 'string' && Buffer.byteLength(result.text) <= maxTextBytes) return result
  if (result?.kind === 'image' && result.image?.mediaType === 'image/png' && typeof result.image.data === 'string') {
    const { data } = result.image
    if (data.length <= Math.ceil(maxImageBytes / 3) * 4) {
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length > 0 && bytes.length <= maxImageBytes && bytes.toString('base64') === data
        && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return result
    }
  }
  throw new Error('Invalid or oversized clipboard data.')
}

export async function readNativeClipboard(signal: AbortSignal): Promise<NativeClipboard> {
  const command = clipboardCommand()
  try {
    const { stdout } = await execute(command.executable, command.args, {
      signal, timeout: 10_000, maxBuffer: Math.ceil(maxImageBytes / 3) * 4 + 4096, windowsHide: true, encoding: 'utf8',
    })
    return parseClipboardResult(stdout.trim())
  } catch (error) {
    if (signal.aborted) throw error
    const failure = error as Error & { stderr?: string }
    // Helper errors describe the clipboard operation, not the clipboard data.
    throw new Error(`Could not read the local clipboard: ${(failure.stderr?.trim() || failure.message).slice(0, 1000)}`, { cause: error })
  }
}
