import { cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = new URL('../dist/', import.meta.url)
await rm(new URL('server/', dist), { recursive: true, force: true })
await build({
  absWorkingDir: root,
  entryPoints: ['backend/server.ts'],
  outfile: 'dist/server/server.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  packages: 'external',
  tsconfig: 'tsconfig.node.json',
  sourcemap: true,
  logLevel: 'info',
})
// The server resolves these relative to itself: the target runtime it sends
// with each operation, and the connector it serves to your computer.
const python = source => !source.includes('__pycache__')
for (const directory of ['runtime', 'connector']) {
  await rm(new URL(`${directory}/`, dist), { recursive: true, force: true })
  await cp(new URL(`../${directory}/`, import.meta.url), new URL(`${directory}/`, dist), {
    recursive: true,
    filter: python,
  })
}
