import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect, viewport, fitsScreen } from './helpers'
import type { Session, Target } from '../../../shared/model'

test('long target and session lists stay within the viewport and Connect remains tappable', async ({ page }, info) => {
  const headers = { 'x-outpost-request': '1' }
  let target!: Target
  for (let index = 0; index < 10; index++) {
    const response = await page.request.post('/api/targets', {
      headers,
      data: { kind: 'local', name: `Layout ${info.project.name} target ${index}`, tools: ['claude'] },
    })
    expect(response.status()).toBe(201)
    target = await response.json()
  }
  for (let index = 0; index < 6; index++) {
    const response = await page.request.post(`/api/targets/${target.id}/sessions`, {
      headers,
      data: {
        name: `Layout ${info.project.name} session ${index}`,
        rootDir: `~/layout-${info.project.name}-${index}`,
        tool: 'claude',
        createDirectory: true,
      },
    })
    expect(response.status()).toBe(201)
  }
  await page.goto('/')
  const navigation = page.getByRole('navigation', { name: 'Targets' })
  const selected = navigation.getByRole('button', { name: new RegExp(target.name) })
  await selected.tap()
  await expect(page.getByRole('heading', { name: target.name, exact: true })).toBeVisible()
  const session = `Layout ${info.project.name} session 5`
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 780 })
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth))
      .toBeLessThanOrEqual(1)
    await expect
      .poll(() => navigation.evaluate(element => element.scrollWidth - element.clientWidth))
      .toBeGreaterThan(0)
    await page.getByRole('row').filter({ hasText: session }).getByRole('button', { name: 'Connect', exact: true }).tap()
    const dialog = page.getByRole('dialog', { name: `Connect to ${session}`, exact: true })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).tap()
    expect(await page.evaluate(() => scrollX)).toBe(0)
  }
})

test('create and connect on a phone, send to the real process, resize, and resume without restarting', async ({
  page,
}, info) => {
  const suffix = info.project.name
  await page.goto('/')
  await page.getByRole('button', { name: 'Add target', exact: true }).first().tap()
  const add = page.getByRole('dialog', { name: 'Add a target' })
  await add.getByRole('radio', { name: 'This computer' }).tap()
  await add.getByLabel('Name', { exact: true }).fill(`Mobile ${suffix}`)
  await add.getByText('Codex', { exact: true }).tap()
  await add.getByRole('button', { name: 'Add target', exact: true }).tap()
  await expect(page.getByRole('heading', { name: `Mobile ${suffix}`, level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'New session', exact: true }).first().tap()
  const create = page.getByRole('dialog', { name: 'New session', exact: true })
  await create.getByLabel('Name', { exact: true }).fill(`Mobile coding ${suffix}`)
  await create.getByRole('combobox').fill(`~/mobile-${suffix}`)
  await create.getByText('Create the directory if it doesn’t exist').tap()
  const created = page.waitForResponse(
    response => response.url().endsWith('/sessions') && response.request().method() === 'POST',
  )
  await create.getByRole('button', { name: 'Create session', exact: true }).tap()
  const session: Session = await (await created).json()
  await writeFile(join(session.rootDir, 'capture-input'), '')
  const row = page.getByRole('row').filter({ hasText: `Mobile coding ${suffix}` })
  await expect(row).toBeVisible()
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(1)
  await page.screenshot({ path: info.outputPath('session-list.png'), fullPage: true })
  await row.getByRole('button', { name: 'Connect', exact: true }).tap()
  const connect = page.getByRole('dialog', { name: `Connect to Mobile coding ${suffix}` })
  await connect.getByLabel('Remember my choice').check()
  const popup = page.waitForEvent('popup')
  await connect.getByRole('button', { name: /Web terminal/ }).tap()
  const terminal = await popup
  await expect(terminal.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  expect(await terminal.evaluate(() => window.opener)).toBeNull()
  expect(new URL(terminal.url()).searchParams.has('token')).toBe(false)
  const field = terminal.getByLabel('Message to the session')
  const message = 'Mobile real input 你好 📱\nSecond line'
  await field.fill(message)
  await terminal.getByRole('button', { name: 'Send', exact: true }).tap()
  await expect(field).toHaveValue('')
  const input = () => readFile(join(session.rootDir, 'input.bin'), 'utf8').catch(() => '')
  await expect.poll(input).toContain(message.replace('\n', '\r'))
  expect((await input()).split(message.replace('\n', '\r'))).toHaveLength(2)
  const imageGeometry = await terminal.locator('.xterm-screen').boundingBox()
  const imageResponse = terminal.waitForResponse(response => response.url().endsWith('/api/terminal/image'))
  await terminal.locator('input[type=file]').setInputFiles({
    name: 'mobile-image.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 9)]),
  })
  await expect(terminal.getByRole('status').filter({ hasText: 'Image pasted' })).toBeVisible()
  const uploaded = await imageResponse
  expect(uploaded.status()).toBe(200)
  const image = await uploaded.json()
  expect(await readFile(image.path)).toEqual(
    Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 9)]),
  )
  expect(await terminal.locator('.xterm-screen').boundingBox()).toEqual(imageGeometry)
  await expect.poll(input).toContain(`\x1b[200~${image.reference}\x1b[201~`)
  expect((await input()).endsWith('\x1b[201~')).toBe(true)
  await expect.poll(input).toContain(`/.outpost/clipboard/${session.id}/`)
  const starts = await readFile(join(session.rootDir, 'starts.log'), 'utf8')
  const sizes = await readFile(join(session.rootDir, 'sizes.log'), 'utf8')
  await viewport(terminal, { height: 350, offsetTop: 15 })
  await expect.poll(() => readFile(join(session.rootDir, 'sizes.log'), 'utf8')).not.toBe(sizes)
  await fitsScreen(terminal)
  await field.fill('Unsent draft')
  await terminal.evaluate(() => {
    window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new Event('pageshow'))
  })
  await expect(terminal.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
  await expect(field).toHaveValue('Unsent draft')
  await terminal.reload()
  await expect(terminal.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  expect(await readFile(join(session.rootDir, 'starts.log'), 'utf8')).toBe(starts)
  await terminal.close()
  const second = page.waitForEvent('popup')
  await row.getByRole('button', { name: 'Connect', exact: true }).tap()
  const remembered = await second
  await expect(remembered.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  await expect(page.getByRole('dialog', { name: /Connect to/ })).toBeHidden()
  await remembered.close()
  await page.getByRole('button', { name: 'Connection preferences', exact: true }).tap()
  const preferences = page.getByRole('dialog', { name: 'Connection preferences', exact: true })
  await preferences.getByRole('combobox').selectOption('')
  await preferences.getByRole('button', { name: 'Save', exact: true }).tap()
  await row.getByRole('button', { name: 'Connect', exact: true }).tap()
  await expect(page.getByRole('dialog', { name: /Connect to/ })).toBeVisible()
})

test('Home Screen mode connects in its own window and closing returns to the workspace', async ({
  page,
  context,
}, info) => {
  const name = `Standalone session ${info.project.name}`
  await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }))
  const headers = { 'x-outpost-request': '1' }
  const targetResponse = await page.request.post('/api/targets', {
    headers,
    data: { kind: 'local', name: `Standalone ${info.project.name}`, tools: ['claude'] },
  })
  expect(targetResponse.status()).toBe(201)
  const target: Target = await targetResponse.json()
  const sessionResponse = await page.request.post(`/api/targets/${target.id}/sessions`, {
    headers,
    data: { name, rootDir: `~/standalone-${info.project.name}`, tool: 'claude', createDirectory: true },
  })
  expect(sessionResponse.status()).toBe(201)
  await page.goto('/')
  await page.getByRole('button', { name: new RegExp(`Standalone ${info.project.name}`) }).tap()
  const row = page.getByRole('row').filter({ hasText: name })
  await row.getByRole('button', { name: 'Connect', exact: true }).tap()
  await page.getByRole('button', { name: /Web terminal/ }).tap()
  await expect(page).toHaveURL(/\/terminal\?target=/)
  await expect(page.locator('.xterm-rows')).toContainText('OUTPOST_FIXTURE_READY')
  expect(context.pages()).toHaveLength(1)
  await page.getByRole('button', { name: 'Close terminal', exact: true }).tap()
  await expect(page).toHaveURL(url => url.origin === 'http://127.0.0.1:4178' && url.pathname === '/')
  await expect(page.getByRole('navigation', { name: 'Targets' })).toBeVisible()
  await page.getByRole('button', { name: new RegExp(`Standalone ${info.project.name}`) }).tap()
  await expect(page.getByRole('row').filter({ hasText: name })).toContainText('Running')
  const manifest = await page.request.get('/outpost.webmanifest')
  expect(manifest.ok()).toBe(true)
  const data = await manifest.json()
  expect(data).toMatchObject({ start_url: '/', scope: '/', display: 'standalone' })
  for (const icon of data.icons) expect((await page.request.get(icon.src)).ok()).toBe(true)
})
