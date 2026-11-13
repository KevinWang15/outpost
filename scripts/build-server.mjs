import { rm } from 'node:fs/promises'
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
