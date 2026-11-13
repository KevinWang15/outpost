import { mkdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

// Baseline x64 avoids an AVX2 requirement on older targets. The runtime and
// terminal engine are embedded: targets need neither Node nor Bun installed.
const targets = {
  'x64-glibc': 'bun-linux-x64-baseline',
  'arm64-glibc': 'bun-linux-arm64',
  'x64-musl': 'bun-linux-x64-musl-baseline',
  'arm64-musl': 'bun-linux-arm64-musl',
}
const requested = process.argv[2] ?? `${process.arch}-glibc`
if (!(requested in targets)) throw new Error(`Unknown build target: ${requested}`)
await import('./vendor-agents.mjs')
await mkdir('machine/dist', { recursive: true })
const output = resolve(`machine/dist/outpost-terminal-linux-${requested}`)
const result = spawnSync(
  'bun',
  ['build', '--compile', `--target=${targets[requested]}`, '--minify', 'machine/main.ts', '--outfile', output],
  { stdio: 'inherit' },
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
