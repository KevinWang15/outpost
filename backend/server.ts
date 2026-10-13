import 'dotenv/config'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { LocalDeployment, type Deployment } from './deployment'
import { HostedDeployment } from './hosted/deployment'
import { loopbackHost } from '../shared/loopback'

const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535')
const mode = process.env.OUTPOST_MODE ?? 'local'
if (!['local', 'hosted'].includes(mode)) throw new Error('OUTPOST_MODE must be local or hosted')
const directory = process.env.OUTPOST_DATA_DIR ?? join(homedir(), '.outpost')
// Relative to dist/server/server.js, independent of the working directory.
const frontendRoot = fileURLToPath(new URL('../client/', import.meta.url))
const built = existsSync(frontendRoot)

const deployment: Deployment = mode === 'hosted'
  ? await HostedDeployment.open({ directory, publicUrl: process.env.PUBLIC_APP_URL ?? (built ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:5173') })
  : await LocalDeployment.open(directory)
const production = deployment instanceof HostedDeployment && deployment.production
const app = await createApp({
  deployment,
  logger: true,
  multiplex: process.env.OUTPOST_SSH_MULTIPLEX !== '0',
  ...(process.env.OUTPOST_TRUST_PROXY ? { trustProxy: process.env.OUTPOST_TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean) } : {}),
  ...(built ? { frontendRoot } : {}),
})
// WSL forwards Windows' localhost only to wildcard listeners. Forwarded
// connections arrive from 127.0.0.1, and the request guard still admits only
// loopback peers, so the WSL network address itself stays unusable.
const wsl = Boolean(process.env.WSL_DISTRO_NAME) || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')
const host = production ? (process.env.HOST ?? '0.0.0.0') : process.env.HOST ? loopbackHost(process.env.HOST) : wsl ? '0.0.0.0' : '127.0.0.1'
const address = await app.listen({ port, host })
console.log(`Outpost ${mode} mode listening at ${address}`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    const deadline = setTimeout(() => process.exit(1), 10_000).unref()
    void app.close().catch(error => {
      app.log.error(error)
      process.exitCode = 1
    }).finally(() => clearTimeout(deadline))
  })
}
