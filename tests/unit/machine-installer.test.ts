import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { machineInstaller } from '../../backend/machineInstaller'
import { serverOrigin } from '../../shared/serverOrigin'

test('outbound installer accepts HTTP loopback at default or custom ports and requires HTTPS elsewhere', () => {
  const preflight = (origin: string) =>
    spawnSync('/bin/sh', ['-s', '--', origin, 'test-machine'], {
      input: machineInstaller(),
      // Stop at boot-manager discovery, before installing anything.
      env: { OUTPOST_ENROLLMENT: 'test-code', PATH: '/no-boot-manager' },
      encoding: 'utf8',
    }).stderr
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    for (const port of ['', ':80', ':45123']) {
      assert.match(preflight(serverOrigin('http://' + host + port)), /requires systemd or OpenRC/)
    }
  }
  assert.match(preflight(serverOrigin('https://workspace.example')), /requires systemd or OpenRC/)
  for (const origin of [
    'http://workspace.example',
    'http://localhost:',
    'http://localhost:foo',
    'http://localhost:65536',
    'http://localhost:80@workspace.example',
    'http://[::1]:8080/path',
    'http://127.0.0.1:80?query',
    'http://localhost:80:80',
    'https://name@workspace.example',
  ])
    assert.match(preflight(origin), /Use an HTTPS server/, origin)
})
