import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  encodeSshBridgeInput,
  encodeSshBridgeOsc,
  isStandaloneAgentTool,
  parseSshBridgeOscData,
  SSH_BRIDGE_ENABLED,
  SSH_IMAGE_CHUNK_BYTES,
  SshBridgeInputScanner,
  type SshRemoteMessage,
} from '../../shared/sshBridgeProtocol'
import { harness } from '../../machine/harnesses'
import {
  buildShellInitFiles,
  prepareSshWrapLaunch,
  resolveRealExecutable,
  SshImageReceiver,
} from '../../machine/sshBridgeCore'
import { saveImageInDirectory } from '../../machine/files'
import { state } from '../../machine/state'

// Valid 1x1 PNG header + payload bytes for sniffMediaType verification.
const samplePng = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de' +
    '0000000c4944415408d763f8ffff3f0005fe02fea7d646420000000049454e44ae426082',
  'hex',
)

test('SSH bridge master switch is on by default and standalone MCP allowlist excludes session-only tools', () => {
  assert.equal(SSH_BRIDGE_ENABLED, true)
  assert.equal(isStandaloneAgentTool('search_history'), true)
  assert.equal(isStandaloneAgentTool('read_context'), true)
  assert.equal(isStandaloneAgentTool('read_message'), true)
  assert.equal(isStandaloneAgentTool('get_session'), true)
  assert.equal(isStandaloneAgentTool('refresh_index'), true)
  assert.equal(isStandaloneAgentTool('list_machines'), true)
  assert.equal(isStandaloneAgentTool('list_sessions'), true)
  assert.equal(isStandaloneAgentTool('publish_file'), false)
  assert.equal(isStandaloneAgentTool('message_session'), false)
  assert.equal(isStandaloneAgentTool('post_to_channel'), false)
  assert.equal(isStandaloneAgentTool('fetch_file'), false)
})

test('OSC 7770 SSH bridge protocol round-trips all message types and rejects invalid frames', () => {
  const cases = [
    { v: 1, t: 'ready', session: 'nonce_1', tool: 'claude', clipboard: true },
    { v: 1, t: 'bye', session: 'nonce_1' },
    { v: 1, t: 'shell' },
    { v: 1, t: 'img.begin', session: 'nonce_1', id: 'img-1', mime: 'image/png', size: 1024, mode: 'attachment' },
    { v: 1, t: 'img.ack', id: 'img-1', next: 1024, chunkSize: SSH_IMAGE_CHUNK_BYTES },
    { v: 1, t: 'img.data', id: 'img-1', offset: 0, data: samplePng.toString('base64') },
    { v: 1, t: 'img.done', id: 'img-1', ok: true, mode: 'path' },
    { v: 1, t: 'img.done', id: 'img-1', ok: false, message: 'Timed out.' },
    { v: 1, t: 'img.cancel', id: 'img-1' },
  ] as const

  for (const msg of cases) {
    const osc = encodeSshBridgeOsc(msg, 'st')
    assert.ok(osc.startsWith('\x1b]7770;outpost;ssh;'))
    assert.ok(osc.endsWith('\x1b\\'))
    const body = osc.slice('\x1b]7770;'.length, -2)
    assert.deepEqual(parseSshBridgeOscData(body), msg)
  }

  // Malformed version, tool, mime, id, and oversized chunk size are rejected.
  const bad = (obj: unknown) => `outpost;ssh;${Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url')}`
  assert.equal(parseSshBridgeOscData(bad({ v: 2, t: 'shell' })), null)
  assert.equal(parseSshBridgeOscData(bad({ v: 1, t: 'ready', session: 'ok', tool: 'vim', clipboard: true })), null)
  assert.equal(
    parseSshBridgeOscData(
      bad({ v: 1, t: 'img.begin', session: 's', id: '1', mime: 'text/plain', size: 10, mode: 'attachment' }),
    ),
    null,
  )
  assert.equal(parseSshBridgeOscData(bad({ v: 1, t: 'img.ack', id: 'bad id', next: 0 })), null)
  assert.equal(parseSshBridgeOscData(bad({ v: 1, t: 'img.ack', id: '1', next: 0, chunkSize: 999999 })), null)
})

test('SshBridgeInputScanner splits chunked PUA frames cleanly and passes through ESC/UTF-8 with zero delay', () => {
  const scanner = new SshBridgeInputScanner()
  const frame = encodeSshBridgeInput({
    v: 1,
    t: 'img.begin',
    session: 's1',
    id: 'i1',
    mime: 'image/png',
    size: 64,
    mode: 'attachment',
  })
  // Include bare Escape, CSI arrow keys, OSC, and unrelated UTF-8 (including 0xEE-prefixed CJK/PUA).
  const wire = Buffer.from(`abc\x1b[A\x1b中文${frame}xyz\x1b]0;title\x07`, 'utf8')
  const passed: Uint8Array[] = []
  const msgs = []
  for (let i = 0; i < wire.length; i++) {
    const { passthrough, messages } = scanner.scan(wire.subarray(i, i + 1))
    if (passthrough.length) passed.push(passthrough)
    msgs.push(...messages)
  }
  assert.equal(Buffer.concat(passed).toString('utf8'), 'abc\x1b[A\x1b中文xyz\x1b]0;title\x07')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].t, 'img.begin')

  // Bare Escape key passes through immediately with zero buffering.
  const esc = scanner.scan(Buffer.from([0x1b]))
  assert.deepEqual(Array.from(esc.passthrough), [0x1b])
  assert.equal(esc.messages.length, 0)
})

test('resolveRealExecutable strips wrapper directories (including symlinks) to prevent recursion loops', t => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-ssh-resolve-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const wrapDir = join(root, 'ssh-bin')
  const wrapLink = join(root, 'ssh-bin-link')
  const realDir = join(root, 'real-bin')
  mkdirSync(wrapDir, { recursive: true })
  mkdirSync(realDir, { recursive: true })
  if (process.platform !== 'win32') symlinkSync(wrapDir, wrapLink)
  const fakeWrap = join(wrapDir, 'claude')
  const fakeReal = join(realDir, 'claude')
  writeFileSync(fakeWrap, '#!/bin/sh\necho wrapper\n')
  writeFileSync(fakeReal, '#!/bin/sh\necho real\n')
  if (process.platform !== 'win32') {
    chmodSync(fakeWrap, 0o755)
    chmodSync(fakeReal, 0o755)
  }

  const pathEnv = [wrapDir, ...(process.platform !== 'win32' ? [wrapLink] : []), realDir].join(delimiter)
  const { executable, cleanPath } = resolveRealExecutable('claude', pathEnv, [wrapDir])
  assert.equal(executable, fakeReal)
  assert.equal(cleanPath, realDir)
})

test('buildShellInitFiles defines alias-safe highest-priority wrappers after user dotfiles', () => {
  const files = buildShellInitFiles('/home/u/.outpost/bin/outpost-terminal', '/home/u/.outpost/ssh-bin')
  assert.ok(files['bash.rc'].includes('. "$HOME/.bash_profile"'))
  assert.ok(files['bash.rc'].includes('function claude {'))
  assert.ok(files['bash.rc'].includes('function codex {'))
  assert.ok(files['bash.rc'].includes('function kimi {'))
  assert.ok(files['bash.rc'].includes('function agy {'))
  assert.ok(files['bash.rc'].includes('PROMPT_COMMAND'))
  assert.ok(files['zsh/.zshrc'].includes('precmd_functions+=(__outpost_ssh_prompt)'))
  assert.ok(files['fish/vendor_conf.d/outpost-ssh.fish'].includes('fish_add_path -p'))
})

test('prepareSshWrapLaunch injects Outpost MCP per harness cleanly and bypasses non-interactive CLI flags', async t => {
  const root = mkdtempSync(join(tmpdir(), 'outpost-ssh-wrap-'))
  const prevState = state.directory
  state.directory = join(root, 'state')
  t.after(() => {
    state.directory = prevState
    rmSync(root, { recursive: true, force: true })
  })

  // Non-interactive detection across harnesses.
  assert.equal(harness('claude').isInteractiveInvocation(['--version']), false)
  assert.equal(harness('claude').isInteractiveInvocation(['mcp', 'list']), false)
  assert.equal(harness('claude').isInteractiveInvocation(['-p', 'hello']), false)
  assert.equal(harness('claude').isInteractiveInvocation(['fix the bug']), true)
  assert.equal(harness('codex').isInteractiveInvocation(['login']), false)
  assert.equal(harness('codex').isInteractiveInvocation(['exec', 'hi']), false)
  assert.equal(harness('codex').isInteractiveInvocation(['resume', 'abc']), true)
  assert.equal(harness('kimi').isInteractiveInvocation(['acp']), false)
  assert.equal(harness('antigravity').isInteractiveInvocation(['acp']), false)

  // Claude places --mcp-config after positional prompt (or before --) so variadic flags never swallow it.
  const claudePos = await prepareSshWrapLaunch(
    'claude',
    ['fix', 'bug'],
    root,
    { HOME: root },
    {
      enrolled: true,
      executable: '/usr/bin/claude',
      cleanPath: '/usr/bin',
    },
  )
  assert.equal(claudePos.argv[0], 'fix')
  assert.equal(claudePos.argv[1], 'bug')
  assert.equal(claudePos.argv[2], '--mcp-config')
  const parsedClaudeMcp = JSON.parse(claudePos.argv[3])
  assert.equal(parsedClaudeMcp.mcpServers.outpost.env.OUTPOST_DRIVER, 'ssh')
  assert.equal(claudePos.env.OUTPOST_DRIVER, 'ssh')
  assert.equal(claudePos.env.OUTPOST_SSH_WRAP_ACTIVE, 'claude')

  const claudeSep = await prepareSshWrapLaunch(
    'claude',
    ['--model', 'opus', '--', 'fix'],
    root,
    { HOME: root },
    {
      enrolled: true,
      executable: '/usr/bin/claude',
      cleanPath: '/usr/bin',
    },
  )
  assert.equal(claudeSep.argv[2], '--mcp-config')
  assert.equal(claudeSep.argv[4], '--')
  assert.equal(claudeSep.argv[5], 'fix')

  // Codex prepends -c mcp_servers.outpost=... before resume args.
  const codex = await prepareSshWrapLaunch(
    'codex',
    ['resume', '123'],
    root,
    { HOME: root },
    {
      enrolled: true,
      executable: '/usr/bin/codex',
      cleanPath: '/usr/bin',
    },
  )
  assert.equal(codex.argv[0], '-c')
  assert.match(codex.argv[1], /^mcp_servers\.outpost=/)
  assert.equal(codex.argv[2], 'resume')
  assert.equal(codex.argv[3], '123')

  // Kimi & Antigravity install their shared plugins and inherit OUTPOST_DRIVER=ssh via env.
  const kimi = await prepareSshWrapLaunch(
    'kimi',
    ['--model', 'k2'],
    root,
    { HOME: root },
    {
      enrolled: true,
      executable: '/usr/bin/kimi',
      cleanPath: '/usr/bin',
    },
  )
  assert.deepEqual(kimi.argv, ['--model', 'k2'])
  assert.equal(existsSync(join(root, '.kimi-code', 'plugins', 'installed.json')), true)

  const agy = await prepareSshWrapLaunch(
    'antigravity',
    [],
    root,
    { HOME: root },
    {
      enrolled: true,
      executable: '/usr/bin/agy',
      cleanPath: '/usr/bin',
    },
  )
  assert.deepEqual(agy.argv, [])
  assert.equal(existsSync(join(root, '.gemini', 'config', 'plugins.json')), true)
})

test('SshImageReceiver reassembles chunked images and delivers via X11 clipboard or path fallback', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-ssh-img-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  // 1. Clipboard attachment path.
  const replies1: SshRemoteMessage[] = []
  let sentKey = 0
  let pastedImageSize = 0
  const receiver1 = new SshImageReceiver('nonce-1', m => replies1.push(m), {
    exited: () => false,
    clipboard: {
      async paste(image, _signal, sendKey) {
        pastedImageSize = image.bytes.length
        sendKey()
        return true
      },
    },
    sendKey: () => {
      sentKey++
    },
    pastePath: () => {
      throw new Error('Should not fall back to path when clipboard succeeds')
    },
  })
  receiver1.handle({
    v: 1,
    t: 'img.begin',
    session: 'nonce-1',
    id: 'tx-1',
    mime: 'image/png',
    size: samplePng.length,
    mode: 'attachment',
  })
  const half = Math.floor(samplePng.length / 2)
  receiver1.handle({ v: 1, t: 'img.data', id: 'tx-1', offset: 0, data: samplePng.subarray(0, half).toString('base64') })
  receiver1.handle({ v: 1, t: 'img.data', id: 'tx-1', offset: half, data: samplePng.subarray(half).toString('base64') })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(pastedImageSize, samplePng.length)
  assert.equal(sentKey, 1)
  assert.deepEqual(replies1.at(-1), { v: 1, t: 'img.done', id: 'tx-1', ok: true, mode: 'attachment' })

  // 2. Path fallback saves the exact PNG file to disk.
  const replies2: SshRemoteMessage[] = []
  let savedPath = ''
  const receiver2 = new SshImageReceiver('nonce-2', m => replies2.push(m), {
    exited: () => false,
    clipboard: null,
    sendKey: () => {},
    pastePath: image => {
      savedPath = saveImageInDirectory(dir, 'png', image.bytes)
    },
  })
  receiver2.handle({
    v: 1,
    t: 'img.begin',
    session: 'nonce-2',
    id: 'tx-2',
    mime: 'image/png',
    size: samplePng.length,
    mode: 'attachment',
  })
  receiver2.handle({ v: 1, t: 'img.data', id: 'tx-2', offset: 0, data: samplePng.toString('base64') })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(savedPath && existsSync(savedPath))
  assert.deepEqual(readFileSync(savedPath), samplePng)
  assert.deepEqual(replies2.at(-1), { v: 1, t: 'img.done', id: 'tx-2', ok: true, mode: 'path' })
})

test('standalone SSH MCP binding exposes history + machine/session read tools and blocks session-only tools', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-ssh-mcp-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const mcpModule = fileURLToPath(new URL('../../machine/mcp.ts', import.meta.url))
  const stateModule = fileURLToPath(new URL('../../machine/state.ts', import.meta.url))
  const tsxCli = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
  const child = spawn(
    process.execPath,
    [
      tsxCli,
      '-e',
      `import { serveMcp } from ${JSON.stringify(mcpModule)}; import { useMcpBinding } from ${JSON.stringify(stateModule)}; void serveMcp(useMcpBinding())`,
    ],
    {
      env: {
        ...process.env,
        OUTPOST_DRIVER: 'ssh',
        OUTPOST_STATE_DIRECTORY: '/tmp/outpost-ssh-mcp-test',
        OUTPOST_SESSION_ID: undefined,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
  t.after(() => child.kill())
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  const nextReply = async () => {
    const next = await lines.next()
    if (next.done) throw new Error('MCP server closed early')
    return JSON.parse(next.value) as Record<string, unknown>
  }
  const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`)

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  const init = await nextReply()
  assert.equal(init.id, 1)

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const listed = await nextReply()
  const names = ((listed.result as { tools: Array<{ name: string }> }).tools ?? []).map(tool => tool.name)
  assert.ok(names.includes('search_history'))
  assert.ok(names.includes('read_context'))
  assert.ok(names.includes('list_machines'))
  assert.ok(names.includes('list_sessions'))
  assert.ok(!names.includes('publish_file'))
  assert.ok(!names.includes('message_session'))
  assert.ok(!names.includes('post_to_channel'))
  assert.ok(!names.includes('fetch_file'))

  // Calling a session-only tool is cleanly rejected.
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'publish_file', arguments: { path: '/tmp/x' } } })
  const denied = await nextReply()
  assert.equal((denied.result as { isError?: boolean }).isError, true)

  child.stdin.end()
  await new Promise<void>(resolve => child.once('exit', () => resolve()))
})
