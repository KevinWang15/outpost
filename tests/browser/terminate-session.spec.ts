import { codingIdentity } from './session-fixture'
import { healthySoftware } from './software-fixture'
import { expect, test, type Route } from '@playwright/test'
import type { Session } from '../../shared/session-manager'

for (const status of ['attached', 'detached'] as const) {
  test(`terminate a ${status} session after confirmation, then fetch its live status`, async ({ page }) => {
    let terminateCalls = 0, reads = 0
    const sessions: Session[] = [{ ...codingIdentity('codex', 'target'),
      env: {}, args: '',
      id: 'target', name: 'Feature work', rootDir: '/root/project', createdAt: '2026-09-29T00:00:00Z',
      backend: 'dtach', tool: 'codex', lastConnectedAt: '2026-09-29T00:00:00Z', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status, socketPath: '/root/.outpost/sockets/target.sock',
    }, { ...codingIdentity('codex', 'other'),
      env: {}, args: '',
      id: 'other', name: 'Other work', rootDir: '/root/other', createdAt: '2026-09-29T00:00:00Z',
      backend: 'dtach', tool: 'codex', lastConnectedAt: '2026-09-29T00:00:00Z', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'detached', socketPath: '/root/.outpost/sockets/other.sock',
    }]
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware(['dtach']) })
      if (path === '/api/targets') return route.fulfill({ json: [{
        id: 'target', name: 'Development', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev', backends: ['dtach'], createdAt: '2026-09-29T00:00:00Z',
        environment: { home: '/root', platform: 'linux', username: 'root', uid: 0, shell: '/bin/bash',  },
      }] })
      if (path === '/api/targets/target/sessions/target/terminate') {
        expect(route.request().method()).toBe('POST')
        ++terminateCalls
        sessions[0].status = 'stopped'
        return route.fulfill({ json: sessions[0] })
      }
      if (path === '/api/targets/target/sessions') {
        ++reads
        return route.fulfill({ json: { sessions, registryPath: '/root/.outpost/sessions.json' } })
      }
      return route.fulfill({ status: 404, json: { message: 'Unexpected request' } })
    })
    await page.goto('/')
    await page.getByRole('button', { name: 'Terminate Feature work', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Terminate Feature work (dtach)?', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toContainText('work in progress')
    await expect(page.getByRole('dialog')).toContainText('session record, project files, and coding CLI session ID are kept')
    await expect(page.getByRole('dialog')).toContainText('resumes the same conversation')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect(terminateCalls).toBe(0)
    await page.getByRole('button', { name: 'Terminate Feature work', exact: true }).click()
    const readsBefore = reads
    await page.getByRole('button', { name: 'Terminate session', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('Stopped', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete Feature work', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Terminate Feature work', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Terminate Other work', exact: true })).toBeVisible()
    await expect(page.getByText('Feature work', { exact: true })).toBeVisible()
    expect(reads).toBeGreaterThan(readsBefore)
    expect(terminateCalls).toBe(1)
    await page.getByRole('button', { name: 'Delete Feature work', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Remove Feature work (dtach)?', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })
}

test('Escape respects a pending termination instead of hiding its confirmation', async ({ page }) => {
  let pending: Route | undefined
  let stopped = false
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/targets') return route.fulfill({ json: [{
      id: 'target', name: 'Development', tools: ['codex'], kind: 'ssh', host: 'dev', backends: ['dtach'], createdAt: '2026-09-29T00:00:00Z',
    }] })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware(['dtach'], ['codex']) })
    if (path.endsWith('/terminate')) { pending = route; return }
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions: [{ ...codingIdentity('codex', 'session'),
      env: {}, args: '', id: 'session', name: 'Work', rootDir: '/root/project', backend: 'dtach', tool: 'codex',
      createdAt: '2026-09-29T00:00:00Z', lastConnectedAt: '2026-09-29T00:00:00Z',
      activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: stopped ? 'stopped' : 'detached', socketPath: '/root/.outpost/sockets/session.sock',
    }], registryPath: '/root/.outpost/sessions.json' } })
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Terminate Work', exact: true }).click()
  await page.getByRole('button', { name: 'Terminate session', exact: true }).click()
  await expect.poll(() => !!pending).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Terminating…', exact: true })).toBeDisabled()
  stopped = true
  await pending!.fulfill({ json: { activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'stopped' } })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Stopped', { exact: true })).toBeVisible()
})
