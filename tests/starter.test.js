import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { SourceMap } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

const project = fileURLToPath(new URL('../', import.meta.url))

async function waitFor(predicate, describe) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${describe}`)
}

function launch(cwd, tool, args) {
  const bins = {
    tsc: '@typescript/native/bin/tsc',
    tsx: 'tsx/dist/cli.mjs',
    vite: 'vite/bin/vite.js',
  }
  const commandArgs = tool === 'node' ? args : [join(project, 'node_modules', bins[tool]), ...args]
  const child = spawn(process.execPath, commandArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const completion = once(child, 'close')
  return { child, completion, output: () => output }
}

async function run(cwd, tool, args, expectedCode = 0) {
  const process = launch(cwd, tool, args)
  const timer = setTimeout(() => process.child.kill('SIGKILL'), 30_000)
  try {
    const [code] = await process.completion
    assert.equal(code, expectedCode, process.output())
    return process.output()
  } finally {
    clearTimeout(timer)
  }
}

async function connectInspector(url) {
  const socket = new WebSocket(url)
  const messages = []
  const pending = new Map()
  let nextId = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (!message.id) {
      messages.push(message)
      return
    }
    const command = pending.get(message.id)
    if (!command) return
    clearTimeout(command.timer)
    pending.delete(message.id)
    if (message.error) command.reject(new Error(JSON.stringify(message.error)))
    else command.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const command of pending.values()) {
      clearTimeout(command.timer)
      command.reject(new Error('Inspector disconnected'))
    }
    pending.clear()
  })
  await once(socket, 'open', { signal: AbortSignal.timeout(5000) })
  return {
    socket,
    messages,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Inspector command timed out: ${method}`))
        }, 5000)
        pending.set(id, { resolve, reject, timer })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
  }
}

test('starter tooling works in an isolated temporary project', { timeout: 90_000 }, async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'ts-fullstack-starter-'))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  for (const file of ['package.json', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'index.html']) {
    await copyFile(join(project, file), join(fixture, file))
  }
  await symlink(join(project, 'node_modules'), join(fixture, 'node_modules'), 'junction')
  for (const directory of ['frontend', 'backend', 'shared']) {
    await mkdir(join(fixture, directory))
  }
  await copyFile(join(project, 'shared/loopback.ts'), join(fixture, 'shared/loopback.ts'))
  // Local packages exercise ESM exports and CommonJS default imports without installing dependencies.
  for (const [name, type, source, types] of [
    ['fixture-esm', 'module', 'export default function double(value) { return value * 2 }', 'export default function double(value: number): number'],
    ['fixture-cjs', 'commonjs', 'module.exports = value => "mixed-modules:" + value', 'declare function format(value: number): string; export = format'],
  ]) {
    const directory = join(fixture, 'shared/node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name, type, exports: { '.': { types: './index.d.ts', default: './index.js' } },
    }))
    await writeFile(join(directory, 'index.js'), source)
    await writeFile(join(directory, 'index.d.ts'), types)
  }
  await writeFile(join(fixture, 'shared/interop.ts'), `
import double from 'fixture-esm'
import format from 'fixture-cjs'
export const mixed = format(double(21))
`)
  const sharedFile = join(fixture, 'shared/value.ts')
  await writeFile(sharedFile, 'export const value: string = "fixture-initial"\n')
  await writeFile(join(fixture, 'backend/dynamic.ts'), 'export default "dynamic-import"\n')
  const nodeFile = join(fixture, 'backend/main.ts')
  const nodeSource = `
import { value } from '@shared/value'
import { value as root } from '@/shared/value'
import { mixed } from '@/shared/interop'
const dynamic = await import('./dynamic')
const rootDynamic = await import('@/backend/dynamic.ts')
console.log(JSON.stringify({ value, root, mixed, dynamic: dynamic.default, rootDynamic: rootDynamic.default }))
`
  await writeFile(nodeFile, nodeSource)
  await writeFile(join(fixture, 'frontend/main.tsx'), `
import { createRoot } from 'react-dom/client'
import { value } from '@/shared/value'
import { mixed } from '@shared/interop'
import './style.scss'
createRoot(document.getElementById('root')!).render(<span>{value} {mixed}</span>)
`)
  await writeFile(join(fixture, 'frontend/style.scss'), '$color: #123456; body { color: $color; }\n')

  await t.test('typechecks frontend, backend, and shared modules', async () => {
    await run(fixture, 'tsc', ['--noEmit'])
    await run(fixture, 'tsc', ['--noEmit', '-p', 'tsconfig.node.json'])
    try {
      await writeFile(nodeFile, `${nodeSource}\nconst invalid: number = "wrong"; console.log(invalid)\n`)
      const output = await run(fixture, 'tsc', ['--noEmit', '-p', 'tsconfig.node.json'], 1)
      assert.match(output, /TS2322/)
    } finally {
      await writeFile(nodeFile, nodeSource)
    }
  })

  await t.test('runs aliases, mixed ESM/CommonJS packages, and extensionless dynamic imports in Node', async () => {
    const output = await run(fixture, 'tsx', ['backend/main.ts'])
    assert.deepEqual(JSON.parse(output), {
      value: 'fixture-initial', root: 'fixture-initial',
      mixed: 'mixed-modules:42',
      dynamic: 'dynamic-import', rootDynamic: 'dynamic-import',
    })
  })

  await t.test('discovers TS modules by file URL after additions and deletions', async () => {
    const modules = join(fixture, 'backend/plugin modules 中文')
    await mkdir(modules)
    await writeFile(join(modules, 'a.ts'), 'export default "a"\n')
    await writeFile(join(modules, 'types.d.ts'), 'export declare const ignored: string\n')
    const entry = join(fixture, 'backend/discover.ts')
    await writeFile(entry, `
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const directory = new URL('./plugin modules 中文/', import.meta.url)
const files = (await readdir(directory)).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts')).sort()
const modules = await Promise.all(files.map(file => import(new URL(file, directory).href)))
console.log(JSON.stringify({ filename: fileURLToPath(import.meta.url), modules: modules.map(module => module.default) }))
`)
    const discover = async () => JSON.parse(await run(fixture, 'tsx', [entry]))
    assert.deepEqual(await discover(), { filename: entry, modules: ['a'] })
    await writeFile(join(modules, 'b 空格.ts'), 'export default "b"\n')
    assert.deepEqual(await discover(), { filename: entry, modules: ['a', 'b'] })
    await rm(join(modules, 'a.ts'))
    assert.deepEqual(await discover(), { filename: entry, modules: ['b'] })
    await run(fixture, 'tsc', ['--noEmit', '-p', 'tsconfig.node.json'])
  })

  await t.test('runs the same TypeScript entry with the IDE launch runtime', async () => {
    const launchConfig = JSON.parse(await readFile(join(project, '.vscode/launch.json'), 'utf8'))
    const { runtimeArgs } = launchConfig.configurations[0]
    const output = await run(fixture, 'node', [...runtimeArgs, nodeFile])
    assert.deepEqual(JSON.parse(output), JSON.parse(await run(fixture, 'tsx', [nodeFile])))
  })

  await t.test('reconnects to the inspector and hits mapped TS breakpoints after watcher restarts', async () => {
    const launchConfig = JSON.parse(await readFile(join(project, '.vscode/launch.json'), 'utf8'))
    const attach = launchConfig.configurations.find(config => config.request === 'attach')
    const pkg = JSON.parse(await readFile(join(fixture, 'package.json'), 'utf8'))
    const [tool, ...debugArgs] = pkg.scripts['ts:debug'].split(' ')
    // Reserve an available test port instead of interfering with a developer's debugger.
    const reservation = createNetServer()
    reservation.listen(0, attach.address)
    await once(reservation, 'listening')
    const { port } = reservation.address()
    await new Promise(resolve => reservation.close(resolve))
    const args = debugArgs.map(arg => arg.replace(`:${attach.port}`, `:${port}`))
    const entry = join(fixture, 'backend/debug.ts')
    const source = marker => `import { value } from '@/shared/value'\nconst marker: string = "${marker}"\nsetInterval(() => {\n  console.log(marker, value)\n}, 100)\n`
    await writeFile(entry, source('debug-initial'))
    const watcher = launch(fixture, tool, [...args, entry])
    const clients = []
    try {
      const endpoints = () => [...watcher.output().matchAll(/Debugger listening on (ws:\/\/[^\s]+)/g)].map(match => match[1])
      async function hitBreakpoint(url, marker) {
        const client = await connectInspector(url)
        clients.push(client)
        await client.send('Debugger.enable')
        await client.send('Runtime.runIfWaitingForDebugger')
        await waitFor(() => client.messages.some(message => message.method === 'Debugger.paused'), 'initial debugger pause')
        const parsed = client.messages.find(message => message.method === 'Debugger.scriptParsed' && message.params.url === pathToFileURL(entry).href)
        assert.ok(parsed, 'Inspector must expose the TypeScript entry')
        const script = parsed.params
        const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId: script.scriptId })
        const index = scriptSource.indexOf('console.log')
        assert.ok(index >= 0)
        const lines = scriptSource.slice(0, index).split('\n')
        const lineNumber = lines.length - 1
        const columnNumber = lines.at(-1).length
        assert.match(script.sourceMapURL, /^data:application\/json.*;base64,/)
        const map = new SourceMap(JSON.parse(Buffer.from(script.sourceMapURL.split(',')[1], 'base64').toString()))
        const original = map.findEntry(lineNumber, columnNumber)
        assert.equal(original.originalLine, 3, 'Breakpoint must map to the original TS console.log line')
        assert.ok(original.originalSource.endsWith('/backend/debug.ts'))
        const { breakpointId } = await client.send('Debugger.setBreakpointByUrl', { url: script.url, lineNumber, columnNumber })
        const beforeResume = client.messages.length
        await client.send('Debugger.resume')
        let paused
        await waitFor(() => {
          paused = client.messages.slice(beforeResume).find(message => message.method === 'Debugger.paused' && message.params.hitBreakpoints.includes(breakpointId))
          return paused
        }, 'TypeScript breakpoint hit')
        const { result } = await client.send('Debugger.evaluateOnCallFrame', {
          callFrameId: paused.params.callFrames[0].callFrameId,
          expression: '({ marker, value, pid: process.pid })',
          returnByValue: true,
        })
        assert.equal(result.value.marker, marker)
        assert.equal(result.value.value, 'fixture-initial')
        await client.send('Debugger.removeBreakpoint', { breakpointId })
        await client.send('Debugger.resume')
        return result.value.pid
      }
      await waitFor(() => endpoints().length === 1, 'initial inspector endpoint')
      const firstUrl = endpoints()[0]
      const firstPid = await hitBreakpoint(firstUrl, 'debug-initial')
      await writeFile(entry, source('debug-updated'))
      await waitFor(() => endpoints().some(url => url !== firstUrl), 'inspector endpoint after restart')
      const secondUrl = endpoints().at(-1)
      assert.equal(new URL(secondUrl).port, new URL(firstUrl).port)
      assert.notEqual(await hitBreakpoint(secondUrl, 'debug-updated'), firstPid)
      await waitFor(() => clients[0].socket.readyState === WebSocket.CLOSED, 'old debugger disconnection')
    } finally {
      for (const client of clients) client.socket.close()
      watcher.child.kill('SIGINT')
      const timer = setTimeout(() => watcher.child.kill('SIGKILL'), 5000)
      try {
        await watcher.completion
      } finally {
        clearTimeout(timer)
      }
    }
  })

  await t.test('reports uncaught exceptions with the original TypeScript line', async () => {
    await writeFile(join(fixture, 'backend/crash.ts'), 'setTimeout(() => {\n  throw new Error("fixture-uncaught")\n}, 0)\n')
    const output = await run(fixture, 'tsx', ['backend/crash.ts'], 1)
    assert.match(output, /Error: fixture-uncaught/)
    assert.match(output, /crash\.ts:2:/)
  })

  await t.test('builds React, mixed ESM/CommonJS packages, shared imports, and SCSS for production', async () => {
    await run(fixture, 'vite', ['build'])
    const assets = join(fixture, 'dist/client/assets')
    const files = await readdir(assets)
    const css = files.find((file) => file.endsWith('.css'))
    const js = files.find((file) => file.endsWith('.js'))
    assert.ok(css)
    assert.ok(js)
    assert.match(await readFile(join(assets, css), 'utf8'), /#123456/)
    assert.match(await readFile(join(assets, js), 'utf8'), /fixture-initial/)
    assert.match(await readFile(join(assets, js), 'utf8'), /mixed-modules:/)
  })

  await t.test('serves frontend modules and notifies clients of shared changes', async () => {
    const server = await createServer({
      root: fixture,
      server: { host: '127.0.0.1', port: 0, watch: { usePolling: true, interval: 100 } },
    })
    let socket
    try {
      await server.listen()
      const { port } = server.httpServer.address()
      const origin = `http://127.0.0.1:${port}`
      for (const path of ['/', '/frontend/main.tsx', '/frontend/style.scss', '/shared/value.ts']) {
        const response = await fetch(`${origin}${path}`)
        assert.equal(response.status, 200, path)
        assert.ok(await response.text())
      }
      const messages = []
      socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`, 'vite-hmr')
      socket.addEventListener('message', ({ data }) => messages.push(JSON.parse(data)))
      await waitFor(() => messages.some(({ type }) => type === 'connected'), 'Vite websocket connection')
      await writeFile(sharedFile, 'export const value: string = "fixture-browser-update"\n')
      await waitFor(() => messages.some(({ type }) => type === 'update' || type === 'full-reload'), 'Vite reload notification')
      assert.match(await (await fetch(`${origin}/shared/value.ts`)).text(), /fixture-browser-update/)
    } finally {
      socket?.close()
      await server.close()
    }
  })

  await t.test('tsx restarts backend changes, ignores frontend output, and recovers after errors', async () => {
    const serverSource = `${nodeSource}\nsetInterval(() => {}, 1000)\n`
    await writeFile(nodeFile, serverSource)
    const process = launch(fixture, 'tsx', ['watch', '--clear-screen=false', '--include=backend/**', 'backend/main.ts'])
    try {
      await waitFor(() => process.output().includes('fixture-browser-update'), 'initial Node execution')
      // Allow filesystem watchers to finish initialization after the first output.
      await delay(300)
      await writeFile(sharedFile, 'export const value: string = "fixture-node-update"\n')
      await waitFor(() => process.output().includes('fixture-node-update'), 'Node restart')

      await delay(300)
      const beforeIgnoredChanges = process.output()
      await writeFile(join(fixture, 'frontend/ignored.ts'), 'export default "frontend-only"\n')
      await writeFile(join(fixture, 'dist/ignored.js'), 'console.log("build-output")\n')
      await delay(1200)
      assert.equal(process.output(), beforeIgnoredChanges, 'Ignored files must not restart the backend')

      const beforeNewFile = process.output().length
      await writeFile(join(fixture, 'backend/new-module.ts'), 'export default "new-module"\n')
      await waitFor(() => process.output().slice(beforeNewFile).includes('fixture-node-update'), 'restart for a newly added backend file')

      const beforePython = process.output().length
      await writeFile(join(fixture, 'backend/runtime.py'), 'print("python-runtime")\n')
      await waitFor(() => process.output().slice(beforePython).includes('fixture-node-update'), 'restart for a Python runtime change')

      const beforeCrash = process.output().length
      await writeFile(nodeFile, 'throw new Error("fixture-watch-crash")\n')
      await waitFor(() => process.output().slice(beforeCrash).includes('fixture-watch-crash'), 'watcher waiting after a crash')
      assert.match(process.output().slice(beforeCrash), /fixture-watch-crash/)
      const beforeRecovery = process.output().length
      await writeFile(nodeFile, serverSource)
      await waitFor(() => process.output().slice(beforeRecovery).includes('fixture-node-update'), 'restart after fixing the error')
    } finally {
      // Match Ctrl+C so tsx shuts down the complete application process tree.
      process.child.kill('SIGINT')
      const timer = setTimeout(() => process.child.kill('SIGKILL'), 5_000)
      try {
        await process.completion
      } finally {
        clearTimeout(timer)
      }
    }
  })
})
