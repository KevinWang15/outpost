// Backend for browser tests: a real local-mode server whose "this computer"
// target is a disposable home with fixture coding tools.
import { join } from 'node:path'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { fixtureHome, removeHome } from '../integration/helpers'

const { directory, home, env } = await fixtureHome('outpost-browser-')
const app = await createApp({ deployment: await LocalDeployment.open(join(directory, 'data')), env, multiplex: false })
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4179) })
console.log(`browser test backend ready; home ${directory}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => removeHome(directory, home))
      .finally(() => process.exit(0))
  })
}
