import { readFileSync, readdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { quote, supportingPath } from './shell'

// Target management is sent with each operation; the installed terminal service
// owns persistent PTYs. Modules load under their file names before the entry runs.
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
    '    def get_source(self, name):',
    '        return _sources[name]',
    '    def exec_module(self, module):',
    "        exec(compile(_sources[module.__name__], module.__name__, 'exec'), module.__dict__)",
    'sys.meta_path.insert(0, _Runtime())',
    read('outpost_runtime.py'),
  ].join('\n'),
  { level: 9 },
)

// Read only the upload bytes: buffered stdin could consume the relay frames or
// image data that follow them. Neither the program nor request belongs in argv.
const bootstrap = [
  'import os, sys, zlib',
  'def read_exact(size):',
  '    data = bytearray()',
  '    while len(data) < size:',
  '        chunk = os.read(0, min(size - len(data), 65536))',
  '        if not chunk:',
  "            raise EOFError('Incomplete Outpost runtime upload')",
  '        data.extend(chunk)',
  '    return data',
  '_program = read_exact(int(sys.argv[1]))',
  "sys.argv = ['-c', read_exact(int(sys.argv[2])).decode('ascii')]",
  'exec(zlib.decompress(_program))',
].join('\n')

/** A short shell command and its stdin prefix, followed by operation-specific input. */
export function runtimeOperation(request: object) {
  const payload = Buffer.from(Buffer.from(JSON.stringify(request)).toString('base64'), 'ascii')
  return {
    script: `${supportingPath}; exec python3 -c ${quote(bootstrap)} ${program.length} ${payload.length}`,
    input: Buffer.concat([program, payload]),
  }
}
