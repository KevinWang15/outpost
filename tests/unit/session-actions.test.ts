import assert from 'node:assert/strict'
import test from 'node:test'
import { switchSession, terminateSession } from '../../backend/session-actions'
import type { Services } from '../../backend/services'
import type { TargetContext } from '../../backend/sessions'
import type { Session } from '../../shared/model'

function fixtureContext(): TargetContext {
  return {
    owner: { userId: 'local', loginId: 'local' },
    target: { id: 'target-1', kind: 'local', name: 'Local', createdAt: '2026-01-01T00:00:00.000Z' },
  } as TargetContext
}

function fixtureSession(id: string): Session {
  return {
    id,
    name: 'Dev',
    tool: 'claude',
    rootDir: '/work',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastConnectedAt: null,
    storage: { CLAUDE_CONFIG_DIR: '/home/dev/.claude' },
    delivery: 'auto',
    config: { revision: 1, instructions: null, model: null, mode: null, mcpServers: {}, args: '', env: {} },
    conversation: 'conv-1',
    conversations: [{ id: 'conv-1', tool: 'claude', startedAt: '2026-01-01T00:00:00.000Z', movedTo: null }],
    status: 'stopped',
    driver: null,
    runningRevision: null,
    activity: {
      state: 'idle',
      blockedKind: null,
      progress: null,
      completionId: null,
      observation: 'current',
      detail: null,
      observedAt: null,
      updatedAt: null,
    },
  }
}

test('switchSession forwards reclaim=true to SessionClient and records it in the activity log', async () => {
  const session = fixtureSession('11111111-1111-4111-8111-111111111111')
  const switchCalls: Array<{ id: string; conversation: string; reclaim: boolean }> = []
  const logs: Array<Record<string, unknown>> = []
  const services = {
    sessions: {
      async switch(_context: TargetContext, id: string, conversation: string, reclaim: boolean) {
        switchCalls.push({ id, conversation, reclaim })
        return session
      },
    },
    log: {
      record(_owner: unknown, entry: Record<string, unknown>) {
        logs.push(entry)
      },
    },
  } as unknown as Services

  await switchSession(services, fixtureContext(), session.id, 'conv-2', true)
  assert.deepEqual(switchCalls, [{ id: session.id, conversation: 'conv-2', reclaim: true }])
  assert.equal(logs.length, 1)
  assert.deepEqual(logs[0].details, { conversation: 'conv-2', reclaim: true })
})

test('terminateSession terminates the session and closes active broker terminal attachments', async () => {
  const session = fixtureSession('22222222-2222-4222-8222-222222222222')
  const order: string[] = []
  const services = {
    sessions: {
      async terminate(_context: TargetContext, id: string) {
        order.push(`terminate:${id}`)
        return session
      },
    },
    broker: {
      closeTarget(_owner: unknown, targetId: string, sessionId?: string) {
        order.push(`closeTarget:${targetId}:${sessionId}`)
      },
    },
  } as unknown as Services

  const result = await terminateSession(services, fixtureContext(), session.id)
  assert.equal(result.id, session.id)
  assert.deepEqual(order, [`terminate:${session.id}`, `closeTarget:target-1:${session.id}`])
})
