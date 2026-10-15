import { test, expect, devices } from '@playwright/test'
import { mockTerminal } from './mobile/helpers'

test.use({
  ...devices['Pixel 7'],
  channel: 'chromium',
  launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
})

test('mobile WebGL renders Unicode and survives context loss without reconnecting or losing text', async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type, ...args) {
      const context = original.call(this, type, ...args)
      if (context && String(type).includes('webgl')) {
        Object.defineProperty(this, '__loseForTest', {
          configurable: true,
          value: () => (context as WebGL2RenderingContext).getExtension('WEBGL_lose_context')!.loseContext(),
        })
      }
      return context
    } as typeof original
  })
  const terminal = await mockTerminal(page, { inspectDom: false })
  terminal.output('\r\nGPU renders 你好 😀\r\n')
  await expect(page.locator('.xterm-screen canvas')).not.toHaveCount(0)
  await expect(page.locator('.xterm-rows')).toHaveCount(0)
  await page.getByRole('button', { name: 'Select text', exact: true }).tap()
  await expect(page.getByRole('textbox', { name: 'Terminal text' })).toHaveValue(/GPU renders 你好 😀/)
  const copied = await page.getByRole('textbox', { name: 'Terminal text' }).inputValue()
  await page.getByRole('button', { name: 'Copy all', exact: true }).tap()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copied)
  await page.getByRole('button', { name: 'Done', exact: true }).tap()
  await page.screenshot({ path: info.outputPath('mobile-webgl.png') })
  await page.locator('.xterm-screen canvas').evaluateAll(elements => {
    for (const element of elements) (element as HTMLCanvasElement & { __loseForTest?: () => void }).__loseForTest?.()
  })
  await expect(page.locator('.xterm-rows')).toContainText('GPU renders 你好 😀')
  terminal.output('STILL_RUNNING_AFTER_GPU_LOSS\r\n')
  await expect(page.locator('.xterm-rows')).toContainText('STILL_RUNNING_AFTER_GPU_LOSS')
  expect(terminal.sockets).toHaveLength(1)
})
