import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { terminalConnectionPolicy } from '../../shared/protocol'
import { desktopTerminal, appConnection } from './terminal-fixture'

for (const mode of ['web', 'desktop'] as const) {
  test(`${mode}: a blackholed connection recovers the same process, offline output, size and draft`, async ({
    page,
  }) => {
    await page.clock.install()
    const headers = { 'x-outpost-request': '1' }
    const name = `Recovery ${randomUUID()}`
    const target = await (
      await page.request.post('/api/targets', {
        headers,
        data: { kind: 'local', name, tools: ['claude'] },
      })
    ).json()
    const session = await (
      await page.request.post(`/api/targets/${target.id}/sessions`, {
        headers,
        data: { name, rootDir: `~/recovery-${randomUUID()}`, tool: 'claude', createDirectory: true },
      })
    ).json()
    await writeFile(join(session.rootDir, 'capture-input'), '')
    const sockets: string[] = []
    let blocked = -1
    await page.routeWebSocket(/\/api\/terminal\?/, ws => {
      const index = sockets.push(ws.url()) - 1
      const server = ws.connectToServer()
      ws.onMessage(message => {
        if (index !== blocked) server.send(message)
      })
      server.onMessage(message => {
        if (index !== blocked) ws.send(message)
      })
    })
    if (mode === 'desktop') {
      const connection = await appConnection(page.request, target.id, session.id)
      await desktopTerminal(page, connection.token)
      await page.goto('/terminal/desktop')
      await page.getByRole('button', { name: 'Show terminal toolbar' }).click()
    } else await page.goto(`/terminal?target=${target.id}&session=${session.id}`)
    const rows = page.locator('.xterm-rows')
    await expect(rows).toContainText('OUTPOST_FIXTURE_READY')
    const starts = await readFile(join(session.rootDir, 'starts.log'), 'utf8')
    const pid = Number(starts.trim())
    expect(Number.isSafeInteger(pid)).toBe(true)
    await page.getByRole('button', { name: 'Message box', exact: true }).click()
    const field = page.getByRole('textbox', { name: 'Message to the session' })
    await field.fill('Preserve me; never submit automatically')
    const beforeInput = await readFile(join(session.rootDir, 'input.bin')).catch(() => Buffer.alloc(0))
    blocked = 0
    await writeFile(`/proc/${pid}/fd/1`, '\r\nOUTPUT_WHILE_OFFLINE\r\n')
    await page.setViewportSize({ width: 1000, height: 700 })
    // The socket stays OPEN and no close event arrives. Model a wake event,
    // through the same bridge used by Electron for the desktop variant.
    await page.evaluate(mode => {
      window.dispatchEvent(
        mode === 'desktop' ? new CustomEvent('outpost-test-command', { detail: 'resume' }) : new Event('pageshow'),
      )
    }, mode)
    await page.clock.fastForward(terminalConnectionPolicy.wakeProbeMs + 1)
    await expect(page.getByRole('status', { name: /Reconnecting/ })).toBeVisible()
    await page.clock.fastForward(1000)
    await expect(page.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
    expect(sockets).toHaveLength(2)
    expect(new URL(sockets[0]).searchParams.get('start')).toBe('1')
    expect(new URL(sockets[1]).searchParams.get('start')).toBe('0')
    expect(new URL(sockets[1]).searchParams.get('token')).not.toBe(new URL(sockets[0]).searchParams.get('token'))
    await expect(rows).toContainText('OUTPUT_WHILE_OFFLINE')
    await expect(rows).toContainText(`OUTPOST_FIXTURE_READY ${pid}`)
    await expect(field).toHaveValue('Preserve me; never submit automatically')
    expect(await readFile(join(session.rootDir, 'starts.log'), 'utf8')).toBe(starts)
    expect(await readFile(join(session.rootDir, 'input.bin')).catch(() => Buffer.alloc(0))).toEqual(beforeInput)
    const current = new URL(sockets[1]).searchParams
    await expect
      .poll(async () => (await readFile(join(session.rootDir, 'sizes.log'), 'utf8')).trim().split('\n').at(-1))
      .toBe(`${current.get('cols')}x${current.get('rows')}`)
  })
}
