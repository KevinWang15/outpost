import 'dotenv/config'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { loopbackHost } from '../shared/loopback'
import { Accounts } from './accounts'

const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be an integer between 0 and 65535')
}
const mode = process.env.OUTPOST_MODE ?? 'hosted'
if (!['local', 'hosted'].includes(mode)) throw new Error('OUTPOST_MODE must be local or hosted')
// Relative to dist/server/server.js, independent of the process working directory.
const frontendRoot = fileURLToPath(new URL('../client/', import.meta.url))
const accounts = mode === 'hosted' ? await Accounts.open({ publicUrl: process.env.PUBLIC_APP_URL ?? (existsSync(frontendRoot) ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:5173') }) : undefined
const host = accounts?.production ? (process.env.HOST ?? '0.0.0.0') : loopbackHost(process.env.HOST)
const app = await createApp({
  logger: true,
  accounts,
  ...(process.env.OUTPOST_TRUST_PROXY ? { trustProxy: process.env.OUTPOST_TRUST_PROXY.split(',').map(value => value.trim()).filter(Boolean) } : {}),
  ...(existsSync(frontendRoot) ? { frontendRoot } : {}),
})
const address = await app.listen({ port, host })
console.log(`Server listening at ${address}`)

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
