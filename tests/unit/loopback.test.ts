import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isLoopbackAddress,
  isLoopbackName,
  loopbackHost,
  parseHostHeader,
  parseOriginHeader,
} from '../../backend/loopback'

test('loopback host and address validation accepts loopback literals and rejects lookalikes', () => {
  assert.equal(loopbackHost(undefined), '127.0.0.1')
  assert.equal(loopbackHost('localhost'), '127.0.0.1')
  assert.equal(loopbackHost('::1'), '::1')
  assert.throws(() => loopbackHost('0.0.0.0'), /loopback/)
  assert.throws(() => loopbackHost('localhost.evil.com'), /loopback/)

  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.0.0.2'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('127.0.0.999'), false)
  assert.equal(isLoopbackAddress('10.0.0.1'), false)

  assert.equal(isLoopbackName('localhost'), true)
  assert.equal(isLoopbackName('127.0.0.2'), true)
  assert.equal(isLoopbackName('[::1]'), true)
  assert.equal(isLoopbackName('127.0.0.1.evil.com'), false)
  assert.equal(isLoopbackName('localhost.evil.com'), false)
})

test('Host and Origin header parsers reject embedded paths, queries, fragments, credentials and lookalikes', () => {
  const validHost = parseHostHeader('localhost:6620')
  assert.ok(validHost && isLoopbackName(validHost.hostname))
  const validIpv4 = parseHostHeader('127.0.0.2:6620')
  assert.ok(validIpv4 && isLoopbackName(validIpv4.hostname))
  const validIpv6 = parseHostHeader('[::1]:6620')
  assert.ok(validIpv6 && isLoopbackName(validIpv6.hostname))

  assert.equal(parseHostHeader('localhost/evil'), null)
  assert.equal(parseHostHeader('localhost:6620/evil'), null)
  assert.equal(parseHostHeader('localhost?x=1'), null)
  assert.equal(parseHostHeader('localhost#frag'), null)
  assert.equal(parseHostHeader('user@localhost:6620'), null)
  const lookalike = parseHostHeader('127.0.0.1.evil.com')
  assert.equal(lookalike ? isLoopbackName(lookalike.hostname) : false, false)

  assert.equal(parseOriginHeader('http://localhost:6620')?.origin, 'http://localhost:6620')
  assert.equal(parseOriginHeader('https://127.0.0.1:6620')?.origin, 'https://127.0.0.1:6620')
  assert.equal(parseOriginHeader('http://localhost:6620/evil'), null)
  assert.equal(parseOriginHeader('http://localhost:6620?a=1'), null)
  assert.equal(parseOriginHeader('http://localhost:6620#x'), null)
  assert.equal(parseOriginHeader('http://user:pass@localhost:6620'), null)
})
