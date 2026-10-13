import { readFileSync, readdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { quote, supportingPath } from './shell'

// The target runtime is sent with every operation (principle: agentless
// targets). Modules are registered under their file names, then the entry runs.
const directory = new URL('../runtime/', import.meta.url)
const read = (name: string) => readFileSync(new URL(name, directory), 'utf8')
const modules = readdirSync(directory)
  .filter(name => /^outpost_\w+\.py$/.test(name) && name !== 'outpost_runtime.py')
  .sort()

function sourceLiteral(source: string) {
  // Raw strings preserve source escapes and compress well; fall back when unsafe.
  const delimiter = ["'''", '"""'].find(value => !source.includes(value))
  return delimiter && source.endsWith('\n') && !source.endsWith('\\\n')
    ? `r${delimiter}${source}${delimiter}`
    : JSON.stringify(source)
}

// Modules load on first import, so operations never execute code they do not use.
const program = deflateSync(
  [
    'import importlib.util, sys',
    `_sources = {${modules.map(name => `${JSON.stringify(name.slice(0, -3))}:${sourceLiteral(read(name))}`).join(',')}}`,
    'class _Runtime:',
    '    def find_spec(self, name, path=None, target=None):',
    '        return importlib.util.spec_from_loader(name, self) if name in _sources else None',
    '    def create_module(self, spec):',
    '        return None',
    '    def exec_module(self, module):',
    "        exec(compile(_sources[module.__name__], module.__name__, 'exec'), module.__dict__)",
    'sys.meta_path.insert(0, _Runtime())',
    read('outpost_runtime.py'),
  ].join('\n'),
  { level: 9 },
).toString('base64')

/** Shell text that runs one runtime request on the target. */
export function runtimeOperation(request: object) {
  const payload = Buffer.from(JSON.stringify(request)).toString('base64')
  const bootstrap = `import base64,zlib;exec(zlib.decompress(base64.b64decode("${program}")))`
  return `${supportingPath}; exec python3 -c ${quote(bootstrap)} ${quote(payload)}`
}
