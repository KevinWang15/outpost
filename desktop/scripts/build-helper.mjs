import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
await build({
  absWorkingDir: root,
  entryPoints: ['src/native-helper.ts'],
  outfile: 'dist/outpost-helper.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  nodePaths: [fileURLToPath(new URL('../node_modules/', import.meta.url))],
  external: ['bufferutil', 'utf-8-validate'],
})
