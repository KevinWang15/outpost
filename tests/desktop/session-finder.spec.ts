import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
  type JSHandle,
} from '@playwright/test'
import type { WorkspaceSnapshot } from '../../desktop/src/workspace-api'
import type { RecentSession } from '../../desktop/src/recent-sessions'
import type { View } from 'electron'

let app: ElectronApplication, chrome: Page, server: Server, directory: string, origin: string, recents: RecentSession[]
let menus: JSHandle<{ labels(): string[]; choose(label: string): void; errors: string[] }>
const state = (page = chrome): Promise<WorkspaceSnapshot> => page.evaluate(() => window.outpostWorkspace.state())
const workspaces = () => app.windows().filter(page => page.url().endsWith('/workspace.html'))
const remotePages = () => app.windows().filter(page => page.url().startsWith(origin))
async function finder() {
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/session-finder.html'))).toBe(true)
  const page = app.windows().find(page => page.url().endsWith('/session-finder.html'))!
  await expect(page.getByRole('combobox')).toBeFocused()
  return page
}
async function dismissWithKey(page: Page, key: 'Enter' | 'Escape') {
  // A native popover can close on keydown before Playwright sends keyup.
  await page
    .getByRole('combobox')
    .press(key)
    .catch(error => {
      if (!page.isClosed()) throw error
    })
  await expect.poll(() => page.isClosed()).toBe(true)
}
async function chooseMenu(label: string) {
  expect(await menus.evaluate(menu => menu.labels())).toContain(label)
  await menus.evaluate((menu, label) => menu.choose(label), label)
}
async function newTabFinder(page = chrome) {
  await page.locator('#new-tab').click({ button: 'right' })
  await chooseMenu('Outpost terminal…')
  return finder()
}
async function splitFinder(tabId: number, page = chrome) {
  await page.locator(`[data-tab="${tabId}"] .tab-select`).click({ button: 'right' })
  await chooseMenu('Split with Outpost terminal…')
  return finder()
}
async function bounds() {
  const window = await app.browserWindow(chrome)
  return window.evaluate(window =>
    window.contentView.children.map((view: View) => ({ bounds: view.getBounds(), visible: view.getVisible() })),
  )
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'outpost-finder-'))
  const userData = join(directory, 'profile')
  const credential = {
    token: 'op_app_' + 'x'.repeat(43),
    account: { id: 'fixture', name: 'Fixture', email: null },
    expiresAt: Date.now() + 86_400_000,
  }
  server = createServer((request, response) => {
    if (request.url?.startsWith('/api/desktop/')) {
      response.setHeader('Content-Type', 'application/json')
      if (request.headers.authorization !== `Bearer ${credential.token}`) {
        response.writeHead(401).end(JSON.stringify({ message: 'Unauthorized' }))
        return
      }
      const path = request.url.slice('/api/desktop'.length)
      if (path === '/account') response.end(JSON.stringify(credential))
      else if (path === '/targets') response.end(JSON.stringify([{ id: 'target', name: 'Target' }]))
      else if (path === '/targets/target/sessions')
        response.end(
          JSON.stringify(
            recents.map((entry, index) => ({
              sessionId: index ? 'b' : 'a',
              targetId: 'target',
              title: entry.title,
              detail: 'Fixture',
            })),
          ),
        )
      else {
        const key = path.includes('/sessions/a/') ? 'a' : 'b'
        response.end(
          JSON.stringify({
            server: origin,
            accountId: 'fixture',
            targetId: 'target',
            sessionId: key,
            loginId: 'desktop:' + '0'.repeat(36),
            token: `${key}.signature`,
            title: key === 'a' ? 'Alpha project' : 'Beta review',
          }),
        )
      }
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<body><textarea id="draft" aria-label="Draft"></textarea><script>
      window.outpostDesktop.ticket().then(token => {
        const title = token.startsWith('a.') ? 'Alpha project' : 'Beta review';
        window.outpostDesktop.reportState({ title, connection: 'connected', activity: null, attention: false, hasDraft: false });
      });
    </script></body>`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  recents = ['a', 'b'].map((key, index) => ({
    id: JSON.stringify([origin, 'fixture', 'target', key]),
    server: origin,
    accountId: 'fixture',
    targetId: 'target',
    sessionId: key,
    title: index ? 'Beta review' : 'Alpha project',
    lastConnectedAt: Date.now() - index,
  }))
  await mkdir(userData)
  await writeFile(join(userData, 'server-trust.json'), JSON.stringify([origin]))
  await writeFile(join(userData, 'recent-sessions.json'), JSON.stringify(recents))
  await writeFile(join(userData, 'server-logins.json'), JSON.stringify([{ ...credential, origin }]))
  app = await electron.launch({
    executablePath: resolve('desktop/node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '--disable-webgl', `--user-data-dir=${userData}`, resolve('desktop')],
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), HISTFILE: '/dev/null' },
  })
  menus = await app.evaluateHandle(({ Menu, dialog }) => {
    let items: typeof Menu.prototype.items = []
    const errors: string[] = []
    Menu.prototype.popup = function () {
      items = this.items
    }
    dialog.showMessageBox = async (...args: unknown[]) => {
      const options = args.at(-1) as { type: string; detail?: string }
      if (options.type === 'error') errors.push(options.detail ?? '')
      return { response: 0, checkboxChecked: false }
    }
    return {
      labels: () => items.map(item => item.label),
      choose: (label: string) => items.find(item => item.label === label)!.click(),
      errors,
    }
  })
  await expect.poll(() => workspaces().length).toBe(1)
  chrome = workspaces()[0]
  await expect.poll(async () => (await state()).panes[0]?.connection).toBe('connected')
})
test.afterEach(async () => {
  if (app) await app.close().catch(() => {})
  if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('plus menu opens a remote tab through the finder, without resizing terminals or changing local plus', async () => {
  const before = await bounds()
  const page = await newTabFinder()
  expect(await bounds()).toEqual(before)
  const metadata = await page.evaluate(() => window.outpostSessionFinder.state())
  expect(JSON.stringify(metadata)).not.toContain('.signature')
  expect(metadata.sessions.every(session => !('token' in session))).toBe(true)
  await page.getByRole('combobox').fill('beta')
  await dismissWithKey(page, 'Enter')
  await expect
    .poll(async () =>
      (await state()).panes.some(pane => pane.title === 'Beta review' && pane.connection === 'connected'),
    )
    .toBe(true)
  expect((await state()).tabs).toHaveLength(2)
  await chrome.locator('#new-tab').click()
  await expect.poll(async () => (await state()).panes.filter(pane => pane.kind === 'local').length).toBe(2)
  expect((await state()).tabs).toHaveLength(3)
})

test('tab menu splits its captured pane even when another tab is active', async () => {
  const before = await state(),
    anchor = before.activePaneId!,
    tabId = before.activeTabId!
  await chrome.locator('#new-tab').click()
  const other = (await state()).activeTabId!
  const page = await splitFinder(tabId)
  expect((await state()).activeTabId).toBe(other)
  await page.getByRole('option').filter({ hasText: 'Alpha project' }).click()
  await expect.poll(async () => (await state()).panes.some(pane => pane.title === 'Alpha project')).toBe(true)
  const after = await state(),
    tab = after.tabs.find(tab => tab.id === tabId)!
  expect(after.activeTabId).toBe(tabId)
  expect(tab.panes).toHaveLength(2)
  expect(tab.panes).toContain(anchor)
  expect(after.tabs.find(tab => tab.id === other)!.panes).toHaveLength(1)
})

test('finder reuses a live remote pane across windows, splits and tabs while home retains its activation behavior', async () => {
  await chrome.evaluate(id => window.outpostWorkspace.openRecent(id), recents[0].id)
  await expect.poll(() => remotePages().length).toBe(1)
  const remote = (await state()).panes.find(pane => pane.kind === 'remote')!,
    original = remotePages()[0]
  await original.getByRole('textbox', { name: 'Draft' }).fill('keep this draft')
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()!
      .items.find(item => item.label === 'File')!
      .submenu!.items.find(item => item.label === 'New window')!
      .click()
  })
  await expect.poll(() => workspaces().length).toBe(2)
  const destination = workspaces().find(page => page !== chrome)!
  await expect.poll(async () => (await state(destination)).panes[0]?.connection).toBe('connected')
  const split = await splitFinder((await state(destination)).activeTabId!, destination)
  await split.getByRole('option').filter({ hasText: 'Alpha project' }).click()
  await expect.poll(async () => (await state(destination)).panes.map(pane => pane.id)).toContain(remote.id)
  expect((await state(destination)).tabs).toHaveLength(1)
  expect((await state()).panes).toHaveLength(1)
  expect(remotePages()).toHaveLength(1)
  await expect(original.getByRole('textbox', { name: 'Draft' })).toHaveValue('keep this draft')
  const tab = await newTabFinder(destination)
  await tab.getByRole('option').filter({ hasText: 'Alpha project' }).click()
  await expect.poll(async () => (await state(destination)).tabs.length).toBe(2)
  expect((await state(destination)).panes.map(pane => pane.id)).toContain(remote.id)
  expect(remotePages()).toHaveLength(1)
  await chrome.evaluate(id => window.outpostWorkspace.openRecent(id), recents[0].id)
  expect((await state()).panes).toHaveLength(1)
  expect((await state(destination)).panes.map(pane => pane.id)).toContain(remote.id)
  await expect(original.getByRole('textbox', { name: 'Draft' })).toHaveValue('keep this draft')
})

test('Escape and outside focus cancel without changing selection or pane geometry', async () => {
  const before = await state(),
    rectangles = await bounds()
  const page = await splitFinder(before.activeTabId!)
  await page.getByRole('combobox').fill('alpha')
  await dismissWithKey(page, 'Escape')
  expect((await state()).tree).toEqual(before.tree)
  expect((await state()).activePaneId).toBe(before.activePaneId)
  expect(await bounds()).toEqual(rectangles)
  const another = await newTabFinder()
  const parent = await app.browserWindow(chrome)
  await parent.evaluate(window => window.focus())
  await expect.poll(() => another.isClosed()).toBe(true)
  expect((await state()).panes).toHaveLength(1)
})

test('a destination closed during the finder cannot redirect the split or create a stray remote pane', async () => {
  const destination = (await state()).activeTabId!
  await chrome.locator('#new-tab').click()
  const survivor = (await state()).activePaneId!
  const page = await splitFinder(destination)
  await chrome.evaluate(id => window.outpostWorkspace.closeTab(id), destination)
  await page.getByRole('option').filter({ hasText: 'Alpha project' }).click()
  await expect.poll(() => menus.evaluate(menu => menu.errors.length)).toBe(1)
  expect((await state()).panes.map(pane => pane.id)).toEqual([survivor])
  expect(remotePages()).toHaveLength(0)
  expect(await menus.evaluate(menu => menu.errors[0])).toContain('moved or closed')
})
