import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { AgentCall } from '../../shared/machine'
import { MachineConnection, MachineError } from '../../backend/machines'
import type { Command } from '../../backend/process'
import type { Transport } from '../../backend/transport'

const fakeNode = fileURLToPath(new URL('../fixtures/fake-node.ts', import.meta.url))
const node = [process.execPath, '--import', 'tsx', fakeNode]
const muxError = 'mux_client_request_session: read from master failed: Connection reset by peer'
const fail = (code: number, stderr: string) => [
  '-e',
  `process.stderr.write(${JSON.stringify(stderr)}); process.exit(${code})`,
]

/** A transport whose first invocation is `first` and whose retry, if any, is `retry`. */
function transport(first: string[], retry?: string[]): Transport {
  const command: Command = {
    executable: process.execPath,
    args: first,
    label: 'Fixture',
    ...(retry
      ? { retry: { args: retry, when: result => result.code === 255 && result.stderr.includes('mux_client') } }
      : {}),
  }
  return { label: 'Fixture', runtime: () => command, management: () => command } as unknown as Transport
}
const connection = (transport: Transport, agent = async (_call: AgentCall): Promise<unknown> => null) =>
  new MachineConnection('run/node-00000000000000000000000000000000.sock', transport, { agent })

test('the connection skips login noise, then carries calls and their errors', async t => {
  const machine = connection(transport(node.slice(1)))
  t.after(() => machine.close())
  assert.deepEqual(await machine.call('echo', { a: 1 }), { a: 1 })
  await assert.rejects(
    machine.call('missing'),
    (error: unknown) => error instanceof MachineError && error.statusCode === 404,
  )
})

test("the node's agent calls are answered by the server", async t => {
  const calls: AgentCall[] = []
  const machine = connection(transport(node.slice(1)), async call => (calls.push(call), { ok: true }))
  t.after(() => machine.close())
  void machine.call('ask', {}, { timeoutMs: 500 }).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.deepEqual(calls, [{ session: 's', tool: 'list_sessions', arguments: {} }])
})

test('a stale shared SSH connection is retried once without sharing', async t => {
  const machine = connection(transport(fail(255, `${muxError}\n`), node.slice(1)))
  t.after(() => machine.close())
  assert.deepEqual(await machine.call('echo', 'recovered'), 'recovered')
  const failing = connection(transport(fail(255, `${muxError}\n`), fail(255, 'Permission denied (publickey).\n')))
  t.after(() => failing.close())
  await assert.rejects(failing.call('echo'), /Permission denied/)
})

test('a machine without Outpost Terminal says so; a lost connection fails its calls and reconnects', async t => {
  const missing = connection(transport(fail(127, 'bash: outpost-terminal: No such file or directory\n')))
  t.after(() => missing.close())
  await assert.rejects(missing.call('echo'), /Outpost Terminal is missing/)
  const machine = connection(transport(node.slice(1)))
  t.after(() => machine.close())
  await machine.call('echo', 1)
  await assert.rejects(machine.call('exit'), /connection to the machine was lost/)
  assert.equal(await machine.call('echo', 2), 2, 'the next call reconnects')
})
