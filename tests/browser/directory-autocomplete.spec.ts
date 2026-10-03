import { healthySoftware } from './software-fixture'
import { expect, test, type Page, type Route } from '@playwright/test'

async function workspace(page: Page, directories: (route: Route, path: string) => Promise<void>) {
  const created: Record<string, unknown>[] = []
  const requested: string[] = []
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/software')) return route.fulfill({ json: healthySoftware() })
    if (url.pathname.endsWith('/directories')) {
      const path = url.searchParams.get('path')!
      requested.push(path)
      return directories(route, path)
    }
    if (url.pathname === '/api/targets') return route.fulfill({ json: [{
      id: 'target', name: 'Development', tools: ['codex', 'kimi', 'claude'], kind: 'ssh', host: 'dev', backends: ['tmux'], createdAt: '2026-09-29T00:00:00Z',
      environment: { home: '/root', platform: 'linux', username: 'root', uid: 0, shell: '/bin/bash',  },
    }] })
    if (url.pathname.endsWith('/sessions')) {
      if (route.request().method() === 'POST') {
        created.push(route.request().postDataJSON())
        return route.fulfill({ status: 201, json: { ...created.at(-1), id: 'new-session', backend: 'tmux', activity: { state: 'idle', updatedAt: null, completionId: null, detail: null }, status: 'idle' } })
      }
      return route.fulfill({ json: { sessions: [], registryPath: '/root/.outpost/sessions.json' } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'New session', exact: true }).click()
  await page.getByRole('textbox', { name: 'Session name' }).fill('Autocomplete')
  return { created, requested, input: page.getByRole('combobox', { name: 'Root directory' }) }
}

test('debounces SSH lookups and supports keyboard, Tab, mouse selection, and freeform submission', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-29T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-29T00:00:01Z'))
  const { created, requested, input } = await workspace(page, async (route, path) => {
    const suggestions: Record<string, string[]> = {
      '/root/pr': ['/root/project/', '/root/prototype/'],
      '/root/project/': ['/root/project/src/'],
      '/root/project/src/': ['/root/project/src/lib/'],
    }
    await route.fulfill({ json: { directories: suggestions[path] ?? [], truncated: false } })
  })
  await input.fill('/root/p')
  await page.clock.runFor(100)
  await input.fill('/root/pro')
  await page.clock.runFor(100)
  await input.fill('/root/pr')
  await page.clock.runFor(249)
  expect(requested).toEqual([])
  await page.clock.runFor(1)
  await expect(page.getByRole('listbox', { name: 'Target directories' }).getByRole('option')).toHaveCount(2)
  expect(requested).toEqual(['/root/pr'])
  await input.press('ArrowDown')
  await expect(page.getByRole('listbox', { name: 'Target directories' }).getByRole('option', { name: '/root/project/', exact: true })).toHaveAttribute('aria-selected', 'true')
  await input.press('Enter')
  await expect(input).toHaveValue('/root/project/')
  expect(created).toEqual([])
  await page.clock.runFor(250)
  await expect(page.getByRole('listbox', { name: 'Target directories' }).getByRole('option')).toHaveCount(1)
  await input.press('Tab')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('/root/project/src/')
  await page.clock.runFor(250)
  await page.getByRole('listbox', { name: 'Target directories' }).getByRole('option', { name: '/root/project/src/lib/', exact: true }).click()
  await expect(input).toHaveValue('/root/project/src/lib/')
  await expect(input).toBeFocused()
  await input.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(created).toEqual([{ name: 'Autocomplete', rootDir: '/root/project/src/lib/', backend: 'tmux', tool: 'codex', createDirectory: false }])
})

test('cancels outdated requests, ignores late responses, and re-fetches on focus', async ({ page }) => {
  let oldRoute: Route | undefined
  let freshReads = 0
  const aborted: string[] = []
  page.on('requestfailed', request => aborted.push(request.url()))
  const { input, requested } = await workspace(page, async (route, path) => {
    if (path === '/root/old') { oldRoute = route; return }
    if (path === '/root/new') {
      await route.fulfill({ json: { directories: [`/root/new-${++freshReads}/`], truncated: false } })
    } else await route.fulfill({ json: { directories: [], truncated: false } })
  })
  await input.fill('/root/old')
  await expect.poll(() => requested).toContain('/root/old')
  await input.fill('/root/new')
  await expect(page.getByRole('listbox', { name: 'Target directories' }).getByRole('option')).toHaveText('/root/new-1/')
  await expect.poll(() => aborted.some(url => new URL(url).searchParams.get('path') === '/root/old')).toBe(true)
  await oldRoute!.fulfill({ json: { directories: ['/root/old-wrong/'], truncated: false } }).catch(() => {})
  await expect(page.getByRole('listbox', { name: 'Target directories' }).getByRole('option')).toHaveText('/root/new-1/')
  await input.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await page.getByRole('textbox', { name: 'Session name' }).focus()
  await input.focus()
  await expect(page.getByRole('listbox', { name: 'Target directories' }).getByRole('option')).toHaveText('/root/new-2/')
  expect(freshReads).toBe(2)
  await input.fill('/root/old')
  await expect.poll(() => requested.filter(path => path === '/root/old').length).toBe(2)
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect.poll(() => aborted.filter(url => new URL(url).searchParams.get('path') === '/root/old').length).toBe(2)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('supports home paths and truncated lists, retries failures, and allows new paths without suggestions', async ({ page }) => {
  let reads = 0
  const { input, requested, created } = await workspace(page, async (route, path) => {
    if (path === '~/' && ++reads === 1) return route.fulfill({ status: 502, json: { message: 'SSH unavailable' } })
    return route.fulfill({ json: path === '~/'
      ? { directories: ['~/projects/'], truncated: true }
      : { directories: [], truncated: false } })
  })
  await input.fill('~/')
  await expect(page.getByRole('status')).toContainText('SSH unavailable')
  await page.getByRole('button', { name: 'Retry lookup' }).click()
  await expect(page.getByRole('listbox', { name: 'Target directories' }).getByRole('option', { name: '~/projects/', exact: true })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Keep typing to narrow the list')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/directory-completion-mobile.png', fullPage: true })
  await input.fill('relative')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await input.fill("~/new project's folder")
  await expect(page.getByRole('status')).toContainText('No matching directories')
  expect(requested).not.toContain('relative')
  await page.getByRole('checkbox', { name: 'Create the directory' }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Create session', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(created[0]).toMatchObject({ rootDir: "~/new project's folder", createDirectory: true })
})

test('clicking away from autocomplete, dialog padding, backdrop, and repeated Escape preserves the session draft', async ({ page }) => {
  const { input, created } = await workspace(page, async route => {
    await route.fulfill({ json: { directories: ['/root/project/'], truncated: false } })
  })
  const dialog = page.getByRole('dialog', { name: 'Create a session' })
  await page.getByText('Arguments and environment variables (optional)', { exact: true }).click()
  await page.getByRole('textbox', { name: 'Arguments', exact: true }).fill('--model "$MODEL"')
  await page.getByRole('button', { name: 'Add variable', exact: true }).click()
  await page.getByRole('textbox', { name: 'Environment variable name 1' }).fill('MODEL')
  await page.getByRole('textbox', { name: 'Environment variable value 1' }).fill('test value')
  await input.fill('/root/pr')
  await expect(page.getByRole('listbox')).toBeVisible()
  const box = (await dialog.boundingBox())!
  const field = (await input.boundingBox())!
  const padding = { x: box.x + 8, y: field.y + field.height / 2 }
  expect(await page.evaluate(position => document.elementFromPoint(position.x, position.y)?.tagName, padding)).toBe('DIALOG')
  await page.mouse.click(padding.x, padding.y)
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await input.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.mouse.click(8, 8)
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await input.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await input.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await input.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(input).toHaveValue('/root/pr')
  await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue('Autocomplete')
  await expect(page.getByRole('textbox', { name: 'Arguments', exact: true })).toHaveValue('--model "$MODEL"')
  await expect(page.getByRole('textbox', { name: 'Environment variable value 1' })).toHaveValue('test value')
  await dialog.getByRole('button', { name: 'Create session', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(created).toEqual([{ name: 'Autocomplete', rootDir: '/root/pr', backend: 'tmux', tool: 'codex', createDirectory: false, args: '--model "$MODEL"', env: { MODEL: 'test value' } }])
})

test('a pointer press in the path field followed by release on the backdrop cannot discard the draft', async ({ page }) => {
  const { input } = await workspace(page, async route => {
    await route.fulfill({ json: { directories: ['/root/project/'], truncated: false } })
  })
  await input.fill('/root/pr')
  await expect(page.getByRole('listbox')).toBeVisible()
  const box = (await input.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(8, 8)
  await page.mouse.up()
  await expect(page.getByRole('dialog', { name: 'Create a session' })).toBeVisible()
  await expect(input).toHaveValue('/root/pr')
  await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue('Autocomplete')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('clicking the directory label commits the typed path and releases focus', async ({ page }) => {
  const { input, created } = await workspace(page, async route => {
    await route.fulfill({ json: { directories: ['/root/project/'], truncated: false } })
  })
  const dialog = page.getByRole('dialog', { name: 'Create a session' })
  await input.fill('/root/pr')
  await expect(page.getByRole('listbox')).toBeVisible()
  await dialog.getByText('Root directory', { exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(input).not.toBeFocused()
  await expect(input).toHaveValue('/root/pr')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Create session', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(created[0]).toMatchObject({ name: 'Autocomplete', rootDir: '/root/pr' })
})

test('an outside click cancels the pending lookup and late responses cannot reopen the popup', async ({ page }) => {
  let pending: Route | undefined
  const aborted: string[] = []
  page.on('requestfailed', request => aborted.push(request.url()))
  const { input, requested } = await workspace(page, async route => { pending = route })
  await input.fill('/root/pending')
  await expect.poll(() => requested).toContain('/root/pending')
  await page.getByRole('dialog').getByText('Root directory', { exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(input).not.toBeFocused()
  await expect.poll(() => aborted.some(url => new URL(url).searchParams.get('path') === '/root/pending')).toBe(true)
  await pending!.fulfill({ json: { directories: ['/root/pending/'], truncated: false } }).catch(() => {})
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(input).toHaveValue('/root/pending')
  await expect(page.getByRole('textbox', { name: 'Session name' })).toHaveValue('Autocomplete')
  await expect(page.getByRole('dialog')).toBeVisible()
})

test.describe('touch autocomplete', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test('tapping a suggestion keeps input focus and tapping elsewhere only dismisses the suggestions', async ({ page }) => {
    const { input } = await workspace(page, async route => {
      await route.fulfill({ json: { directories: ['/root/project/'], truncated: false } })
    })
    await input.fill('/root/pr')
    await page.getByRole('option', { name: '/root/project/', exact: true }).tap()
    await expect(input).toHaveValue('/root/project/')
    await expect(input).toBeFocused()
    await page.getByRole('heading', { name: 'Create a session' }).tap()
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(input).toHaveValue('/root/project/')
    await page.getByRole('button', { name: 'Cancel', exact: true }).tap()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})
