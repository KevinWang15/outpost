import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { quote } from './shell'

const modules = [
  ['outpost_coding_protocol', './coding_protocol.py'],
  ['outpost_activity_state', './activity_state.py'],
  ['outpost_coding_activity', './coding_activity.py'],
  ['outpost_terminal_attachment', './terminal_attachment.py'],
  ['outpost_coding_sessions', './coding_sessions.py'],
  ['outpost_coding_rpc', './coding_rpc.py'],
  ['outpost_codex_store', './coding_adapters/codex_store.py'],
  ['outpost_claude_store', './coding_adapters/claude_store.py'],
  ['outpost_kimi_store', './coding_adapters/kimi_store.py'],
  ['outpost_codex_adapter', './coding_adapters/codex.py'],
  ['outpost_claude_adapter', './coding_adapters/claude.py'],
  ['outpost_kimi_adapter', './coding_adapters/kimi.py'],
].map(([name, path]) => [name, readFileSync(new URL(path, import.meta.url), 'utf8')])
// An array of strings is also a Python list literal. Serialize once to avoid
// expanding every source escape again inside a second JSON string.
const runtime = readFileSync(new URL('./session-runtime.py', import.meta.url), 'utf8')
function encodeProgram(sources: string[][]) {
  const program = `import sys, types\nfor name, source in ${JSON.stringify(sources)}:\n    module = types.ModuleType(name)\n    sys.modules[name] = module\n    exec(compile(source, name, 'exec'), module.__dict__)\n${runtime}`
  return deflateSync(program, { level: 9 }).toString('base64')
}
const managementProgram = encodeProgram(modules)
const attachProgram = encodeProgram(modules.filter(([name]) => ['outpost_coding_protocol', 'outpost_activity_state', 'outpost_terminal_attachment'].includes(name) || name.endsWith('_adapter')))
export function pythonCommand(request: Record<string, unknown>) {
  const payload = Buffer.from(JSON.stringify(request)).toString('base64')
  // Keep the attach command below Windows' native command-line length limit.
  const program = request.action === 'attach' ? attachProgram : managementProgram
  const bootstrap = `import base64,zlib;exec(zlib.decompress(base64.b64decode("${program}")))`
  return `python3 -c ${quote(bootstrap)} ${quote(payload)}`
}
