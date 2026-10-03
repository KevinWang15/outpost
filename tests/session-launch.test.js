import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

test('attachment validates expanded session selectors and evaluates normal arguments exactly once', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'outpost-launch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'capture-cli')
  await writeFile(executable, '#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n', { mode: 0o700 })
  const cases = []
  const ids = { codex: '12345678-1234-4123-8123-123456789012', claude: '12345678-1234-4123-8123-123456789012', kimi: 'session_launch_test' }
  const stores = { codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', kimi: 'KIMI_CODE_HOME' }
  const flags = { codex: '--last', claude: '--resume', kimi: '--session' }
  for (const tool of ['codex', 'claude', 'kimi']) {
    const base = { tool, cliSessionId: ids[tool], cliSessionEnv: { [stores[tool]]: root }, rootDir: root,
      env: { SELECTOR: flags[tool], MODEL: 'model with spaces é', EVALUATION_LOG: join(root, 'evaluations') } }
    const selectors = ['"$SELECTOR"', '"$SELECTOR"; printf SHOULD_NOT_RUN', `"$(printf %s ${flags[tool]})"`, `${flags[tool]}=OTHER`,
      ...(tool === 'claude' ? ['-rOTHER', '--session-id=OTHER', '--fork-session', '--no-session-persistence'] : []),
      ...(tool === 'kimi' ? ['-SOTHER', '--continue'] : [])]
    for (const args of selectors) cases.push({ session: { ...base, args }, blocked: true })
    cases.push({ session: { ...base, args: '--model "$(printf x >>"$EVALUATION_LOG"; printf %s "$MODEL")" --literal \'$(literal)\' --empty ""' },
      expected: ['--model', 'model with spaces é', '--literal', '$(literal)', '--empty', ''] })
    cases.push({ session: { ...base, args: `-- ${flags[tool]} ordinary-prompt` }, expected: ['--', flags[tool], 'ordinary-prompt'] })
    cases.push({ session: { ...base, args: '--model normal; printf SHOULD_NOT_RUN' }, expected: ['--model', 'normal'] })
  }
  const child = spawn('python3', [fileURLToPath(new URL('./fixtures/session-launch.py', import.meta.url))])
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })
  child.stdin.end(JSON.stringify(cases.map(({ session }) => ({ session, executable }))))
  await completed
  const results = JSON.parse(stdout)
  assert.equal(results.length, cases.length)
  for (const [index, result] of results.entries()) {
    const input = cases[index]
    if (input.blocked) {
      assert.equal(result.code, 64, `${input.session.tool}: ${input.session.args}`)
      assert.match(result.stderr, /manager controls the coding CLI session ID/)
      assert.equal(result.stdout, '', 'the CLI is never invoked with a conflicting selector')
    } else {
      assert.equal(result.code, 0, result.stderr)
      const argv = JSON.parse(result.stdout)
      assert.equal(argv[1], ids[input.session.tool], 'the injected native ID precedes user arguments')
      assert.deepEqual(argv.slice(2), input.expected)
    }
  }
  assert.equal(await readFile(join(root, 'evaluations'), 'utf8'), 'xxx')
})
