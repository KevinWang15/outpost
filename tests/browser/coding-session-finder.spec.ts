import { desktopAvailability } from './terminal-fixture'
import { expect, test, type Page, type Route } from '@playwright/test'
import type { CodingSessionMatch, CodingTool, Session } from '../../shared/session-manager'
import { codingToolLabels } from '../../shared/session-manager'
import { healthySoftware } from './software-fixture'
import { codingIdentity } from './session-fixture'

function match(tool: CodingTool, managerId = 'external'): CodingSessionMatch {
  return { ...codingIdentity(tool, managerId), tool, rootDir: '/home/dev/project', title: `${codingToolLabels[tool]} investigation`,
    createdAt: '2026-09-30T01:00:00Z', updatedAt: '2026-09-30T02:00:00Z', excerpt: 'PRIVATE_CONVERSATION_KEYWORD: earlier tool output and conversation text', managedSessionIds: [] }
}
async function workspace(page: Page, search: (route: Route) => Promise<unknown>, tools: CodingTool[] = ['codex', 'claude', 'kimi']) {
  const sessions: Session[] = []
  const writes: unknown[] = []
  await page.route('**/api/**', async route => {
    if (new URL(route.request().url()).pathname === '/api/auth/session') return route.fulfill({ json: { mode: 'local', user: null } })
    const path = new URL(route.request().url()).pathname
    if (path === '/api/environment') return route.fulfill({ json: { platform: 'linux', supported: true, usesWsl: false } })
    if (path === '/api/targets') return route.fulfill({ json: [{ id: 'coding', kind: 'ssh', name: 'Development', host: 'dev.example.com', tools, backends: ['tmux', 'dtach'], createdAt: '2026-09-30T00:00:00Z' }] })
    if (path.endsWith('/software')) return route.fulfill({ json: healthySoftware(['tmux', 'dtach'], tools) })
    if (path.endsWith('/coding-sessions/search')) { await search(route); return }
    if (path.endsWith('/sessions') && route.request().method() === 'POST') {
      const input = route.request().postDataJSON()
      writes.push(input)
      const created = { env: {}, args: '', ...input, id: 'linked-manager-session', createdAt: '2026-09-30T00:00:00Z', lastConnectedAt: null, activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle', socketPath: '/home/dev/.outpost/sockets/linked.sock' }
      sessions.push(created)
      return route.fulfill({ status: 201, json: created })
    }
    if (path.endsWith('/sessions')) return route.fulfill({ json: { sessions, registryPath: '/home/dev/.outpost/sessions.json' } })
    if (path.endsWith('/sessions/linked-manager-session')) return route.fulfill({ json: sessions[0] })
    if (path.endsWith('/launch')) return route.fulfill({ status: 409, json: { message: 'No desktop terminal available' } })
    if (path.endsWith('/connect')) return route.fulfill({ json: { commands: { bash: 'connect-exact-managed-session' }, expiresAt: '2026-09-30T23:59:59Z', desktop: desktopAvailability() } })
    throw new Error(`Unexpected request: ${path}`)
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New session', exact: true })).toBeEnabled()
  return { sessions, writes }
}
const finder = (page: Page) => page.getByRole('dialog', { name: 'Find coding sessions', exact: true })

test('conversation keywords are sent to the target only on submit, every submit searches live, and results are never saved in browser storage', async ({ page }) => {
  const searches: unknown[] = []
  await page.addInitScript(() => {
    const modes: string[] = []
    Object.defineProperty(window, 'codingSearchModes', { value: modes })
    const original = fetch.bind(window)
    window.fetch = (input, options) => { if (String(input).endsWith('/coding-sessions/search')) modes.push(options?.cache ?? 'default'); return original(input, options) }
  })
  await workspace(page, async route => {
    searches.push(route.request().postDataJSON())
    expect(route.request().method()).toBe('POST')
    expect(new URL(route.request().url()).search).toBe('')
    await route.fulfill({ json: { sessions: [match('codex', `external-${searches.length}`)], truncated: false, warnings: [] } })
  })
  await page.getByRole('button', { name: 'Find coding sessions', exact: true }).click()
  const dialog = finder(page)
  const query = dialog.getByRole('textbox', { name: 'Conversation keyword' })
  await query.fill(' PRIVATE_CONVERSATION_KEYWORD $(literal) [.*] ')
  expect(searches).toHaveLength(0)
  await query.press('Enter')
  await expect(dialog.getByRole('status')).toHaveText('1 matching conversation')
  expect(searches).toEqual([{ query: 'PRIVATE_CONVERSATION_KEYWORD $(literal) [.*]' }])
  await dialog.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dialog.locator('.coding-match-id')).toHaveText(match('codex', 'external-2').cliSessionId)
  expect(searches).toHaveLength(2)
  await dialog.getByRole('combobox', { name: 'Coding tool' }).selectOption('claude')
  await expect(dialog.locator('.coding-matches li')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('1 matching conversation')
  expect(searches.at(-1)).toEqual({ query: 'PRIVATE_CONVERSATION_KEYWORD $(literal) [.*]', tool: 'claude' })
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(storage).not.toContain('PRIVATE_CONVERSATION_KEYWORD')
  expect(storage).not.toContain('external-')
  expect(await page.evaluate(() => (window as unknown as { codingSearchModes: string[] }).codingSearchModes)).toEqual(['no-store', 'no-store', 'no-store'])
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Find coding sessions', exact: true }).click()
  await expect(finder(page).getByRole('textbox', { name: 'Conversation keyword' })).toHaveValue('')
  await expect(finder(page).locator('.coding-matches li')).toHaveCount(0)
  expect(searches).toHaveLength(3)
})

for (const tool of ['codex', 'claude', 'kimi'] as const) test(`${tool}: link an existing CLI conversation, preserve its ID, and connect the existing manager session from fresh finder results`, async ({ page }) => {
  const conversation = match(tool)
  const state: Awaited<ReturnType<typeof workspace>> = await workspace(page, async route => route.fulfill({ json: { sessions: [{ ...conversation, managedSessionIds: state.sessions.map(session => session.id) }], truncated: false, warnings: [] } }))
  await page.getByRole('button', { name: 'Find coding sessions', exact: true }).click()
  await finder(page).getByRole('textbox', { name: 'Conversation keyword' }).fill('PRIVATE_CONVERSATION_KEYWORD')
  await finder(page).getByRole('button', { name: 'Search', exact: true }).click()
  await finder(page).getByRole('button', { name: 'Link session', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Link a coding session' })
  await expect(form.getByRole('textbox', { name: 'Root directory' })).toHaveValue(conversation.rootDir)
  await expect(form.getByRole('textbox', { name: 'Root directory' })).toHaveAttribute('readonly', '')
  await expect(form.getByRole('combobox', { name: 'Coding tool' })).toHaveValue(tool)
  await expect(form.getByRole('combobox', { name: 'Coding tool' })).toBeDisabled()
  await expect(form.locator('.coding-session-id code')).toHaveText(conversation.cliSessionId)
  await form.getByRole('textbox', { name: 'Session name' }).fill('Found conversation')
  await form.getByRole('combobox', { name: 'Session backend' }).selectOption('dtach')
  await form.getByRole('button', { name: 'Link session', exact: true }).click()
  await expect(form).toHaveCount(0)
  expect(state.writes).toEqual([{ name: 'Found conversation', tool, backend: 'dtach', rootDir: conversation.rootDir, createDirectory: false, cliSessionId: conversation.cliSessionId, cliSessionEnv: conversation.cliSessionEnv }])
  await expect(page.locator('.session-row small')).toContainText(conversation.cliSessionId)
  await page.getByRole('button', { name: 'Find coding sessions', exact: true }).click()
  await finder(page).getByRole('textbox', { name: 'Conversation keyword' }).fill('PRIVATE_CONVERSATION_KEYWORD')
  await finder(page).getByRole('button', { name: 'Search', exact: true }).click()
  await expect(finder(page).getByText('Managed', { exact: true })).toBeVisible()
  await expect(finder(page).getByRole('button', { name: 'Link session', exact: true })).toHaveCount(0)
  await finder(page).getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(finder(page)).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Connect to Found conversation' })).toBeVisible()
  await expect(page.locator('.command-box code')).toHaveText('connect-exact-managed-session')
  expect(state.writes).toHaveLength(1)
})

test('superseded and closed searches cannot put stale results into a later finder', async ({ page }) => {
  let pending: Route | undefined
  let searches = 0
  await workspace(page, async route => {
    ++searches
    if (route.request().postDataJSON().query === 'slow') { pending = route; return }
    await route.fulfill({ json: { sessions: [match('claude', 'latest')], truncated: false, warnings: [] } })
  })
  await page.getByRole('button', { name: 'Find coding sessions', exact: true }).click()
  const dialog = finder(page)
  const query = dialog.getByRole('textbox', { name: 'Conversation keyword' })
  await query.fill('slow')
  await query.press('Enter')
  await expect(dialog.getByRole('status')).toHaveText('Searching conversation files on the target…')
  await query.fill('latest')
  await query.press('Enter')
  await expect(dialog.locator('.coding-match-id')).toHaveText(match('claude', 'latest').cliSessionId)
  await pending!.fulfill({ json: { sessions: [match('codex', 'obsolete')], truncated: false, warnings: [] } }).catch(() => {})
  await expect(dialog.locator('.coding-match-id')).toHaveText(match('claude', 'latest').cliSessionId)
  await query.fill('slow')
  await query.press('Enter')
  await expect(dialog.getByRole('status')).toHaveText('Searching conversation files on the target…')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Find coding sessions', exact: true }).click()
  await pending!.fulfill({ json: { sessions: [match('codex', 'closed')], truncated: false, warnings: [] } }).catch(() => {})
  await expect(finder(page).getByRole('textbox', { name: 'Conversation keyword' })).toHaveValue('')
  await expect(finder(page).locator('.coding-matches li')).toHaveCount(0)
  expect(searches).toBe(3)
})

test('search errors can be retried, partial results are marked, and unconfigured tools cannot be linked accidentally', async ({ page }) => {
  let attempts = 0
  await workspace(page, async route => {
    ++attempts
    await route.fulfill(attempts === 1 ? { status: 502, json: { message: 'SSH unavailable' } }
      : { json: { sessions: [match('kimi')], truncated: true, warnings: ['Search reached its byte limit. Results are partial.'] } })
  }, ['codex'])
  await page.getByRole('button', { name: 'Find coding sessions', exact: true }).click()
  const dialog = finder(page)
  await expect(dialog.getByRole('button', { name: 'Search', exact: true })).toBeDisabled()
  const query = dialog.getByRole('textbox', { name: 'Conversation keyword' })
  await query.fill('keyword')
  await query.press('Enter')
  await expect(dialog.getByRole('alert')).toHaveText('SSH unavailable')
  await expect(query).toHaveValue('keyword')
  await dialog.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dialog.locator('.finder-result-count')).toHaveText('1 matching conversation · Partial results')
  await expect(dialog.getByText('Search reached its byte limit. Results are partial.')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Link session', exact: true })).toBeDisabled()
  await expect(dialog.getByText('Check Required Software for Kimi and a session backend before linking.')).toBeVisible()
  await page.mouse.click(8, 8)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(query).toHaveValue('keyword')
  await page.screenshot({ path: 'test-results/coding-finder-desktop.png' })
  await page.setViewportSize({ width: 390, height: 600 })
  await dialog.getByRole('button', { name: 'Done', exact: true }).scrollIntoViewIfNeeded()
  const box = (await dialog.boundingBox())!
  expect(box.width).toBeLessThanOrEqual(358)
  expect(box.y + box.height).toBeLessThanOrEqual(600)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/coding-finder-mobile.png' })
})
