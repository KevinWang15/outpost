import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { LocalDeployment, type Owner } from '../../backend/deployment'
import { HostedDeployment } from '../../backend/hosted/deployment'
import { HistoryHub } from '../../backend/history/hub'
import { SessionClient, type TargetContext } from '../../backend/sessions'
import type { Command } from '../../backend/process'
import type { HistoryBatch, HistoryCatalog } from '../../shared/history'
import type { Embed } from '../../backend/history/embeddings'

const embed: Embed = async text => {
  const vector = new Float32Array(384)
  vector[/kitten|feline/i.test(text) ? 0 : /certificate|TLS|expired/i.test(text) ? 1 : 2] = 1
  return vector
}
async function waitFor(check: () => Promise<boolean>, label: string) {
  const until = Date.now() + 15000
  while (Date.now() < until) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('Timed out: ' + label)
}
async function put(path: string, records: object[]) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

test(
  'history MCP: a terminal session searches all tools across two machines with no browser, reads context, and preserves file publishing',
  { skip: process.platform !== 'linux', timeout: 30000 },
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'outpost-history-mcp-'))
    const deployment = await LocalDeployment.open(join(directory, 'server'))
    const owner: Owner = { userId: 'local', loginId: 'local' }
    const homes = new Map<string, string>()
    for (const id of ['alpha', 'beta']) {
      const home = join(directory, `machine '${id}'`)
      homes.set(id, home)
      await mkdir(join(home, 'bin'), { recursive: true })
      await writeFile(join(home, 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      await deployment.workspace().add({
        id,
        kind: 'local',
        name: id === 'alpha' ? 'Build machine' : 'Development laptop',
        tools: ['claude', 'codex', 'kimi'],
        createdAt: new Date().toISOString(),
      })
      const codex = randomUUID(),
        claude = randomUUID()
      await put(join(home, '.codex/sessions/2026/11', `rollout-${codex}.jsonl`), [
        { type: 'session_meta', payload: { id: codex, cwd: '/work/outpost' } },
        {
          type: 'response_item',
          timestamp: '2026-11-01T12:00:00Z',
          payload: { type: 'message', role: 'user', content: 'Production TLS certificate expired on ' + id },
        },
        {
          type: 'response_item',
          timestamp: '2026-11-01T12:01:00Z',
          payload: { type: 'message', role: 'assistant', content: 'Renew the certificate before deployment' },
        },
      ])
      await put(join(home, '.claude/projects/project', claude + '.jsonl'), [
        {
          type: 'user',
          cwd: '/work/outpost',
          timestamp: '2026-11-02T12:00:00Z',
          message: { content: 'A kitten needs a quiet place on ' + id },
        },
      ])
      await writeFile(
        join(home, '.codex/session_index.jsonl'),
        JSON.stringify({ id: codex, thread_name: 'TLS deployment' }) + '\n',
      )
      await put(join(home, '.kimi-code/sessions/project/session_example/agents/main/wire.jsonl'), [
        { type: 'context.append_message', message: { role: 'assistant', content: 'Kimi examined 缓存失效 on ' + id } },
      ])
    }
    const resolve = async (owner: Owner, id: string): Promise<TargetContext> => {
      const home = homes.get(id)!
      const command = (script: string): Command => ({
        executable: '/usr/bin/env',
        args: [
          `HOME=${home}`,
          `CODEX_HOME=${home}/.codex`,
          `CLAUDE_CONFIG_DIR=${home}/.claude`,
          `KIMI_CODE_HOME=${home}/.kimi-code`,
          `PATH=${home}/bin:${process.env.PATH}`,
          'bash',
          '-c',
          script,
        ],
        label: 'Fixture machine ' + id,
      })
      return {
        owner,
        target: await deployment.workspace().get(id),
        workspace: deployment.workspace(),
        transport: { label: 'Fixture', runtime: command, management: () => command('exec sh -s') },
      }
    }
    const hub = new HistoryHub({ deployment, resolve, embed })
    t.after(async () => {
      await hub.close()
      deployment.close()
      await rm(directory, { recursive: true, force: true })
    })
    await hub.start()
    const status = (await hub.call(owner, 'refresh_index', { embedLimit: 100 })) as {
      coverage: { searchableChunks: number }
      machines: { error: string | null }[]
    }
    assert.ok(status.coverage.searchableChunks >= 6, JSON.stringify(status))
    assert.ok(
      status.machines.every(m => m.error === null),
      JSON.stringify(status),
    )
    const context = await resolve(owner, 'alpha')
    context.historySocket = hub.socket(owner, 'alpha')
    const session = await new SessionClient().create(context, {
      name: 'MCP caller',
      tool: 'claude',
      rootDir: homes.get('alpha')!,
    })
    const home = homes.get('alpha')!,
      socket = join(home, '.outpost', context.historySocket)
    await waitFor(
      () =>
        access(socket).then(
          () => true,
          () => false,
        ),
      'persistent MCP connection',
    )
    const child = spawn('python3', ['-I', join(home, '.outpost/bin/outpost-mcp')], {
      env: {
        ...process.env,
        HOME: home,
        OUTPOST_SESSION_ID: session.id,
        OUTPOST_STATE_DIRECTORY: join(home, '.outpost'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    t.after(() => child.kill('SIGKILL'))
    const replies = new Map<number, (value: Record<string, unknown>) => void>()
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => {
      const response = JSON.parse(line)
      replies.get(response.id)?.(response.result)
    })
    let sequence = 0
    const request = (method: string, params: object = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = ++sequence,
          timer = setTimeout(() => reject(new Error('MCP call timed out: ' + method)), 10000)
        replies.set(id, value => {
          clearTimeout(timer)
          replies.delete(id)
          resolve(value)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    await request('initialize', { protocolVersion: '2025-06-18' })
    const listed = await request('tools/list')
    assert.ok((listed.tools as { name: string }[]).some(t => t.name === 'search_history'))
    async function call(name: string, args: object) {
      const response = await request('tools/call', { name, arguments: args })
      assert.equal(response.isError, undefined, JSON.stringify(response))
      return response.structuredContent as Record<string, unknown>
    }
    const result = (await call('search_history', { query: 'TLS certificate', mode: 'keyword' })) as unknown as {
      results: { machine: { id: string; name: string }; tool: string; sessionId: string; cursor: string }[]
    }
    assert.equal(result.results.length, 2)
    assert.deepEqual(new Set(result.results.map(r => r.machine.id)), new Set(['alpha', 'beta']))
    const page = (await call('read_context', { cursor: result.results[0].cursor })) as {
      machine: { id: string }
      messages: { text: string }[]
    }
    assert.equal(page.messages.length, 2)
    assert.match(page.messages[0].text, /certificate/)
    const details = await call('get_session', { sessionId: result.results[0].sessionId })
    assert.equal(details.tool, 'codex')
    assert.equal(
      ((await call('search_history', { query: '缓存失效', mode: 'keyword' })) as { results: unknown[] }).results.length,
      2,
    )
    await call('refresh_index', { embedLimit: 100 })
    const semantic = (await call('search_history', { query: 'feline', mode: 'semantic' })) as {
      results: { tool: string }[]
    }
    assert.equal(semantic.results[0].tool, 'claude')
    const file = join(home, 'report.txt')
    await writeFile(file, 'A generated deployment report')
    const published = await call('publish_file', { path: file })
    assert.equal(published.stored, true)
    assert.match(
      await readFile(
        join(home, '.outpost/files', session.id, String((published.file as { id: string }).id), 'content'),
        'utf8',
      ).catch(() => ''),
      /./,
    )
    await deployment.workspace().remove('beta')
    const reduced = (await call('search_history', { query: 'TLS certificate', mode: 'keyword' })) as {
      results: { machine: { id: string } }[]
    }
    assert.ok(reduced.results.every(r => r.machine.id === 'alpha'))
    const invalid = await request('tools/call', {
      name: 'search_history',
      arguments: { query: 'TLS', owner: 'somebody-else' },
    })
    assert.equal(invalid.isError, true)
  },
)

test('history: hosted owners have separate indexes and cursors; offline machines retain searchable cached history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-history-owners-'))
  const deployment = await HostedDeployment.open({ directory, publicUrl: 'http://127.0.0.1:5173', mailer: null })
  const owners: Owner[] = []
  for (const name of ['alice', 'bob']) {
    const user = deployment.store.create(`${name}@example.com`, name, 'fixture-hash')
    deployment.store.consumeToken(deployment.store.issueToken(user.id, 'verify', 60000), 'verify')
    const owner = { userId: user.id, loginId: 'background' }
    owners.push(owner)
    await deployment.workspace(owner).add({
      id: name,
      kind: 'ssh',
      name,
      host: `${name}.example`,
      tools: ['codex'],
      createdAt: new Date().toISOString(),
    })
  }
  let offline = false
  const reader = {
    async catalog(context: TargetContext): Promise<HistoryCatalog> {
      if (offline) throw new Error('Fixture target is offline')
      return {
        sources: [
          {
            id: 'source',
            tool: 'codex',
            nativeId: 'native',
            home: '/root/.codex',
            path: '/root/.codex/sessions/rollout.jsonl',
            title: context.target.name,
            cwd: '/work',
            size: 100,
            modified: '1',
          },
        ],
        next: null,
        warnings: [],
      }
    },
    async read(context: TargetContext): Promise<HistoryBatch> {
      const source = (await this.catalog(context)).sources[0]
      return {
        files: [
          {
            source,
            checkpoint: {
              offset: 100,
              size: 100,
              modified: '1',
              generation: 'first',
              prefix: '',
              prefixSize: 0,
              tail: '',
              tailSize: 0,
            },
            reset: true,
            pending: false,
            messages: [
              {
                position: 0,
                role: 'user',
                kind: 'message',
                text: `private deployment plan for ${context.target.name}`,
                timestamp: null,
                turnId: null,
                truncated: false,
              },
            ],
          },
        ],
        warnings: [],
      }
    },
    bridge(): never {
      throw new Error('Background connections are disabled in this test')
    },
  }
  const hub = new HistoryHub({
    deployment,
    resolve: async (owner, id) => ({
      owner,
      target: await deployment.workspace(owner).get(id),
      workspace: deployment.workspace(owner),
      transport: null!,
    }),
    reader,
    embed,
    background: false,
  })
  t.after(async () => {
    await hub.close()
    deployment.close()
    await rm(directory, { recursive: true, force: true })
  })
  for (const owner of owners) await hub.call(owner, 'refresh_index', {})
  const a = (await hub.call(owners[0], 'search_history', { query: 'private', mode: 'keyword' })) as {
    results: { cursor: string; text: string }[]
  }
  const b = (await hub.call(owners[1], 'search_history', { query: 'private', mode: 'keyword' })) as {
    results: { text: string }[]
  }
  assert.equal(a.results.length, 1)
  assert.match(a.results[0].text, /alice/)
  assert.match(b.results[0].text, /bob/)
  await assert.rejects(hub.call(owners[1], 'read_message', { cursor: a.results[0].cursor }), /Invalid history cursor/)
  offline = true
  await hub.call(owners[0], 'refresh_index', {})
  const cached = (await hub.call(owners[0], 'search_history', { query: 'private', mode: 'keyword' })) as {
    results: unknown[]
    machines: { error: string }[]
  }
  assert.equal(cached.results.length, 1)
  assert.match(cached.machines[0].error, /offline/)
  await assert.rejects(hub.call(owners[0], 'search_history', { query: 'private', machine: 'bob' }), /not configured/)
})
