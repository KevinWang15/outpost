import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { test, expect, type Page } from '@playwright/test'

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
  const leftHeader = page.locator('[data-pane="101"]'),
    rightHeader = page.locator('[data-pane="102"]')
  const left = (await leftHeader.boundingBox())!,
    right = (await rightHeader.boundingBox())!
  // The backgrounds meet under the separator, while controls keep their
  // original inset and the entire native gap remains available for resizing.
  expect(left.x + left.width).toBe(v!.x + v!.width / 2)
  expect(right.x).toBe(left.x + left.width)
  expect(await vertical.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  expect(await leftHeader.evaluate(node => getComputedStyle(node).paddingInlineStart)).toBe('3px')
  for (const x of [v!.x + 1, v!.x + v!.width - 1])
    expect(
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('role'), { x, y: left.y + 10 }),
    ).toBe('separator')
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

test('native activity badges share pane and tab state and retain their SVG on freshness updates', async ({ page }) => {
  const badge = page.locator('[data-pane="101"] .tab-status')
  const tab = page.locator('.tab .tab-status').first()
  for (const state of ['working', 'waiting', 'error', 'finished', 'unknown', 'idle'] as const) {
    await page.evaluate(
      state =>
        window.workspaceFixture.update(101, {
          activity: {
            state,
            updatedAt: null,
            observedAt: new Date().toISOString(),
            observation: 'current',
            completionId: state === 'finished' ? 'a'.repeat(64) : null,
            detail: null,
          },
        }),
      state,
    )
    await expect(badge).toHaveAttribute('data-state', state)
    if (['working', 'waiting', 'error', 'finished'].includes(state))
      await expect(tab).toHaveAttribute('data-state', state)
  }
  await page.evaluate(() =>
    window.workspaceFixture.update(101, {
      activity: {
        state: 'working',
        updatedAt: null,
        observedAt: new Date().toISOString(),
        observation: 'current',
        completionId: null,
        detail: null,
      },
    }),
  )
  const original = await badge.locator('svg').elementHandle()
  expect(await badge.locator('svg').evaluate(node => getComputedStyle(node).animationName)).toBe('tab-spin')
  await page.evaluate(() =>
    window.workspaceFixture.update(101, {
      activity: {
        state: 'working',
        updatedAt: null,
        observedAt: new Date().toISOString(),
        observation: 'stale',
        completionId: null,
        detail: 'Activity update delayed',
      },
    }),
  )
  await expect(badge).toHaveAttribute('data-observation', 'stale')
  await expect(badge).toHaveAttribute('title', /Working \(last known\).*Activity update delayed/)
  expect(await badge.locator('svg').evaluate((node, previous) => node === previous, original)).toBe(true)
  expect(await badge.locator('svg').evaluate(node => getComputedStyle(node).animationName)).toBe('none')
  await page.evaluate(() => window.workspaceFixture.update(101, { attention: true }))
  await expect(badge).toHaveAttribute('data-state', 'attention')
  await expect(badge).toHaveAttribute('data-observation', 'current')
  expect(await badge.locator('svg').evaluate(node => getComputedStyle(node).animationName)).toBe('tab-bell-ring')
  await page.evaluate(() => window.workspaceFixture.update(101, { kind: 'local' }))
  await expect(badge).toBeHidden()
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

test.describe('tab scrolling', () => {
  async function overflow(page: Page) {
    await page.setViewportSize({ width: 900, height: 650 })
    await page.evaluate(async () => {
      for (let i = 0; i < 11; i++) await window.outpostWorkspace.newLocal()
    })
    await expect(page.locator('.tab')).toHaveCount(12)
    await expect(page.locator('#tab-scrollbar')).toBeVisible()
  }
  const offset = (page: Page) => page.locator('#tabs').evaluate(node => node.scrollLeft)
  const range = (page: Page) => page.locator('#tabs').evaluate(node => node.scrollWidth - node.clientWidth)
  async function home(page: Page) {
    await page.locator('#tab-scrollbar').focus()
    await page.keyboard.press('Home')
    await expect.poll(() => offset(page)).toBe(0)
  }

  test('real wheel and trackpad input scroll horizontally without moving or resizing the workspace', async ({
    page,
  }) => {
    await overflow(page)
    await home(page)
    const tabs = page.locator('#tabs'),
      track = page.locator('#tab-scrollbar')
    const header = await page.locator('.chrome').boundingBox(),
      stage = await page.locator('#stage').boundingBox()
    const active = await page.evaluate(() => window.workspaceFixture.snapshot().activeTabId)
    await tabs.hover()
    await page.mouse.wheel(0, 240)
    await expect.poll(() => offset(page)).toBe(240)
    await page.mouse.wheel(0, -100)
    await expect.poll(() => offset(page)).toBe(140)
    await page.mouse.wheel(90, 0)
    await expect.poll(() => offset(page)).toBe(230)
    await track.hover()
    await page.mouse.wheel(0, 70)
    await expect.poll(() => offset(page)).toBe(300)
    await tabs.hover()
    await page.mouse.wheel(0, 10000)
    await expect.poll(() => offset(page)).toBe(await range(page))
    await page.mouse.wheel(0, -10000)
    await expect.poll(() => offset(page)).toBe(0)
    expect(await page.locator('.chrome').boundingBox()).toEqual(header)
    expect(await page.locator('#stage').boundingBox()).toEqual(stage)
    expect(await page.evaluate(() => window.workspaceFixture.snapshot().activeTabId)).toBe(active)
    expect(
      await tabs.evaluate(node => ({
        top: node.scrollTop,
        overflowX: getComputedStyle(node).overflowX,
        overflowY: getComputedStyle(node).overflowY,
        verticalRange: node.scrollHeight - node.clientHeight,
        bodyTop: document.documentElement.scrollTop,
      })),
    ).toEqual({ top: 0, overflowX: 'hidden', overflowY: 'hidden', verticalRange: 0, bodyTop: 0 })
  })

  test('wheel units are normalized and zoom gestures are left alone', async ({ page }) => {
    await overflow(page)
    await home(page)
    const results = await page.locator('#tabs').evaluate(node => {
      const wheel = (init: WheelEventInit) => {
        node.scrollLeft = 0
        const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
        node.dispatchEvent(event)
        return { prevented: event.defaultPrevented, offset: node.scrollLeft }
      }
      return {
        line: wheel({ deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE }),
        lineHeight: parseFloat(getComputedStyle(node).lineHeight),
        page: wheel({ deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE }),
        width: node.clientWidth,
        diagonal: wheel({ deltaX: 100, deltaY: 10 }),
        shift: wheel({ deltaY: 70, shiftKey: true }),
        ctrl: wheel({ deltaY: 100, ctrlKey: true }),
        meta: wheel({ deltaY: 100, metaKey: true }),
      }
    })
    expect(results.line.prevented).toBe(true)
    expect(Math.abs(results.line.offset - results.lineHeight * 3)).toBeLessThanOrEqual(1)
    expect(results.page).toEqual({ prevented: true, offset: results.width })
    expect(results.diagonal).toEqual({ prevented: true, offset: 100 })
    expect(results.shift).toEqual({ prevented: true, offset: 70 })
    expect(results.ctrl).toEqual({ prevented: false, offset: 0 })
    expect(results.meta).toEqual({ prevented: false, offset: 0 })
  })

  test('thumb dragging, track clicks and keyboard controls work at different display scales', async ({ page }) => {
    await overflow(page)
    const active = await page.evaluate(() => window.workspaceFixture.snapshot().activePaneId)
    const track = page.locator('#tab-scrollbar'),
      thumb = page.locator('#tab-scroll-thumb')
    for (const zoom of [0.8, 1, 1.5]) {
      await page.evaluate(zoom => {
        document.body.style.zoom = String(zoom)
      }, zoom)
      await home(page)
      await expect(track).toHaveAttribute('aria-valuenow', '0')
      const t = (await thumb.boundingBox())!,
        rail = (await track.boundingBox())!
      await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
      await page.mouse.down()
      await expect(track).toHaveClass(/dragging/)
      await page.mouse.move(rail.x + rail.width + 50, rail.y + rail.height / 2, { steps: 8 })
      await page.mouse.up()
      const end = await range(page)
      await expect.poll(async () => Math.abs((await offset(page)) - end)).toBeLessThanOrEqual(1)
      await expect(track).not.toHaveClass(/dragging/)
      await expect(track).toHaveAttribute('aria-valuenow', '100')
      expect(await page.evaluate(() => window.workspaceFixture.snapshot().activePaneId)).toBe(active)
      await page.mouse.click(rail.x + 1, rail.y + rail.height / 2)
      await expect.poll(() => offset(page)).toBe(0)
      await track.focus()
      await page.keyboard.press('End')
      await expect.poll(async () => Math.abs((await offset(page)) - end)).toBeLessThanOrEqual(1)
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowRight')
      await expect.poll(() => offset(page)).toBeCloseTo(40, 0)
      await page.keyboard.press('ArrowLeft')
      await expect.poll(() => offset(page)).toBe(0)
      await page.keyboard.press('PageDown')
      expect(await offset(page)).toBeGreaterThan(100)
      await page.keyboard.press('PageUp')
      await expect.poll(() => offset(page)).toBeLessThanOrEqual(1)
    }
    expect(await page.evaluate(() => window.workspaceFixture.calls.filter(call => call.name === 'dragStart'))).toEqual(
      [],
    )
    expect(
      await page.evaluate(() => window.workspaceFixture.calls.filter(call => call.name === 'activatePane')),
    ).toHaveLength(6)
  })

  test('overflow visibility stays stable around its resize boundary and after tabs close', async ({ page }) => {
    await overflow(page)
    const boundary = 900 + (await range(page))
    for (const width of [900, boundary - 2, boundary, boundary + 2, boundary + 30, 900]) {
      await page.setViewportSize({ width, height: 650 })
      // Sample consecutive rendered frames, rather than only a single settled
      // measurement: native scrollbar feedback used to alternate dimensions.
      const frames = await page.evaluate(async () => {
        const tabs = document.getElementById('tabs')!,
          track = document.getElementById('tab-scrollbar')!
        const samples: string[] = []
        for (let i = 0; i < 40; i++) {
          await new Promise(requestAnimationFrame)
          samples.push(
            JSON.stringify({
              width: tabs.clientWidth,
              height: tabs.clientHeight,
              scrollHeight: tabs.scrollHeight,
              top: tabs.scrollTop,
              hidden: track.hidden,
              expectedHidden: tabs.scrollWidth - tabs.clientWidth <= 1,
            }),
          )
        }
        return samples.slice(3)
      })
      expect(new Set(frames).size).toBe(1)
      const frame = JSON.parse(frames[0])
      expect(frame.hidden).toBe(frame.expectedHidden)
      expect(frame.top).toBe(0)
      expect(frame.height).toBe(frame.scrollHeight)
    }
    await page.locator('#tab-scrollbar').focus()
    await page.evaluate(async () => {
      for (const tab of window.workspaceFixture.snapshot().tabs.slice(1)) await window.outpostWorkspace.closeTab(tab.id)
    })
    await expect(page.locator('#tab-scrollbar')).toBeHidden()
    await expect(page.locator('.tab-select')).toBeFocused()
    expect(await offset(page)).toBe(0)
    await page.locator('#tabs').hover()
    await page.mouse.wheel(0, 200)
    expect(await offset(page)).toBe(0)
  })

  test('activation reveals the selected tab and status updates preserve manual scroll position', async ({ page }) => {
    await overflow(page)
    const tabs = await page.evaluate(() => window.workspaceFixture.snapshot().tabs.map(tab => tab.id))
    for (const id of [tabs[0], tabs.at(-1)!]) {
      await page.evaluate(id => window.outpostWorkspace.activateTab(id), id)
      const item = (await page.locator(`[data-tab="${id}"]`).boundingBox())!
      const viewport = (await page.locator('#tabs').boundingBox())!
      expect(item.x).toBeGreaterThanOrEqual(viewport.x - 1)
      expect(item.x + item.width).toBeLessThanOrEqual(viewport.x + viewport.width + 1)
    }
    await home(page)
    await page.locator('#tabs').hover()
    await page.mouse.wheel(0, 200)
    await expect.poll(() => offset(page)).toBe(200)
    await page.evaluate(() =>
      window.workspaceFixture.update(101, { attention: true, label: 'Updated background session' }),
    )
    await expect(page.locator('#tabs .tab-status[data-state="attention"]')).toHaveCount(1)
    expect(await offset(page)).toBe(200)
    expect(await page.locator('#tabs').evaluate(node => node.scrollTop)).toBe(0)
  })
})
