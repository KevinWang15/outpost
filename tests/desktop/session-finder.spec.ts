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
let catalogueFailure = false,
  connectFailure = false,
  loseCreateReply = false,
  creations = 0
let createdSessions: { sessionId: string; title: string }[] = []
let creationRequests: string[] = []
let receipts = new Map<string, { sessionId: string; title: string }>()
let holdConnect = false
let releaseConnect: (() => void) | null = null
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
  catalogueFailure = connectFailure = loseCreateReply = false
  creations = 0
  createdSessions = []
  creationRequests = []
  receipts = new Map()
  holdConnect = false
  releaseConnect = null
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
      if (path === '/targets/target/session-options') {
        response.end(JSON.stringify({ tools: ['codex'], missing: [] }))
        return
      }
      if (path.startsWith('/targets/target/directories')) {
        response.end(JSON.stringify({ directories: [], truncated: false }))
        return
      }
      if (path === '/targets/target/sessions' && request.method === 'POST') {
        let body = ''
        request.on('data', chunk => {
          body += chunk
        })
        request.on('end', () => {
          const { requestId, input } = JSON.parse(body)
          creationRequests.push(requestId)
          let session = receipts.get(requestId)
          if (!session) {
            session = { sessionId: `created-${++creations}`, title: `${input.name} · Target` }
            createdSessions.push(session)
            receipts.set(requestId, session)
          }
          if (loseCreateReply) response.destroy()
          else
            response.writeHead(201).end(JSON.stringify({ ...session, targetId: 'target', detail: 'Created fixture' }))
        })
        return
      }
      if (path === '/targets/target/sessions' && catalogueFailure) {
        response.writeHead(503).end(JSON.stringify({ message: 'Temporary catalogue outage' }))
        return
      }
      if (path.endsWith('/connect') && connectFailure) {
        response.writeHead(503).end(JSON.stringify({ message: 'Temporary connect outage' }))
        return
      }
      if (path === '/account') response.end(JSON.stringify(credential))
      else if (path === '/targets') response.end(JSON.stringify([{ id: 'target', name: 'Target' }]))
      else if (path === '/targets/target/sessions')
        response.end(
          JSON.stringify([
            ...recents.map((entry, index) => ({
              sessionId: index ? 'b' : 'a',
              targetId: 'target',
              title: entry.title,
              detail: 'Fixture',
            })),
            ...createdSessions.map(entry => ({ ...entry, targetId: 'target', detail: 'Created fixture' })),
          ]),
        )
      else {
        const key = path.split('/sessions/')[1]?.split('/')[0] ?? 'a'
        const send = () =>
          response.end(
            JSON.stringify({
              server: origin,
              accountId: 'fixture',
              targetId: 'target',
              sessionId: key,
              loginId: 'desktop:' + '0'.repeat(36),
              token: `${key}.signature`,
              title:
                createdSessions.find(entry => entry.sessionId === key)?.title ??
                (key === 'a' ? 'Alpha project' : 'Beta review'),
            }),
          )
        if (holdConnect) releaseConnect = send
        else send()
      }
      return
    }
    response.setHeader('Content-Type', 'text/html')
    response.end(`<body><textarea id="draft" aria-label="Draft"></textarea><script>
      window.outpostDesktop.ticket().then(token => {
        const title = token.startsWith('created-') ? 'New project · Target' : token.startsWith('a.') ? 'Alpha project' : 'Beta review';
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
  await expect(page.getByRole('alert')).toContainText('moved or closed')
  expect((await state()).panes.map(pane => pane.id)).toEqual([survivor])
  expect(remotePages()).toHaveLength(0)
  expect(page.isClosed()).toBe(false)
})

async function createInFinder(page: Page) {
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await expect.poll(() => app.windows().some(page => page.url().includes('/session-creator/index.html'))).toBe(true)
  const modal = app.windows().find(page => page.url().includes('/session-creator/index.html'))!
  await modal.getByRole('textbox', { name: 'Name', exact: true }).fill('New project')
  await modal.locator('input[name="rootDir"]').fill('/tmp/project')
  await submitCreation(modal)
  return modal
}
async function submitCreation(modal: Page) {
  await modal
    .getByRole('button', { name: 'Create session', exact: true })
    .click()
    .catch(error => {
      if (!modal.isClosed()) throw error
    })
}
async function expectPickerFocus(page: Page) {
  await expect(page.getByRole('combobox')).toBeFocused()
  const window = await app.browserWindow(page)
  await expect.poll(() => window.evaluate(window => window.isFocused())).toBe(true)
}

for (const placement of ['tab', 'split'] as const) {
  test(`creation returns to the picker, then selection opens the new session in the captured ${placement}`, async () => {
    const before = await state(),
      rectangles = await bounds()
    const page = placement === 'tab' ? await newTabFinder() : await splitFinder(before.activeTabId!)
    await page.getByRole('combobox').fill('old unmatched query')
    const modal = await createInFinder(page)
    await expect.poll(() => modal.isClosed()).toBe(true)
    await expectPickerFocus(page)
    await expect(page.getByRole('combobox')).toHaveValue('')
    await expect(page.getByRole('option', { selected: true })).toContainText('New project')
    expect((await state()).tabs.length).toBe(before.tabs.length)
    expect(await bounds()).toEqual(rectangles)
    await dismissWithKey(page, 'Enter')
    await expect.poll(async () => (await state()).panes.some(pane => pane.title === 'New project · Target')).toBe(true)
    const after = await state()
    expect(after.tabs.length).toBe(before.tabs.length + (placement === 'tab' ? 1 : 0))
    if (placement === 'split') {
      expect(after.activeTabId).toBe(before.activeTabId)
      expect(after.tabs[0].panes).toHaveLength(2)
    }
    expect(creations).toBe(1)
  })
}

test('a failed refresh preserves old rows and the confirmed create; retry works in the same picker', async () => {
  const page = await newTabFinder()
  await expect(page.getByRole('option')).toHaveCount(2)
  catalogueFailure = true
  const modal = await createInFinder(page)
  await expect.poll(() => modal.isClosed()).toBe(true)
  await expectPickerFocus(page)
  await expect(page.getByRole('alert')).toContainText('Temporary catalogue outage')
  await expect(page.getByRole('option')).toHaveCount(3)
  await expect(page.getByRole('option', { selected: true })).toContainText('New project')
  catalogueFailure = false
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('alert')).toBeHidden()
  await expect(page.getByRole('option')).toHaveCount(3)
  await dismissWithKey(page, 'Enter')
  await expect.poll(async () => (await state()).panes.some(pane => pane.title === 'New project · Target')).toBe(true)
})

test('connect failure preserves query and selection, and retry opens exactly one tab', async () => {
  const page = await newTabFinder()
  await page.getByRole('combobox').fill('beta')
  connectFailure = true
  await page.getByRole('combobox').press('Enter')
  await expect(page.getByRole('alert')).toContainText('Temporary connect outage')
  await expectPickerFocus(page)
  await expect(page.getByRole('combobox')).toHaveValue('beta')
  await expect(page.getByRole('option', { selected: true })).toContainText('Beta review')
  expect((await state()).tabs).toHaveLength(1)
  connectFailure = false
  await dismissWithKey(page, 'Enter')
  await expect.poll(async () => (await state()).tabs.length).toBe(2)
})

test('lost create reply can be retried with the same request identity without duplicating the session', async () => {
  const page = await newTabFinder()
  loseCreateReply = true
  const modal = await createInFinder(page)
  await expect(modal.getByRole('alert')).toContainText('Try again with the same settings')
  expect(createdSessions).toHaveLength(1)
  loseCreateReply = false
  await submitCreation(modal)
  await expect.poll(() => modal.isClosed()).toBe(true)
  await expectPickerFocus(page)
  await expect(page.getByRole('option', { selected: true })).toContainText('New project')
  expect(creationRequests).toHaveLength(2)
  expect(new Set(creationRequests).size).toBe(1)
  expect(creations).toBe(1)
  await dismissWithKey(page, 'Enter')
  await expect.poll(async () => (await state()).tabs.length).toBe(2)
})

test('cancelling after an uncertain creation refreshes the picker without opening a tab', async () => {
  const page = await newTabFinder()
  await expect(page.getByRole('option')).toHaveCount(2)
  loseCreateReply = true
  const modal = await createInFinder(page)
  await expect(modal.getByRole('alert')).toBeVisible()
  await modal.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expectPickerFocus(page)
  await expect(page.getByRole('option').filter({ hasText: 'New project' })).toHaveCount(1)
  expect((await state()).tabs).toHaveLength(1)
  await dismissWithKey(page, 'Escape')
  expect(creations).toBe(1)
})

test('Escape cancels a pending connection and a late response cannot create a tab', async () => {
  const page = await newTabFinder()
  await expect(page.getByRole('option')).toHaveCount(2)
  holdConnect = true
  await page.getByRole('combobox').press('Enter')
  await expect.poll(() => releaseConnect !== null).toBe(true)
  await page.keyboard.press('Escape').catch(error => {
    if (!page.isClosed()) throw error
  })
  await expect.poll(() => page.isClosed()).toBe(true)
  releaseConnect!()
  holdConnect = false
  // A round trip through another picker ensures the late reply has been handled.
  const reopened = await newTabFinder()
  await expect(reopened.getByRole('option')).toHaveCount(2)
  expect((await state()).tabs).toHaveLength(1)
  expect(remotePages()).toHaveLength(0)
})
