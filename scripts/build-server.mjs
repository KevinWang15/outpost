import { copyFile, cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
await rm(new URL('../dist/server/', import.meta.url), { recursive: true, force: true })
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

await copyFile(new URL('../backend/session-runtime.py', import.meta.url), new URL('../dist/server/session-runtime.py', import.meta.url))
await copyFile(new URL('../backend/coding_sessions.py', import.meta.url), new URL('../dist/server/coding_sessions.py', import.meta.url))
await copyFile(new URL('../backend/coding_protocol.py', import.meta.url), new URL('../dist/server/coding_protocol.py', import.meta.url))
await copyFile(new URL('../backend/activity_state.py', import.meta.url), new URL('../dist/server/activity_state.py', import.meta.url))
await copyFile(new URL('../backend/coding_activity.py', import.meta.url), new URL('../dist/server/coding_activity.py', import.meta.url))
await copyFile(new URL('../backend/terminal_attachment.py', import.meta.url), new URL('../dist/server/terminal_attachment.py', import.meta.url))
await copyFile(new URL('../backend/coding_rpc.py', import.meta.url), new URL('../dist/server/coding_rpc.py', import.meta.url))
await cp(new URL('../backend/coding_adapters/', import.meta.url), new URL('../dist/server/coding_adapters/', import.meta.url), { recursive: true })
