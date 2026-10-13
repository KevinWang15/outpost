import assert from 'node:assert/strict'
import test from 'node:test'
import { ConnectTokens } from '../../backend/terminal/tokens'

const owner = { userId: 'local', loginId: 'local' }
const grant = { owner, targetId: 'target', sessionId: 'session', terminal: 'iterm2' as const }

test('launch tokens are single use and bound to their grant', () => {
  const tokens = new ConnectTokens('a'.repeat(64))
  const { token, id } = tokens.issue(grant)
  const redeemed = tokens.redeem(token)
  assert.deepEqual(redeemed, { id, kind: 'launch', grant })
  assert.equal(tokens.redeem(token), null, 'second use is refused')
  const resume = tokens.resume(id, grant)
  assert.equal(tokens.redeem(resume)?.kind, 'resume')
  assert.equal(tokens.redeem(resume)?.kind, 'resume', 'resume tokens reconnect repeatedly')
})

test('tampered, foreign and expired tokens are refused', t => {
  const tokens = new ConnectTokens('a'.repeat(64))
  const { token } = tokens.issue(grant)
  const [payload, signature] = token.split('.')
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), s: 'other' })).toString('base64url')
  assert.equal(tokens.redeem(`${changed}.${signature}`), null)
  assert.equal(new ConnectTokens('b'.repeat(64)).redeem(token), null)
  assert.equal(tokens.redeem('garbage'), null)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 6 * 60_000 })
  assert.equal(tokens.redeem(token), null)
})

test('connection status is visible only to its owner', () => {
  const tokens = new ConnectTokens('a'.repeat(64))
  const { id } = tokens.issue(grant)
  assert.equal(tokens.status(owner, id), 'pending')
  tokens.markConnected(id, owner)
  assert.equal(tokens.status(owner, id), 'connected')
  assert.equal(tokens.status({ userId: 'someone', loginId: 'x' }, id), 'pending')
})
