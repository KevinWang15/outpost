import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import test from 'node:test'
import { clipboardCommand, parseClipboardResult, readNativeClipboard } from '../backend/native-clipboard.ts'
import { desktopConnectScript } from '../backend/native-launch.ts'

const execute = promisify(execFile)
const png = await readFile(new URL('../public/favicon-16x16.png', import.meta.url))

test('native clipboard decoding bounds and validates images and Unicode text without exposing invalid payloads', () => {
  const image = { kind: 'image', image: { mediaType: 'image/png', data: png.toString('base64') } }
  assert.deepEqual(parseClipboardResult(JSON.stringify(image)), image)
  const text = { kind: 'text', text: '本地 🙂\nclipboard' }
  assert.deepEqual(parseClipboardResult(JSON.stringify(text)), text)
  assert.deepEqual(parseClipboardResult('{"kind":"empty"}'), { kind: 'empty' })
  for (const result of [null, { kind: 'text', text: 3 }, { kind: 'text', text: '漢'.repeat(400_000) },
    { kind: 'image', image: { mediaType: 'image/svg+xml', data: '<svg/>' } },
    { kind: 'image', image: { mediaType: 'image/png', data: Buffer.alloc(16 * 1024 * 1024 + 1).toString('base64') } },
    { kind: 'image', image: { mediaType: 'image/png', data: 'aW52YWxpZA==' } }]) {
    assert.throws(() => parseClipboardResult(JSON.stringify(result)), /Invalid or oversized clipboard/)
  }
  assert.throws(() => parseClipboardResult('private clipboard contents'), { message: 'Invalid clipboard response.' })
})

test('native launch is limited to local macOS/Windows desktop scripts and carries no remote session token', () => {
  const target = { id: 'target', kind: 'ssh', name: 'Native', host: 'dev.example', backends: ['tmux'], tools: ['codex'], createdAt: '2026-10-10T00:00:00Z' }
  const signals = { OUTPOST_SIGNAL_ENV: '/remote/session/signals.env', OUTPOST_SESSION_TOKEN: 'must-not-travel' }
  for (const platform of ['darwin', 'win32']) {
    const script = desktopConnectScript(target, 'work', 'powershell', signals, platform)
    const encoded = /FromBase64String\('([^']+)'\)/.exec(script)[1]
    const command = JSON.parse(Buffer.from(encoded, 'base64').toString())
    assert.equal(command.executable, process.execPath)
    assert.ok(command.args.some(arg => arg.endsWith('native-terminal.ts')))
    const config = JSON.parse(Buffer.from(command.args.at(-1), 'base64').toString())
    assert.deepEqual(config, { target, sessionId: 'work', signalEnvironment: signals.OUTPOST_SIGNAL_ENV })
    assert.equal(JSON.stringify(config).includes(signals.OUTPOST_SESSION_TOKEN), false)
  }
  assert.match(desktopConnectScript(target, 'work', 'bash', signals, 'linux'), /'ssh'/)
  assert.equal(clipboardCommand('darwin').executable, '/usr/bin/osascript')
  const windows = clipboardCommand('win32', { SystemRoot: 'C:\\Windows' })
  assert.equal(windows.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.ok(windows.args.includes('-STA'))
  assert.throws(() => clipboardCommand('linux'), /macOS and Windows/)
})

// CI opts in on disposable desktop runners. Ordinary npm test never overwrites
// the clipboard on a developer's computer.
test('the actual OS clipboard reader handles a PNG, Unicode text, and an empty clipboard', {
  skip: process.env.OUTPOST_NATIVE_CLIPBOARD_TEST !== '1' || !['darwin', 'win32'].includes(process.platform), timeout: 30_000,
}, async () => {
  const text = 'Outpost 本地 🙂\nclipboard', encoded = png.toString('base64')
  async function set(kind) {
    if (process.platform === 'darwin') {
      const script = `ObjC.import('AppKit'); var p = $.NSPasteboard.generalPasteboard; p.clearContents; ${kind === 'image' ? `p.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions('${encoded}', 0), $.NSPasteboardTypePNG);` : kind === 'text' ? `p.setStringForType($(${JSON.stringify(text)}), $.NSPasteboardTypeString);` : ''}`
      await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script])
    } else {
      const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; [System.Windows.Forms.Clipboard]::Clear(); ${kind === 'image' ? `$s = New-Object IO.MemoryStream(,[Convert]::FromBase64String('${encoded}')); $b = [Drawing.Image]::FromStream($s); try { [Windows.Forms.Clipboard]::SetImage($b) } finally { $b.Dispose(); $s.Dispose() }` : kind === 'text' ? `[Windows.Forms.Clipboard]::SetText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text).toString('base64')}')))` : ''}`
      await execute(clipboardCommand().executable, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
    }
  }
  try {
    await set('image')
    const image = await readNativeClipboard(new AbortController().signal)
    assert.equal(image.kind, 'image')
    assert.equal(image.image.mediaType, 'image/png')
    assert.ok(Buffer.from(image.image.data, 'base64').subarray(0, 8).equals(png.subarray(0, 8)))
    await set('text')
    assert.deepEqual(await readNativeClipboard(new AbortController().signal), { kind: 'text', text })
    await set('empty')
    assert.deepEqual(await readNativeClipboard(new AbortController().signal), { kind: 'empty' })
  } finally { await set('empty') }
})
