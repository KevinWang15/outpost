import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, _electron as electron } from '@playwright/test'
import { showTerminalToolbar } from './terminal'

test.skip(process.platform !== 'linux', 'The native input recorder requires Linux and Python 3.')

// Run with xvfb-run on Linux; use the real app, preload, IPC and node-pty binding.
test('local desktop image picker, drop and native clipboard save bytes and paste paths into the owning shell', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outpost-desktop-images-'))
  const userData = join(directory, 'profile')
  const capture = join(directory, 'input.bin')
  const script = join(directory, 'capture.py')
  await writeFile(
    script,
    `import os, sys, tty\ntty.setraw(sys.stdin.fileno())\nprint('LOCAL_IMAGE_READY', flush=True)\nwith open(sys.argv[1], 'ab', buffering=0) as stream:\n    while True:\n        data = os.read(sys.stdin.fileno(), 4096)\n        if not data: break\n        stream.write(data)\n`,
  )
  const app = await electron.launch({
    executablePath: resolve('desktop/node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '--disable-webgl', `--user-data-dir=${userData}`, resolve('desktop')],
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), HISTFILE: '/dev/null' },
  })
  try {
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
    })
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData)
    await expect.poll(() => app.windows().some(page => page.url().includes('/local-terminal/'))).toBe(true)
    const page = app.windows().find(page => page.url().includes('/local-terminal/'))!
    await showTerminalToolbar(page)
    await expect(page.getByRole('status', { name: 'Connected', exact: true })).toBeVisible()
    const field = page.getByRole('textbox', { name: 'Terminal input' })
    await field.pressSequentially(`unset HISTFILE; exec python3 -u '${script}' '${capture}'`)
    await field.press('Enter')
    await expect(page.locator('.xterm-rows')).toContainText('LOCAL_IMAGE_READY')
    const size = await page.locator('.xterm-screen').boundingBox()
    const image = await readFile(resolve('public/outpost-256.png'))
    const stored = async () => {
      const root = join(userData, 'clipboard')
      const tabs = await readdir(root).catch(() => [])
      return (
        await Promise.all(tabs.map(async tab => (await readdir(join(root, tab))).map(name => join(root, tab, name))))
      ).flat()
    }
    const input = () => readFile(capture, 'utf8')
    let previous = ''
    for (const kind of ['picker', 'drop', 'native-paste']) {
      const before = await stored()
      if (kind === 'picker')
        await page
          .locator('input[type=file]')
          .setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: image })
      else if (kind === 'drop')
        await page.locator('.xterm').evaluate(
          (element, bytes) => {
            const transfer = new DataTransfer()
            transfer.items.add(new File([new Uint8Array(bytes)], 'drop.png', { type: 'image/png' }))
            element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
          },
          [...image],
        )
      else {
        await app.evaluate(
          ({ clipboard, ClipboardItem }, bytes) =>
            clipboard.write([
              new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) }),
            ]),
          [...image],
        )
        await field.click()
        expect(await app.evaluate(({ clipboard }) => clipboard.has('image/png'))).toBe(true)
        await app.evaluate(({ Menu }) => {
          const edit = Menu.getApplicationMenu()!.items.find((item: { label: string }) => item.label === 'Edit')!
          edit.submenu!.items.find((item: { label: string }) => item.label === 'Paste')!.click()
        })
      }
      await expect.poll(stored).toHaveLength(before.length + 1)
      const added = (await stored()).find(path => !before.includes(path))!
      if (kind !== 'native-paste') expect(await readFile(added)).toEqual(image)
      else
        expect(
          await app.evaluate(({ nativeImage }, path) => nativeImage.createFromPath(path).getSize(), added),
        ).toEqual({ width: 256, height: 256 })
      previous += `'${added}' `
      await expect.poll(input).toBe(previous)
      await expect(page.getByRole('status').filter({ hasText: 'Image pasted' })).toBeVisible()
      expect(await page.locator('.xterm-screen').boundingBox()).toEqual(size)
    }
    await app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()!.items.find((item: { label: string }) => item.label === 'File')!
      file.submenu!.items.find((item: { label: string }) => item.label === 'Close current tab')!.click()
    })
    await expect.poll(stored).toHaveLength(0)
  } finally {
    await app.close()
    await rm(directory, { recursive: true, force: true })
  }
})
