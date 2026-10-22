import { test, expect, type Page } from '@playwright/test'
import headless from '@xterm/headless'
import { checkpoint } from '../../shared/terminalCheckpoint'
import type {} from './search-harness'
import { searchService } from './search-service'

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } })

async function snapshot(text: string) {
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true, scrollback: 10_000 })
  try {
    await new Promise<void>(resolve => term.write(text, resolve))
    return [...checkpoint(term)]
  } finally {
    term.dispose()
  }
}

async function mount(page: Page, remote = false, gpu = false) {
  await page.goto(`/tests/browser/search-harness.html?${remote ? 'remote=1&' : ''}${gpu ? 'gpu=1' : ''}`)
  await page.waitForFunction(() => !!window.terminalSearchFixture)
  if (gpu) await expect(page.locator('.xterm-screen canvas')).not.toHaveCount(0)
  if (remote) await page.evaluate(parts => window.terminalSearchFixture.restore(parts), await snapshot(''))
}

async function output(page: Page, text: string) {
  await page.evaluate(async text => {
    await window.terminalSearchFixture.output(text)
    await new Promise(requestAnimationFrame)
  }, text)
}

async function find(page: Page, query = 'needle') {
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: 'Find in terminal' }).fill(query)
  await expect(page.locator('.terminal-search-count')).not.toHaveText('No results')
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await page.evaluate(() => {
    window.terminalSearchFixture.frames.length = 0
  })
}

async function assertFrames(page: Page) {
  const frames = await page.evaluate(() => window.terminalSearchFixture.frames.splice(0))
  expect(frames.length, 'inspected rendered frames').toBeGreaterThan(0)
  for (const frame of frames) {
    for (const highlight of frame.highlights) {
      expect(highlight.text, `highlight at ${highlight.row}:${highlight.column} in ${frame.buffer}`).toBe('needle')
      if (highlight.visible) expect(Math.abs(highlight.top! - highlight.expectedTop)).toBeLessThan(0.2)
    }
    if (frame.lines.some(line => line?.includes('needle'))) expect(frame.highlights.length).toBeGreaterThan(0)
  }
}

for (const gpu of [false, true]) {
  test.describe(gpu ? 'WebGL search' : 'DOM search', () => {
    test('synchronized redraw timeout releases text and highlights together', async ({ page }) => {
      await mount(page, true, gpu)
      await output(page, '\x1b[4;3Hneedle\x1b[H')
      await find(page)
      await output(page, '\x1b[?2026h\x1b[4;1H                    \x1b[12;9Hneedle\x1b[H')
      await expect
        .poll(() => page.evaluate(() => window.terminalSearchFixture.terminal.modes.synchronizedOutputMode))
        .toBe(false)
      await page.evaluate(() => new Promise(requestAnimationFrame))
      await assertFrames(page)
    })

    test('split synchronized redraws keep old highlights until the text is painted', async ({ page }) => {
      await mount(page, true, gpu)
      await output(page, '\x1b[4;3Hneedle\x1b[H')
      await find(page)
      const positions = () =>
        page
          .locator('.xterm-find-result-decoration')
          .evaluateAll(elements =>
            elements
              .filter(element => (element as HTMLElement).style.display !== 'none')
              .map(element => (element as HTMLElement).style.top),
          )
      const before = await positions()
      expect(before.length).toBeGreaterThan(0)
      await output(page, '\x1b[?2026h\x1b[4;1H                    \x1b[12;9Hneedle\x1b[H')
      expect(await positions()).toEqual(before)
      await output(page, '\x1b[?2026l')
      await assertFrames(page)
      expect(await positions()).not.toEqual(before)
    })

    test('actual Outpost Terminal output and reattachment keep search aligned', async ({ page }) => {
      const service = await searchService()
      try {
        await mount(page, true, gpu)
        const first = await service.attach()
        await page.evaluate(parts => window.terminalSearchFixture.restore(parts), first.parts)
        await output(page, await first.print('\x1b[5;3Hneedle\x1b[H'))
        await find(page)
        await output(page, await first.print('\x1b[2J\x1b[16;9Hneedle\x1b[H'))
        await assertFrames(page)
        first.disconnect()
        const second = await service.attach()
        await page.evaluate(async parts => {
          await window.terminalSearchFixture.restore(parts)
          await new Promise(requestAnimationFrame)
        }, second.parts)
        await assertFrames(page)
        await output(page, await second.print('\x1b[2J\x1b[9;2Hneedle\x1b[H'))
        await assertFrames(page)
      } finally {
        await service.dispose()
      }
    })

    test('10,000-line history remains searchable during continuous redraws', async ({ page }, info) => {
      await mount(page, true, gpu)
      await output(
        page,
        Array.from({ length: 10_030 }, (_, i) => `${i}: ${i % 100 === 0 ? 'needle' : 'a'.repeat(60)}\r\n`).join(''),
      )
      await find(page)
      await page.evaluate(() => window.terminalSearchFixture.terminal.scrollToBottom())
      const elapsed: number[] = []
      for (let row = 3; row < 20; row++) {
        elapsed.push(
          await page.evaluate(async row => {
            const start = performance.now()
            await window.terminalSearchFixture.output(`\x1b[2J\x1b[${row};1Hneedle\x1b[H`)
            await new Promise(requestAnimationFrame)
            return performance.now() - start
          }, row),
        )
        await assertFrames(page)
      }
      expect(await page.evaluate(() => window.terminalSearchFixture.terminal.buffer.active.baseY)).toBe(10_000)
      // Once full, trimming keeps baseY fixed but shifts every history row.
      await output(page, '\r\n' + 'new output\r\n'.repeat(120))
      await assertFrames(page)
      expect(await page.evaluate(() => window.terminalSearchFixture.terminal.buffer.active.baseY)).toBe(10_000)
      await output(page, '\x1b[3J')
      await expect(page.locator('.terminal-search-count')).toHaveText('No results')
      await info.attach('search-refresh-ms', { body: JSON.stringify(elapsed), contentType: 'application/json' })
    })

    test('normal scrollback highlights follow wheel scrolling in the same rendered frame', async ({ page }) => {
      await mount(page, false, gpu)
      await output(page, Array.from({ length: 160 }, (_, i) => `line ${i}: needle\r\n`).join(''))
      await find(page)
      const start = await page.evaluate(() => window.terminalSearchFixture.terminal.buffer.active.viewportY)
      await page.locator('.xterm-screen').hover()
      await page.mouse.wheel(0, 270)
      await expect
        .poll(() => page.evaluate(() => window.terminalSearchFixture.terminal.buffer.active.viewportY))
        .toBeGreaterThan(start)
      await assertFrames(page)
      await page.mouse.wheel(0, -180)
      await page.evaluate(() => new Promise(requestAnimationFrame))
      await assertFrames(page)
    })

    for (const remote of [false, true]) {
      for (const alternate of [false, true]) {
        test(`${remote ? 'remote' : 'local'} ${alternate ? 'alternate' : 'normal'} buffer TUI redraws never leave highlights on old cells`, async ({
          page,
        }) => {
          await mount(page, remote, gpu)
          await output(page, `${alternate ? '\x1b[?1049h' : ''}\x1b[2J\x1b[5;4Hneedle\x1b[H`)
          await find(page)
          // Model wheel-controlled TUI history: repaint the screen, preserving
          // the cursor. Each frame arrives sooner than the old 200 ms debounce.
          for (let row = 7; row < 20; row++) {
            const erase = row % 2 ? `\x1b[${row === 7 ? 5 : row - 1};1H${' '.repeat(30)}` : '\x1b[2J'
            await output(page, `\x1b[?2026h${erase}\x1b[${row};8Hneedle\x1b[H\x1b[?2026l`)
            await assertFrames(page)
            const frame = await page.evaluate(() => window.terminalSearchFixture.sample())
            expect(frame.highlights.every(match => match.row === row - 1 && match.column === 7)).toBe(true)
            expect(frame.highlights.length).toBeGreaterThan(0)
            expect(frame.viewport).toBe(0)
          }
          await expect(page.locator('.terminal-search-count')).toHaveText('1 of 1')
        })
      }
    }

    test('remote checkpoints and clear invalidate search without jumping to a match', async ({ page }) => {
      await mount(page, true, gpu)
      await output(page, '\x1b[3;1Hneedle\x1b[H')
      await find(page)
      const parts = await snapshot(
        'needle\r\n' + Array.from({ length: 90 }, (_, i) => `history ${i}\r\n`).join('') + 'needle',
      )
      await page.evaluate(async parts => {
        await window.terminalSearchFixture.restore(parts)
        await new Promise(requestAnimationFrame)
      }, parts)
      await assertFrames(page)
      const frame = await page.evaluate(() => window.terminalSearchFixture.sample())
      expect(frame.viewport).toBe(frame.base)
      expect(frame.base).toBeGreaterThan(0)
      await output(page, '\r\n') // Clear retains the current cursor line.
      await page.evaluate(() => window.terminalSearchFixture.clear())
      await expect(page.locator('.terminal-search-count')).toHaveText('No results')
      await page.getByRole('button', { name: 'Close search' }).click()
      await output(page, 'needle')
      expect(await page.evaluate(() => window.terminalSearchFixture.sample().highlights)).toEqual([])
    })

    test('wrapped Unicode, case changes, next/previous, resize and font changes still work', async ({ page }) => {
      await mount(page, false, gpu)
      await output(page, 'x'.repeat(77) + '你好needle\r\nNEEDLE\r\nneedle')
      await find(page, '你好needle')
      expect(await page.evaluate(() => window.terminalSearchFixture.terminal.getSelection())).toBe('你好needle')
      await page.getByRole('textbox', { name: 'Find in terminal' }).fill('needle')
      await expect(page.locator('.terminal-search-count')).toHaveText(/of 3$/)
      await page.getByRole('button', { name: 'Match case' }).click()
      await expect(page.locator('.terminal-search-count')).toHaveText(/of 2$/)
      const initial = await page.locator('.terminal-search-count').textContent()
      await page.getByRole('button', { name: 'Next match', exact: true }).click()
      await expect(page.locator('.terminal-search-count')).not.toHaveText(initial!)
      await page.getByRole('button', { name: 'Previous match', exact: true }).click()
      await expect(page.locator('.terminal-search-count')).toHaveText(initial!)
      await page.evaluate(() => {
        window.terminalSearchFixture.frames.length = 0
        window.terminalSearchFixture.terminal.resize(60, 18)
        window.terminalSearchFixture.terminal.options.fontSize = 18
      })
      await page.evaluate(() => new Promise(requestAnimationFrame))
      await assertFrames(page)
      await page.getByRole('textbox', { name: 'Find in terminal' }).press('Escape')
      await expect(page.getByRole('search')).toBeHidden()
      await output(page, '\r\nneedle')
      expect(await page.evaluate(() => window.terminalSearchFixture.sample().highlights)).toEqual([])
    })
  })
}
