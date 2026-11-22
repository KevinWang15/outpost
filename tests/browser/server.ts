// Backend for browser tests: a real local-mode server whose "this computer"
// target is a disposable home with fixture coding tools.
import { execFileSync } from 'node:child_process'
import { cp, mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { managedSocket } from '../../backend/machines'
import { quote } from '../../shared/shell'
import { fixtureHome, provisionMachine, removeHome } from '../integration/helpers'

const { directory, home, env } = await fixtureHome('outpost-browser-')
const project = join(home, 'fork-project')
execFileSync('git', ['init', '-b', 'main', project], { env, stdio: 'pipe' })
execFileSync(
  'git',
  [
    '-C',
    project,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'Initial commit',
  ],
  { env, stdio: 'pipe' },
)
// Each local target in the browser suite represents a separately installed machine.
const hosts: Awaited<ReturnType<typeof fixtureHome>>[] = []
const deployment = await LocalDeployment.open(join(directory, 'data'))
const bin = join(home, '.outpost/bin/outpost-terminal')
const nodes = join(directory, 'nodes')
await mkdir(nodes)
await rename(bin, bin + '.real')
await writeFile(
  bin,
  `#!/bin/sh
set -eu
case "$1:\${2:-}" in
  node:--socket|--version:--managed)
    machine=$(readlink ${quote(nodes)}/"\${3##*/}")
    export HOME="$machine" CODEX_HOME="$machine/.codex" CLAUDE_CONFIG_DIR="$machine/.claude" KIMI_CODE_HOME="$machine/.kimi-code" DSH_HOME="$machine/.dsh" ANTIGRAVITY_GEMINI_DIR="$machine/.gemini"
    exec "$machine/.outpost/bin/outpost-terminal" "$@" ;;
esac
exec ${quote(bin + '.real')} "$@"
`,
  { mode: 0o700 },
)
const app = await createApp({
  history: false,
  deployment,
  env,
  multiplex: false,
})
app.addHook('preSerialization', async (request, reply, payload) => {
  if (request.method === 'POST' && request.routeOptions.url === '/api/targets' && reply.statusCode === 201) {
    const target = payload as { kind: string; id: string }
    if (target.kind === 'local') {
      const fixture = await fixtureHome('outpost-browser-node-')
      hosts.push(fixture)
      const socket = managedSocket(deployment.secret, deployment.owner(), target.id)
      provisionMachine(fixture.home, socket)
      await cp(project, join(fixture.home, 'fork-project'), { recursive: true })
      const shared = join(fixture.home, 'shared-terminal')
      await mkdir(shared)
      await Promise.all(['capture-input', 'answer-prompts'].map(file => writeFile(join(shared, file), '')))
      await symlink(fixture.home, join(nodes, socket.slice('run/'.length)))
    }
  }
  return payload
})
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4179) })
console.log(`browser test backend ready; home ${directory}`)
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(async () => {
        for (const fixture of hosts) await removeHome(fixture.directory, fixture.home)
        await removeHome(directory, home)
      })
      .finally(() => process.exit(0))
  })
}
