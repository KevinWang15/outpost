import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import type { PaneBounds } from '../../desktop/src/layout'
import type { WorkspaceSnapshot } from '../../desktop/src/workspace-api'
import { showTerminalToolbar } from './terminal'

const execute = promisify(execFile)
test.skip(process.platform !== 'linux', 'Native pointer/keyboard coverage uses X11 and xdotool on Linux.')
let app: ElectronApplication, chrome: Page, directory: string
const state = (page = chrome): Promise<WorkspaceSnapshot> => page.evaluate(() => window.outpostWorkspace.state())
const workspaces = () => app.windows().filter(page => page.url().endsWith('/workspace.html'))
async function bounds(page = chrome): Promise<PaneBounds> {
  const window = await app.browserWindow(page)
  return window.evaluate(window => window.getContentBounds())
}
async function position(page: Page, x: number, y: number, width = 900, height = 650) {
  const window = await app.browserWindow(page)
  await window.evaluate(
    (window, value) => {
      window.setBounds(value)
      window.show()
      window.focus()
    },
    { x, y, width, height },
  )
}
async function terminal(id: number) {
  const marker = `pane-${id}`
  await app.evaluate(
    async ({ webContents }, { id, marker }) => {
      await webContents
        .fromId(id)!
        .executeJavaScript(`document.documentElement.dataset.paneTestId = ${JSON.stringify(marker)}`)
    },
    { id, marker },
  )
  for (const page of app.windows())
    if (
      await page.evaluate(marker => document.documentElement.dataset.paneTestId === marker, marker).catch(() => false)
    )
      return page
  throw Error(`Missing terminal ${id}`)
}
async function menu(section: string, label: string) {
  await app.evaluate(
    ({ Menu }, { section, label }) => {
      Menu.getApplicationMenu()!
        .items.find((item: { label: string }) => item.label === section)!
        .submenu!.items.find((item: { label: string }) => item.label === label)!
        .click()
    },
    { section, label },
  )
}
async function key(value: string) {
  // --clearmodifiers also releases held mouse buttons, committing an in-flight
  // drag before Escape can cancel it. Each key chord releases its own modifiers.
  await execute('xdotool', ['key', value])
}
async function cursor(x: number, y: number) {
  await execute('xdotool', ['mousemove', '--sync', String(Math.round(x)), String(Math.round(y))])
}
async function startDrag(page: Page, selector: string) {
  const window = await app.browserWindow(page)
  await window.evaluate(window => {
    window.show()
    window.focus()
  })
  const b = (await page.locator(selector).boundingBox())!,
    origin = await bounds(page)
  const x = origin.x + b.x + Math.min(35, b.width / 2),
    y = origin.y + b.y + b.height / 2
  await cursor(x, y)
  await execute('xdotool', ['mousedown', '1'])
  await cursor(x + 16, y)
  await expect.poll(async () => (await state(page)).drag !== null).toBe(true)
}
async function drop() {
  await execute('xdotool', ['mouseup', '1'])
}
interface NativePane {
  id: number
  bounds: PaneBounds
  visible: boolean
}
async function nativePanes(page = chrome): Promise<NativePane[]> {
  const window = await app.browserWindow(page)
  return window.evaluate(window =>
    window.contentView.children.flatMap(
      (view: { webContents?: { id: number }; getBounds(): PaneBounds; getVisible(): boolean }) => {
        if (!view.webContents) return []
        const contents = view.webContents
        return [{ id: contents.id, bounds: view.getBounds(), visible: view.getVisible() }]
      },
    ),
  )
}
async function splitThree() {
  await chrome.locator('#split').click()
  await expect.poll(async () => (await state()).panes.length).toBe(2)
  await chrome.locator('#split').click({ button: 'right' })
  await expect.poll(async () => (await state()).panes.length).toBe(3)
  await expect(chrome.locator('.pane-header')).toHaveCount(3)
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'outpost-panes-'))
  app = await electron.launch({
    executablePath: resolve('desktop/node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '--disable-webgl', `--user-data-dir=${join(directory, 'profile')}`, resolve('desktop')],
    env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'config'), HISTFILE: '/dev/null' },
  })
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  await expect.poll(() => workspaces().length).toBe(1)
  chrome = workspaces()[0]
  await expect.poll(async () => (await state()).panes[0]?.connection).toBe('connected')
  await position(chrome, 30, 40)
})
test.afterEach(async () => {
  const info = test.info()
  await execute('xdotool', ['mouseup', '1']).catch(() => {})
  if (info.status !== info.expectedStatus && app) {
    for (const [index, page] of workspaces().entries()) {
      await info.attach(`workspace-${index}.json`, {
        body: JSON.stringify(await state(page).catch(() => null), null, 2),
        contentType: 'application/json',
      })
      await page.screenshot({ path: info.outputPath(`workspace-${index}.png`) }).catch(() => {})
    }
  }
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
      })
      .catch(() => {})
    await app.close().catch(() => {})
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

test('native split accelerators operate once from terminal focus; dimming is click-through and never resizes panes', async () => {
  const original = (await state()).activePaneId!
  await key('ctrl+shift+d')
  await expect.poll(async () => (await state()).panes.length).toBe(2)
  expect((await state()).tree?.kind).toBe('split')
  await key('ctrl+alt+d')
  await expect.poll(async () => (await state()).panes.length).toBe(3)
  const tree = (await state()).tree!
  expect(tree.kind === 'split' && tree.direction).toBe('columns')
  expect(tree.kind === 'split' && tree.second.kind === 'split' && tree.second.direction).toBe('rows')
  const before = await nativePanes()
  const first = await terminal(original)
  await expect
    .poll(() => first.evaluate(() => getComputedStyle(document.documentElement, '::after').content))
    .toBe('""')
  expect(await first.evaluate(() => getComputedStyle(document.documentElement, '::after').pointerEvents)).toBe('none')
  const screenBefore = await first.locator('.xterm-screen').boundingBox()
  const pane = before.find(pane => pane.id === original)!,
    origin = await bounds()
  await cursor(origin.x + pane.bounds.x + 25, origin.y + pane.bounds.y + 45)
  await execute('xdotool', ['click', '1'])
  await expect.poll(async () => (await state()).activePaneId).toBe(original)
  await expect
    .poll(() => first.evaluate(() => getComputedStyle(document.documentElement, '::after').content))
    .toBe('none')
  expect(await nativePanes()).toEqual(before)
  expect(await first.locator('.xterm-screen').boundingBox()).toEqual(screenBefore)
  await key('ctrl+shift+Return')
  await expect(chrome.locator('.pane-header')).toHaveCount(1)
  await key('ctrl+shift+Return')
  await expect(chrome.locator('.pane-header')).toHaveCount(3)
  expect((await state()).tree).toEqual(tree)
  expect((await nativePanes()).map(pane => pane.id)).toEqual(before.map(pane => pane.id))
})

test('native pane dragging reorganizes a tree, can cancel, and creates a standalone tab without recreating views', async () => {
  await splitThree()
  const initial = await state(),
    first = initial.panes[0].id,
    target = initial.panes[2].id
  const targetBounds = (await nativePanes()).find(pane => pane.id === target)!.bounds,
    origin = await bounds()
  await startDrag(chrome, `[data-pane="${first}"] .pane-select`)
  await cursor(origin.x + targetBounds.x + 20, origin.y + targetBounds.y + targetBounds.height / 2)
  await drop()
  await expect.poll(async () => (await state()).drag).toBeNull()
  await expect.poll(async () => JSON.stringify((await state()).tree)).not.toBe(JSON.stringify(initial.tree))
  expect((await state()).panes.map(pane => pane.id).sort()).toEqual(initial.panes.map(pane => pane.id).sort())
  const rearranged = (await state()).tree
  await startDrag(chrome, `[data-pane="${first}"] .pane-select`)
  await cursor(2200, 1000)
  await key('Escape')
  await expect.poll(async () => (await state()).drag).toBeNull()
  await drop()
  await expect.poll(async () => (await state()).drag).toBeNull()
  expect((await state()).tree).toEqual(rearranged)
  expect(workspaces()).toHaveLength(1)
  await startDrag(chrome, `[data-pane="${first}"] .pane-select`)
  const bar = (await chrome.locator('.window-drag').boundingBox())!
  await cursor(origin.x + bar.x + bar.width / 2, origin.y + 18)
  await drop()
  await expect.poll(async () => (await state()).tabs.length).toBe(2)
  expect((await state()).tabs.find(tab => tab.panes.length === 1)?.panes).toEqual([first])
  expect((await nativePanes()).map(pane => pane.id).sort()).toEqual(initial.panes.map(pane => pane.id).sort())
})

test('cross-window pane drops, detach-to-window and whole-window merge preserve terminal identity and discard empty windows', async () => {
  await splitThree()
  const original = await state(),
    moving = original.panes[0].id
  await menu('File', 'New window')
  await expect.poll(() => workspaces().length).toBe(2)
  const destination = workspaces().find(page => page !== chrome)!
  await position(destination, 1050, 40)
  await expect.poll(async () => (await state(destination)).panes[0]?.connection).toBe('connected')
  const target = (await state(destination)).activePaneId!,
    targetBounds = (await nativePanes(destination)).find(pane => pane.id === target)!.bounds
  const targetOrigin = await bounds(destination)
  await startDrag(chrome, `[data-pane="${moving}"] .pane-select`)
  await cursor(targetOrigin.x + targetBounds.x + 25, targetOrigin.y + targetBounds.y + targetBounds.height / 2)
  await drop()
  await expect.poll(async () => (await state(destination)).panes.map(pane => pane.id)).toContain(moving)
  expect((await state()).panes.map(pane => pane.id)).not.toContain(moving)
  expect((await state(destination)).tabs).toHaveLength(1)
  await startDrag(destination, `[data-pane="${moving}"] .pane-select`)
  await cursor(2200, 1000)
  await drop()
  await expect.poll(() => workspaces().length).toBe(3)
  const detached = workspaces().find(page => page !== chrome && page !== destination)!
  await expect.poll(async () => (await state(detached)).panes.map(pane => pane.id)).toEqual([moving])
  const newOrigin = await bounds(destination),
    remaining = (await nativePanes(destination)).find(pane => pane.id === target)!.bounds
  await startDrag(detached, '.tab-select')
  await cursor(newOrigin.x + remaining.x + remaining.width / 2, newOrigin.y + remaining.y + remaining.height - 25)
  await drop()
  await expect.poll(() => workspaces().length).toBe(2)
  expect((await state(destination)).panes.map(pane => pane.id)).toContain(moving)
  expect((await nativePanes(destination)).map(pane => pane.id)).toContain(moving)
  expect((await state(destination)).tree?.kind).toBe('split')
})

test('tab-bar hover previews cancel cleanly, then commit without reloading the terminal or losing a draft', async () => {
  await splitThree()
  const moving = (await state()).panes[0].id,
    page = await terminal(moving)
  await chrome.locator(`[data-pane="${moving}"] .pane-select`).click()
  await showTerminalToolbar(page)
  await page.getByRole('button', { name: 'Message box', exact: true }).click()
  const draft = page.getByRole('textbox', { name: 'Message to the session', exact: true })
  await draft.fill('preserve this unsent prompt across moves')
  await expect.poll(async () => (await state()).panes.find(pane => pane.id === moving)?.hasDraft).toBe(true)
  const before = (await state()).tree
  await menu('File', 'New window')
  await expect.poll(() => workspaces().length).toBe(2)
  const destination = workspaces().find(page => page !== chrome)!
  await position(destination, 1050, 40)
  await expect(destination.locator('.tab')).toHaveCount(1)
  const origin = await bounds(destination),
    bar = (await destination.locator('.window-drag').boundingBox())!
  await startDrag(chrome, `[data-pane="${moving}"] .pane-select`)
  await cursor(origin.x + bar.x + bar.width / 2, origin.y + 18)
  await expect.poll(async () => (await state(destination)).panes.map(pane => pane.id)).toContain(moving)
  await key('Escape')
  await expect.poll(async () => (await state()).drag).toBeNull()
  await drop()
  await expect.poll(async () => (await state()).tree).toEqual(before)
  expect((await state(destination)).panes.map(pane => pane.id)).not.toContain(moving)
  await startDrag(chrome, `[data-pane="${moving}"] .pane-select`)
  await cursor(origin.x + bar.x + bar.width / 2, origin.y + 18)
  await expect.poll(async () => (await state(destination)).panes.map(pane => pane.id)).toContain(moving)
  await drop()
  await expect.poll(async () => (await state(destination)).drag).toBeNull()
  expect((await state()).panes.map(pane => pane.id)).not.toContain(moving)
  await expect(draft).toHaveValue('preserve this unsent prompt across moves')
  expect((await state(destination)).panes.find(pane => pane.id === moving)?.hasDraft).toBe(true)
  expect((await nativePanes(destination)).map(pane => pane.id)).toContain(moving)
})

test('native divider resizing reaches the PTY and pane closing requires confirmation without ending siblings', async () => {
  await splitThree()
  const current = await state(),
    active = current.activePaneId!,
    sibling = current.panes[0].id,
    page = await terminal(active)
  const capture = join(directory, 'sizes.jsonl'),
    script = join(directory, 'sizes.py')
  await writeFile(
    script,
    `import json, os, signal, sys
def record(*args):
    size = os.get_terminal_size()
    with open(sys.argv[1], 'a') as stream:
        stream.write(json.dumps(dict(pid=os.getpid(), cols=size.columns, rows=size.lines)) + '\\n')
signal.signal(signal.SIGWINCH, record)
record()
while True: signal.pause()
`,
  )
  const input = page.getByRole('textbox', { name: 'Terminal input' })
  await input.pressSequentially(`exec python3 '${script}' '${capture}'`)
  await input.press('Enter')
  const sizes = async (): Promise<{ pid: number; cols: number; rows: number }[]> =>
    (await readFile(capture, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
  await expect.poll(async () => (await sizes()).length).toBeGreaterThan(0)
  const initial = (await sizes()).at(-1)!,
    before = await nativePanes(),
    origin = await bounds(),
    divider = (await chrome.locator('.pane-divider.row-split').boundingBox())!
  await cursor(origin.x + divider.x + divider.width / 2, origin.y + divider.y + divider.height / 2)
  await execute('xdotool', ['mousedown', '1'])
  await cursor(origin.x + divider.x + divider.width / 2, origin.y + divider.y + 65)
  await drop()
  await expect.poll(async () => (await sizes()).at(-1)?.rows).toBeLessThan(initial.rows)
  expect((await sizes()).every(size => size.pid === initial.pid && size.cols === initial.cols)).toBe(true)
  expect((await nativePanes()).find(pane => pane.id === sibling)).toEqual(before.find(pane => pane.id === sibling))

  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  })
  await chrome.locator(`[data-pane="${active}"] .pane-close`).click()
  expect((await state()).panes.map(pane => pane.id)).toContain(active)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  await chrome.locator(`[data-pane="${active}"] .pane-close`).click()
  await expect.poll(async () => (await state()).panes.length).toBe(2)
  expect((await state()).panes.every(pane => pane.connection === 'connected')).toBe(true)
  expect((await nativePanes()).find(pane => pane.id === sibling)).toEqual(before.find(pane => pane.id === sibling))
})

test('close shortcut removes only the focused pane, then its empty tab/window, and respects cancellation', async () => {
  await splitThree()
  const group = (await state()).activeTabId!
  await chrome.evaluate(() => window.outpostWorkspace.newLocal())
  await expect.poll(async () => (await state()).panes.length).toBe(4)
  const remaining = (await state()).activePaneId!
  await chrome.evaluate(group => window.outpostWorkspace.activateTab(group), group)
  const before = await state()
  const confirmations = await app.evaluateHandle(({ dialog }) => {
    const calls: number[] = []
    dialog.showMessageBox = async () => {
      calls.push(1)
      return { response: 1, checkboxChecked: false }
    }
    return calls
  })
  await key('ctrl+shift+w')
  await expect.poll(() => confirmations.evaluate(calls => calls.length)).toBe(1)
  expect((await state()).tree).toEqual(before.tree)
  expect((await state()).panes.map(pane => pane.id)).toEqual(before.panes.map(pane => pane.id))
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
  for (let count = 3; count >= 1; count--) {
    const closing = (await state()).activePaneId!
    await key('ctrl+shift+w')
    await expect.poll(async () => (await state()).panes.length).toBe(count)
    expect((await state()).panes.map(pane => pane.id)).not.toContain(closing)
    expect((await state()).panes.map(pane => pane.id)).toContain(remaining)
    expect((await state()).tabs).toHaveLength(count === 1 ? 1 : 2)
    expect(workspaces()).toHaveLength(1)
  }
  await menu('File', 'New window')
  await expect.poll(() => workspaces().length).toBe(2)
  const other = workspaces().find(page => page !== chrome)!
  await expect.poll(async () => (await state(other)).panes[0]?.connection).toBe('connected')
  await position(chrome, 30, 40)
  await key('ctrl+shift+w')
  await expect.poll(() => workspaces().length).toBe(1)
  expect(workspaces()[0]).toBe(other)
  expect((await state(other)).panes[0].connection).toBe('connected')
})

test('workspace pages keep remembered selection without targeting hidden panes with shortcuts', async () => {
  await splitThree()
  const before = await state()
  await chrome.locator('#home').click()
  const confirmations = await app.evaluateHandle(({ dialog }) => {
    const calls: number[] = []
    dialog.showMessageBox = async () => {
      calls.push(1)
      return { response: 0, checkboxChecked: false }
    }
    return calls
  })
  for (const shortcut of ['ctrl+shift+w', 'ctrl+shift+d', 'ctrl+alt+d', 'ctrl+shift+Return', 'ctrl+alt+Right'])
    await key(shortcut)
  await menu('File', 'Close current tab')
  const after = await state()
  expect(after.panel).toBe('sessions')
  expect(after.tree).toEqual(before.tree)
  expect(after.activePaneId).toBe(before.activePaneId)
  expect(after.activeTabId).toBe(before.activeTabId)
  expect(after.panes.map(pane => pane.id)).toEqual(before.panes.map(pane => pane.id))
  expect(await confirmations.evaluate(calls => calls.length)).toBe(0)
  await expect(chrome.locator('#split')).toBeDisabled()
  await chrome.locator('.tab-select').click()
  await key('ctrl+shift+w')
  await expect.poll(async () => (await state()).panes.length).toBe(2)
  expect(await confirmations.evaluate(calls => calls.length)).toBe(1)
})

test('closing a tab disposes exactly its panes and keeps other tabs and native views alive', async () => {
  await splitThree()
  const closing = await state()
  await chrome.evaluate(() => window.outpostWorkspace.newLocal())
  await expect.poll(async () => (await state()).panes.length).toBe(4)
  const survivor = (await state()).activePaneId!
  await chrome.evaluate(id => window.outpostWorkspace.closeTab(id), closing.activeTabId!)
  await expect.poll(async () => (await state()).panes.map(pane => pane.id)).toEqual([survivor])
  expect((await state()).tabs).toHaveLength(1)
  expect((await nativePanes()).map(pane => pane.id)).toEqual([survivor])
  expect(workspaces()).toHaveLength(1)
  expect(
    await app.evaluate(
      ({ webContents }, ids) => ids.every(id => !webContents.fromId(id)),
      closing.panes.map(pane => pane.id),
    ),
  ).toBe(true)
})

test('window confirmation applies to captured panes and leaves newly arriving sessions open', async () => {
  await splitThree()
  const before = await state()
  const confirmation = await app.evaluateHandle(({ dialog }) => {
    const pending = { calls: 0, accept: () => {} }
    dialog.showMessageBox = () =>
      new Promise(resolve => {
        pending.calls++
        pending.accept = () => resolve({ response: 0, checkboxChecked: false })
      })
    return pending
  })
  const nativeWindow = await app.browserWindow(chrome)
  await nativeWindow.evaluate(window => window.close())
  await expect.poll(() => confirmation.evaluate(pending => pending.calls)).toBe(1)
  // A protocol launch may arrive while the native confirmation is pending.
  await chrome.evaluate(() => window.outpostWorkspace.newLocal())
  await expect.poll(async () => (await state()).panes.length).toBe(4)
  const arrival = (await state()).activePaneId!
  await nativeWindow.evaluate(window => window.close())
  expect(await confirmation.evaluate(pending => pending.calls)).toBe(1)
  await confirmation.evaluate(pending => pending.accept())
  await expect.poll(async () => (await state()).panes.map(pane => pane.id)).toEqual([arrival])
  await expect.poll(async () => (await state()).panes[0].connection).toBe('connected')
  expect(workspaces()).toHaveLength(1)
  expect(
    await app.evaluate(
      ({ webContents }, ids) => ids.every(id => !webContents.fromId(id)),
      before.panes.map(pane => pane.id),
    ),
  ).toBe(true)
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false })
  })
})
