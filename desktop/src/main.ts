import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopOrigin } from '../../shared/desktop'
import { parseLaunch } from './launch'
import { TrustedServers } from './store'
import { TerminalWindows } from './terminals'
import { checkUpdates } from './updates'

app.setName('Outpost')
app.setAppUserModelId('dev.outpost.desktop')
const directory = __dirname
const homeUrl = pathToFileURL(join(directory, 'home.html')).href
const trusted = new TrustedServers(join(app.getPath('userData'), 'servers.json'))
let terminals: TerminalWindows
let home: BrowserWindow | null = null
let ready = false
const waiting: string[] = []
let operations = Promise.resolve()
let pending = 0
const report = () =>
  dialog.showMessageBox({
    type: 'error',
    title: 'Outpost',
    message: 'Could not open the session.',
    detail:
      'Check the server address and use Connect → Outpost Desktop again. The app accepts HTTPS servers and HTTP on localhost.',
    buttons: ['OK'],
  })

async function trust(origin: string) {
  if (trusted.has(origin)) return true
  const result = await dialog.showMessageBox({
    type: 'question',
    title: 'Trust Outpost server?',
    message: `Connect to ${origin}?`,
    detail:
      'This server supplies the terminal interface and can send terminal notifications, copy text, and open web links on your computer. Add only your own Outpost server.',
    buttons: ['Trust server', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  if (result.response !== 0) return false
  await trusted.set(origin, true)
  return true
}

function receive(value: string) {
  if (!ready) {
    if (waiting.length < 16) waiting.push(value)
    return
  }
  if (pending >= 16) return
  pending++
  operations = operations
    .then(async () => {
      const launch = parseLaunch(value)
      if (await trust(launch.server)) terminals.open(launch)
    })
    .catch(async () => {
      await report()
    })
    .finally(() => {
      pending--
      if (BrowserWindow.getAllWindows().length === 0) showHome()
    })
}

function showHome() {
  if (home && !home.isDestroyed()) {
    terminals.focus(home)
    return
  }
  home = new BrowserWindow({
    title: 'Outpost',
    width: 680,
    height: 640,
    minWidth: 480,
    minHeight: 400,
    backgroundColor: '#f7f9fc',
    icon: join(directory, 'outpost.png'),
    webPreferences: {
      preload: join(directory, 'home-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  home.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  home.webContents.on('will-navigate', event => event.preventDefault())
  home.on('closed', () => {
    home = null
  })
  void home.loadFile(join(directory, 'home.html')).catch(() => {})
}

function fromHome(event: IpcMainInvokeEvent) {
  if (
    !home ||
    event.sender !== home.webContents ||
    event.senderFrame !== event.sender.mainFrame ||
    event.senderFrame.url !== homeUrl
  )
    throw new Error('This action is only available in the Outpost app home.')
}

function menus() {
  const mac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Outpost…', accelerator: 'CmdOrCtrl+Shift+O', click: showHome },
        { type: 'separator' },
        { role: 'close', accelerator: mac ? 'Cmd+W' : 'Ctrl+Shift+W' },
        ...(!mac ? [{ role: 'quit' as const }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy', accelerator: mac ? 'Cmd+C' : 'Ctrl+Shift+C' },
        { role: 'paste', accelerator: mac ? 'Cmd+V' : 'Ctrl+Shift+V' },
        {
          label: 'Select all',
          accelerator: mac ? 'Cmd+A' : 'Ctrl+Shift+A',
          click: () => terminals.selectAll(BrowserWindow.getFocusedWindow()),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload', accelerator: mac ? 'Cmd+R' : 'Ctrl+Shift+R' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for updates…',
          click: () => {
            void checkUpdates()
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Register before ready: Launch Services can deliver a cold-start URL immediately.
app.on('open-url', (event, url) => {
  event.preventDefault()
  receive(url)
})
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_event, argv) => {
    const urls = argv.filter(argument => argument.startsWith('outpost:'))
    if (urls.length) for (const url of urls.slice(0, 16)) receive(url)
    else if (ready) showHome()
  })
  for (const argument of process.argv) if (argument.startsWith('outpost:')) receive(argument)
  void app
    .whenReady()
    .then(async () => {
      await trusted.load()
      terminals = new TerminalWindows(directory)
      app.setAboutPanelOptions({
        applicationName: 'Outpost',
        applicationVersion: app.getVersion(),
        copyright: 'Outpost contributors',
        iconPath: join(directory, 'outpost.png'),
      })
      if (app.isPackaged) app.setAsDefaultProtocolClient('outpost')
      else if (process.platform === 'win32' && process.argv[1])
        app.setAsDefaultProtocolClient('outpost', process.execPath, [resolve(process.argv[1])])
      ipcMain.handle('home:status', event => {
        fromHome(event)
        return { version: app.getVersion(), servers: trusted.list() }
      })
      ipcMain.handle('home:open-server', async (event, value: unknown) => {
        fromHome(event)
        if (typeof value !== 'string') throw new Error('Enter an Outpost server URL.')
        const origin = desktopOrigin(value)
        if (!(await trust(origin))) return false
        await shell.openExternal(origin)
        return true
      })
      ipcMain.handle('home:forget-server', async (event, value: unknown) => {
        fromHome(event)
        if (typeof value !== 'string') throw new Error('Invalid server.')
        const origin = desktopOrigin(value)
        terminals.forget(origin)
        await trusted.set(origin, false)
      })
      ipcMain.handle('home:updates', event => {
        fromHome(event)
        return checkUpdates()
      })
      menus()
      ready = true
      if (waiting.length) for (const url of waiting.splice(0)) receive(url)
      else showHome()
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) showHome()
      })
    })
    .catch(async () => {
      await report()
      app.quit()
    })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && pending === 0) app.quit()
  })
}
