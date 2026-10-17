import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { test, expect } from '@playwright/test'

let fixture: string
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/desktop/fixtures/workspace.ts'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    write: false,
  })
  fixture = result.outputFiles[0].text
})
test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: fixture })
  await page.goto(pathToFileURL(resolve('desktop/dist/workspace.html')).href)
  await expect(page.locator('.pane-header')).toHaveCount(2)
})

test('pane focus, nested splits, zoom and tab extraction preserve keyed DOM nodes and counts', async ({ page }) => {
  const header = page.locator('[data-pane="101"]')
  const node = await header.elementHandle()
  await header.locator('.pane-select').click()
  await expect(header).toHaveClass(/active/)
  expect(await page.evaluate(() => window.workspaceFixture.snapshot().activePaneId)).toBe(101)
  await page.locator('#split').click({ button: 'right' })
  await expect(page.locator('.pane-header')).toHaveCount(3)
  await expect(page.locator('.pane-count')).toHaveText('3')
  expect(await header.evaluate((element, original) => element === original, node)).toBe(true)
  await header.locator('.pane-zoom').click()
  await expect(page.locator('.pane-header')).toHaveCount(1)
  await expect(header.locator('.pane-zoom')).toHaveAccessibleName('Restore split panes')
  await header.locator('.pane-zoom').click()
  await expect(page.locator('.pane-header')).toHaveCount(3)
  await page.evaluate(() => window.workspaceFixture.extract(103))
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(page.locator('.pane-header')).toHaveCount(0)
  await page.locator('.tab-select').first().click()
  await expect(page.locator('.pane-header')).toHaveCount(2)
})

test('dividers paint a one-pixel line, keep a usable hit target and resize only their subtree', async ({ page }) => {
  await page.locator('#split').click({ button: 'right' })
  const vertical = page.locator('.pane-divider[aria-orientation="vertical"]')
  const horizontal = page.locator('.pane-divider[aria-orientation="horizontal"]')
  await expect(horizontal).toHaveCount(1)
  const v = await vertical.boundingBox(),
    h = await horizontal.boundingBox()
  expect(v!.width).toBe(6)
  expect(h!.height).toBe(6)
  expect(await vertical.evaluate(node => getComputedStyle(node, '::after').width)).toBe('1px')
  expect(await horizontal.evaluate(node => getComputedStyle(node, '::after').height)).toBe('1px')
  const before = await page.evaluate(() => window.workspaceFixture.snapshot().tree)
  await page.mouse.move(h!.x + h!.width / 2, h!.y + h!.height / 2)
  await page.mouse.down()
  await page.mouse.move(h!.x + h!.width / 2, h!.y + 90, { steps: 5 })
  await page.mouse.up()
  const after = await page.evaluate(() => window.workspaceFixture.snapshot().tree)
  expect(after).not.toEqual(before)
  expect(await vertical.boundingBox()).toEqual(v)
  await horizontal.focus()
  await page.keyboard.press('Home')
  await expect(horizontal).toHaveAttribute('aria-valuenow', '50')
  await page.keyboard.press('ArrowUp')
  await expect(horizontal).toHaveAttribute('aria-valuenow', '45')
  await horizontal.dblclick()
  await expect(horizontal).toHaveAttribute('aria-valuenow', '50')
})

test('drag selects on press, crosses a threshold once and Escape cancels without a trailing activation', async ({
  page,
}) => {
  const select = page.locator('[data-pane="101"] .pane-select')
  const box = (await select.boundingBox())!
  await page.mouse.move(box.x + 30, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.locator('[data-pane="101"]')).toHaveClass(/active/)
  await page.mouse.move(box.x + 33, box.y + box.height / 2)
  expect(
    await page.evaluate(() => window.workspaceFixture.calls.filter(call => call.name === 'dragStart')),
  ).toHaveLength(0)
  await page.mouse.move(box.x + 50, box.y + box.height / 2)
  await expect
    .poll(() => page.evaluate(() => window.workspaceFixture.calls.filter(call => call.name === 'dragStart').length))
    .toBe(1)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  const calls = await page.evaluate(() =>
    window.workspaceFixture.calls.filter(call => ['dragStart', 'dragEnd', 'activatePane'].includes(call.name)),
  )
  expect(calls).toEqual([
    { name: 'activatePane', args: [101, false] },
    { name: 'dragStart', args: [{ kind: 'pane', id: 101 }] },
    { name: 'dragEnd', args: [true] },
  ])
})

test('pane removal during a drag keeps body capture, and status refreshes retain DOM identity', async ({ page }) => {
  const header = page.locator('[data-pane="101"]'),
    original = await header.elementHandle()
  await page.evaluate(() => window.workspaceFixture.update(101, { attention: true, label: 'Changed title' }))
  expect(await header.evaluate((node, previous) => node === previous, original)).toBe(true)
  await expect(header.locator('.tab-status')).toHaveAttribute('data-state', 'attention')
  const box = (await header.locator('.pane-select').boundingBox())!
  await page.mouse.move(box.x + 20, box.y + 14)
  await page.mouse.down()
  await page.mouse.move(box.x + 40, box.y + 14)
  await expect.poll(() => page.evaluate(() => !!window.workspaceFixture.snapshot().drag)).toBe(true)
  await page.evaluate(() => window.workspaceFixture.extract(101))
  await expect(page.locator('.pane-header')).toHaveCount(0)
  await page.mouse.up()
  await expect
    .poll(() => page.evaluate(() => window.workspaceFixture.calls.filter(call => call.name === 'dragEnd')))
    .toEqual([{ name: 'dragEnd', args: [false] }])
})

test('pane error actions remain clickable and home documents the shared macOS shortcuts', async ({ page }) => {
  await page.evaluate(() => window.workspaceFixture.update(101, { error: 'Renderer failed', connection: 'closed' }))
  const error = page.locator('.placeholder')
  await expect(error).toContainText('Renderer failed')
  await error.getByRole('button', { name: 'Reload terminal' }).click()
  expect(await page.evaluate(() => window.workspaceFixture.calls.find(call => call.name === 'reloadPane'))).toEqual({
    name: 'reloadPane',
    args: [101],
  })
  await page.locator('#home').click()
  await expect(page.locator('#home-shortcuts')).toContainText('⌘D')
  await expect(
    page
      .locator('#home-shortcuts dt')
      .filter({ hasText: /^Close focused pane$/ })
      .locator('+ dd'),
  ).toHaveText('⌘W')
  await expect(page.locator('#home-shortcuts')).toContainText('⌘Shift+D')
  await expect(page.locator('#home-shortcuts')).toContainText('⌘Shift+Enter')
  await expect(page.locator('.pane-header')).toHaveCount(0)
  expect(await page.evaluate(() => window.workspaceFixture.calls.filter(call => call.name === 'reportError'))).toEqual(
    [],
  )
})
