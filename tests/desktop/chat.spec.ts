// Outpost Desktop's chat window against a real local-mode server and fixture tools.
// Build first: npm run build:client && npm run build:terminal && node scripts/build-desktop.mjs
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test'
import { createApp } from '../../backend/app'
import { LocalDeployment } from '../../backend/deployment'
import { parseDesktopLoginCallback } from '../../shared/desktopAuth'
import type { WorkspaceSnapshot } from '../../desktop/src/workspace-api'
import type { ChatBridge } from '../../shared/chatBridge'
import { fixtureHome, removeHome } from '../integration/helpers'

declare global {
  interface Window {
    outpostChat?: ChatBridge
  }
}

let app: ElectronApplication | undefined
let server: Awaited<ReturnType<typeof createApp>> | undefined
let home: Awaited<ReturnType<typeof fixtureHome>> | undefined

test.afterEach(async () => {
  // Quitting with open tabs asks for confirmation; end the app process instead.
  app?.process().kill('SIGKILL')
  server?.server.closeAllConnections()
  await Promise.race([server?.close(), new Promise(resolve => setTimeout(resolve, 5000))])
  // Terminates the sessions it started (including the terminal tab's), then deletes the home.
  if (home) await removeHome(home.directory, home.home)
})

test('the chat window signs in with a ticket, chats, and hands a session to a terminal tab', async () => {
  home = await fixtureHome('outpost-desktop-chat-')
  server = await createApp({
    history: false,
    deployment: await LocalDeployment.open(join(home.directory, 'data')),
    env: home.env,
    multiplex: false,
    frontendRoot: resolve('dist/client'),
  })
  await server.listen({ host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`
  const headers = { 'x-outpost-request': '1', 'content-type': 'application/json' }
  const post = async (path: string, body: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { ...headers, ...extra },
      body: JSON.stringify(body),
    })
    expect(response.ok, await response.clone().text()).toBe(true)
    return response.json()
  }
  const target = await post('/api/targets', { kind: 'local', name: 'Workstation', tools: ['claude'] })
  const session = await post(`/api/targets/${target.id}/sessions`, {
    name: 'Desktop coder',
    tool: 'claude',
    rootDir: '~/desktop-chat',
    createDirectory: true,
  })
  // An app login through the same approval and PKCE exchange as Electron's.
  const verifier = randomBytes(32).toString('base64url')
  const { requestId } = await post('/api/desktop/authorizations', {
    state: randomBytes(32).toString('base64url'),
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  })
  const { callback } = await post(`/api/desktop/authorizations/${requestId}`, { allow: true, accountId: 'local' })
  const { code } = parseDesktopLoginCallback(callback)
  const credential = await post('/api/desktop/token', { code, verifier })

  const userData = join(home.directory, 'profile')
  await mkdir(userData)
  await writeFile(join(userData, 'server-trust.json'), JSON.stringify([origin]))
  await writeFile(join(userData, 'server-logins.json'), JSON.stringify([{ ...credential, origin }]))
  app = await electron.launch({
    executablePath: resolve('desktop/node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '--disable-webgl', `--user-data-dir=${userData}`, resolve('desktop')],
    env: { ...process.env, XDG_CONFIG_HOME: join(home.directory, 'config'), HISTFILE: '/dev/null' },
  })
  await expect.poll(() => app!.windows().some(page => page.url().endsWith('/workspace.html'))).toBe(true)
  const chrome = app.windows().find(page => page.url().endsWith('/workspace.html'))!
  await chrome.evaluate(server => window.outpostWorkspace.openChat(server), origin)
  await expect.poll(() => app!.windows().some(page => page.url().startsWith(`${origin}/chat/desktop`))).toBe(true)
  const chat = app.windows().find(page => page.url().startsWith(`${origin}/chat/desktop`))!
  // The page has the bridge and no browser login; its socket uses a ticket.
  expect(await chat.evaluate(() => window.outpostChat?.version)).toBe(1)
  expect(await chat.evaluate(() => document.cookie)).toBe('')

  await chat
    .getByRole('button', { name: /Desktop coder/ })
    .first()
    .click()
  const composer = chat.getByRole('textbox', { name: 'Message' })
  await composer.fill('Hello from the desktop')
  await composer.press('Enter')
  await expect(chat.locator('.reply .markdown').last()).toContainText('Fixture reply to: Hello from the desktop')
  if (process.env.CHAT_SCREENS) await chat.screenshot({ path: `${process.env.CHAT_SCREENS}/11-desktop-chat.png` })

  // Continue in a terminal ends the chat process, then opens a terminal tab in the workspace.
  await chat.getByRole('button', { name: 'Actions for Desktop coder' }).click()
  await chat.getByRole('menuitem', { name: 'Continue in a terminal' }).click()
  const dialog = chat.getByRole('dialog', { name: /Continue Desktop coder in a terminal/ })
  await dialog.getByRole('button', { name: 'Continue in a terminal' }).click()
  await chat
    .getByRole('dialog', { name: /Open Desktop coder in a terminal/ })
    .getByRole('button', { name: 'Open terminal' })
    .click()
  await expect
    .poll(async () => {
      const state: WorkspaceSnapshot = await chrome.evaluate(() => window.outpostWorkspace.state())
      return state.panes.some(pane => pane.kind === 'remote' && pane.title.startsWith('Desktop coder'))
    })
    .toBe(true)
  await expect(chat.getByRole('button', { name: /Desktop coder/ }).first()).toContainText('In a terminal')
  expect(session.name).toBe('Desktop coder')
})
