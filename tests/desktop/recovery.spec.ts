import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, _electron as electron } from '@playwright/test'
import type { DesktopBridge } from '../../shared/desktop'

test('native wake and unlock reach all remote tabs without reloading pages or touching local shells', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-wake-'))
  const userData = join(directory, 'profile')
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(`<body><div id="events"></div><script>
      window.outpostDesktop.onCommand(command => {
        if (command === 'resume') document.querySelector('#events').append('resume;');
      });
      window.outpostDesktop.reportState({ title: 'Remote fixture', connection: 'connected', activity: null, attention: false, hasDraft: false });
    </script></body>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await mkdir(userData)
  await writeFile(join(userData, 'servers.json'), JSON.stringify([origin]))
  const launches = ['a', 'b'].map(
    key =>
      'outpost://connect/' +
      Buffer.from(
        JSON.stringify({
          v: 2,
          terminal: 'desktop',
          server: origin,
          sessionKey: key.repeat(43),
          token: `${key}.signature`,
          title: key,
        }),
      ).toString('base64url'),
  )
  const app = await electron.launch({
    executablePath: resolve('desktop/node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '--disable-webgl', `--user-data-dir=${userData}`, resolve('desktop'), ...launches],
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), HISTFILE: '/dev/null' },
  })
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    const remotePages = () => app.windows().filter(page => page.url().startsWith(origin))
    await expect.poll(() => remotePages().length).toBe(2)
    const pages = remotePages()
    for (const page of pages) await expect(page.locator('#events')).toBeAttached()
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()!.items.find((item: { label: string }) => item.label === 'File')!
      file.submenu!.items.find((item: { label: string }) => item.label === 'New local terminal tab')!.click()
    })
    await expect.poll(() => app.windows().some(page => page.url().includes('/local-terminal/'))).toBe(true)
    const local = app.windows().find(page => page.url().includes('/local-terminal/'))!
    await local.getByRole('button', { name: 'Show terminal toolbar' }).click()
    await expect(local.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
    await local.evaluate(() => {
      document.body.dataset.wakes = ''
      const bridge = (window as unknown as { outpostDesktop: DesktopBridge }).outpostDesktop
      bridge.onCommand(command => {
        if (command === 'resume') document.body.dataset.wakes += command
      })
    })
    for (const event of ['resume', 'unlock-screen'] as const) {
      await app.evaluate(({ powerMonitor }, event) => {
        powerMonitor.emit(event)
      }, event)
      for (const page of pages)
        await expect(page.locator('#events')).toHaveText(event === 'resume' ? 'resume;' : 'resume;resume;')
    }
    expect(await local.locator('body').getAttribute('data-wakes')).toBe('')
    await expect(local.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
  } finally {
    await app.close()
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
    await rm(directory, { recursive: true, force: true })
  }
})
