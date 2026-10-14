import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const absWorkingDir = fileURLToPath(new URL('../', import.meta.url))
const root = new URL('../desktop/', import.meta.url)
const dist = new URL('dist/', root)
await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })
await build({
  absWorkingDir,
  entryPoints: ['desktop/src/main.ts', 'desktop/src/preload.ts', 'desktop/src/home-preload.ts'],
  outdir: 'desktop/dist',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
})
await build({
  absWorkingDir,
  entryPoints: ['desktop/src/home.ts'],
  outfile: 'desktop/dist/home.js',
  bundle: true,
  platform: 'browser',
  target: 'chrome140',
  format: 'iife',
  logLevel: 'info',
})
for (const file of ['home.html', 'home.css']) await cp(new URL('src/' + file, root), new URL(file, dist))
const png = await readFile(new URL('../public/outpost.png', import.meta.url))
await writeFile(new URL('outpost.png', dist), png)
await mkdir(new URL('resources/', root), { recursive: true })
await writeFile(new URL('resources/outpost.png', root), png)
// Native icon containers reuse derivatives of the approved SVG.
const icns = Buffer.alloc(16)
icns.write('icns')
icns.writeUInt32BE(16 + png.length, 4)
icns.write('ic09', 8)
icns.writeUInt32BE(8 + png.length, 12)
await writeFile(new URL('resources/outpost.icns', root), Buffer.concat([icns, png]))
const small = await readFile(new URL('../public/outpost-256.png', import.meta.url))
const ico = Buffer.alloc(22)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico.writeUInt16LE(1, 10)
ico.writeUInt16LE(32, 12)
ico.writeUInt32LE(small.length, 14)
ico.writeUInt32LE(22, 18)
await writeFile(new URL('resources/outpost.ico', root), Buffer.concat([ico, small]))
