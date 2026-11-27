import assert from 'node:assert/strict'
import test from 'node:test'
import { isPlainLeftClick } from '../../frontend/router'
import { isGuidePath, isProtectedWorkspacePath } from '../../shared/pages'
import {
  clearWorkspaceCache,
  deleteCachedSessions,
  getCachedLogs,
  getCachedSessions,
  getCachedSoftware,
  getCachedTargets,
  setCachedLogs,
  setCachedSessions,
  setCachedSoftware,
  setCachedTargets,
} from '../../frontend/workspace/cache'

test('route matchers classify guide and protected workspace paths accurately', () => {
  assert.equal(isGuidePath('/guide'), true)
  assert.equal(isGuidePath('/guide/terminals'), true)
  assert.equal(isGuidePath('/guide/nested/page'), true)
  assert.equal(isGuidePath('/guidebook'), false)
  assert.equal(isGuidePath('/'), false)

  assert.equal(isProtectedWorkspacePath('/'), true)
  assert.equal(isProtectedWorkspacePath('/chat'), true)
  assert.equal(isProtectedWorkspacePath('/logs'), true)
  assert.equal(isProtectedWorkspacePath('/terminal'), true)
  assert.equal(isProtectedWorkspacePath('/guide/machine-cli'), true)
  assert.equal(isProtectedWorkspacePath('/desktop'), false)
  assert.equal(isProtectedWorkspacePath('/login'), false)
})

test('isPlainLeftClick allows unmodified primary clicks and ignores modified or secondary clicks', () => {
  assert.equal(isPlainLeftClick({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 }), true)
  assert.equal(isPlainLeftClick({ metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, button: 0 }), false)
  assert.equal(isPlainLeftClick({ metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, button: 0 }), false)
  assert.equal(isPlainLeftClick({ metaKey: false, ctrlKey: false, shiftKey: true, altKey: false, button: 0 }), false)
  assert.equal(isPlainLeftClick({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: true, button: 0 }), false)
  assert.equal(isPlainLeftClick({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 1 }), false)
})

test('workspace cache isolates accounts and clears cleanly on switch or sign-out', () => {
  clearWorkspaceCache()
  const targets = [{ id: 't1', name: 'local', kind: 'local' as const }] as never
  const sessions = [{ id: 's1', name: 'demo' }] as never
  const software = { checkedAt: 1, software: [] } as never
  const logs = { view: { path: '/logs-ui/', channel: 'c1' }, webhooks: [] }

  setCachedTargets('user-a', targets)
  setCachedSessions('user-a', 't1', sessions)
  setCachedSoftware('user-a', 't1', software)
  setCachedLogs('user-a', logs)

  assert.equal(getCachedTargets('user-a'), targets)
  assert.equal(getCachedSessions('user-a', 't1'), sessions)
  assert.equal(getCachedSoftware('user-a', 't1'), software)
  assert.deepEqual(getCachedLogs('user-a'), logs)

  deleteCachedSessions('user-a', 't1')
  assert.equal(getCachedSessions('user-a', 't1'), null)

  // Switching to another account resets all cached state so accounts never leak into each other.
  assert.equal(getCachedTargets('user-b'), null)
  assert.equal(getCachedLogs('user-b'), null)
  assert.equal(getCachedTargets('user-a'), null)

  clearWorkspaceCache()
})
