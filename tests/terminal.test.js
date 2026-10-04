import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { terminalScript } from '../backend/terminal.ts'
import { quote } from '../backend/shell.ts'

const execute = promisify(execFile)
const unix = process.platform !== 'win32'
const shells = ['bash', ...(process.env.OUTPOST_PWSH ? ['powershell'] : [])]

for (const shell of shells) test(`${shell} waits for Enter after clean exits and failures, preserves arguments, and restores a damaged terminal`, { skip: !unix, timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-reconnect-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const capture = join(directory, 'attempts.jsonl')
  const native = join(directory, "native O’Brien 'quotes' & é.py")
  await writeFile(native, `import json, os, sys, tty
from pathlib import Path
capture = Path(os.environ['OUTPOST_RECONNECT_CAPTURE'])
attempt = len(capture.read_text().splitlines()) + 1 if capture.exists() else 1
with capture.open('a') as stream:
    stream.write(json.dumps({'args': sys.argv[1:], 'tty': [os.isatty(fd) for fd in (0, 1, 2)], 'term': os.environ['TERM']}) + '\\n')
print('OUTPOST_ATTEMPT:' + str(attempt), flush=True)
# Simulate a client dying before it can restore its TTY and screen modes.
tty.setraw(0)
print('\\x1b[?1049h\\x1b[?25l\\x1b[?2004h', end='', flush=True)
os._exit(23 if attempt == 2 else 0)
`)
  const args = ['space & é', '$(touch INJECTED)', "O’Brien 'quotes'", 'a"b\\', '~/key with spaces']
  const script = join(directory, shell === 'bash' ? 'connection.sh' : 'connection.ps1')
  await writeFile(script, terminalScript({ executable: 'python3', args: [native, ...args], label: 'SSH', expandHome: true }, shell))
  const wrapper = join(directory, 'downloaded.sh')
  // Exercise stdin containing the script, as in the copied curl | bash command.
  await writeFile(wrapper, `cat ${quote(script)} | bash\n`)
  const runtime = shell === 'bash' ? ['bash', wrapper] : [process.env.OUTPOST_PWSH, '-NoLogo', '-NoProfile', '-File', script]
  const result = await execute('python3', [new URL('./fixtures/reconnect.py', import.meta.url).pathname, ...runtime], {
    env: { ...process.env, TERM: 'xterm-256color', OUTPOST_RECONNECT_CAPTURE: capture }, cwd: directory, timeout: 25_000,
  })
  assert.deepEqual(JSON.parse(result.stdout), { attempts: 3, restored: true })
  const attempts = (await readFile(capture, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.equal(attempts.length, 3)
  for (const attempt of attempts) {
    assert.deepEqual(attempt.args, [...args.slice(0, -1), join(process.env.HOME, args.at(-1).slice(2))])
    assert.deepEqual(attempt.tty, [true, true, true])
    assert.equal(attempt.term, 'xterm-256color')
  }
  await assert.rejects(readFile(join(directory, 'INJECTED')), { code: 'ENOENT' })
})

test('Bash rejects a connection without an interactive terminal', { skip: !unix }, async () => {
  await assert.rejects(execute('bash', ['-c', terminalScript({ executable: 'true', args: [], label: 'Local shell' }, 'bash')]), error => /Run this command in an interactive terminal/.test(error.stderr))
})
