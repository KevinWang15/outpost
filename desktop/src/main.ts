import { app, dialog, Menu, powerMonitor, type MenuItemConstructorOptions } from 'electron'
import { join, resolve } from 'node:path'
import { parseLaunch } from './launch'
import { Preferences } from './preferences'
import { TrustedServers } from './store'
import { DesktopWorkspace } from './workspace'
import { checkUpdates } from './updates'
import { tabActionShortcuts } from './tab-shortcuts'
import { RecentSessions } from './recent-sessions'
import { clearScreenShortcut } from '../../shared/terminalShortcuts'

app.setName('Outpost')
app.setAppUserModelId('dev.outpost.desktop')
const trusted = new TrustedServers(join(app.getPath('userData'), 'servers.json'))
const preferences = new Preferences(join(app.getPath('userData'), 'preferences.json'))
const recentSessions = new RecentSessions(join(app.getPath('userData'), 'recent-sessions.json'))
let workspace: DesktopWorkspace | undefined
const resumeTerminals = () => workspace?.resume()
const waiting: string[] = []
let operations = Promise.resolve()
let pending = 0
const report = (message: string) =>
  dialog.showMessageBox({
    type: 'error',
    title: 'Outpost',
    message,
    detail: 'Check the server address and use Connect → Outpost Desktop again.',
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
  if (!workspace) {
    if (waiting.length < 16) waiting.push(value)
    return
  }
  if (pending >= 16) return
  pending++
  operations = operations
    .then(async () => {
      const launch = parseLaunch(value)
      if (await trust(launch.server)) await workspace!.open(launch)
      else workspace!.show()
    })
    .catch(async error => {
      workspace!.show()
      await report(error instanceof Error ? error.message : 'Could not open the session.')
    })
    .finally(() => {
      pending--
    })
}
function menus() {
  const mac = process.platform === 'darwin'
  const tabShortcuts = tabActionShortcuts(process.platform)
  const clearShortcut = clearScreenShortcut(mac)
  const shortcut = (key: string) => (mac ? 'Cmd+' : 'Ctrl+Shift+') + key
  const increaseFontSize = () => workspace!.forAction().fontSize(1)
  const newLocal = (profile?: string) => {
    try {
      workspace!.newLocal(profile)
    } catch (error) {
      dialog.showErrorBox('Could not open terminal', (error as Error).message)
    }
  }
  const template: MenuItemConstructorOptions[] = [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New window', accelerator: 'CmdOrCtrl+Shift+N', click: () => workspace!.newWindow() },
        { label: tabShortcuts.newTab.label, accelerator: tabShortcuts.newTab.accelerator, click: () => newLocal() },
        {
          label: 'New terminal with profile',
          submenu: workspace!.shells.map(profile => ({ label: profile.name, click: () => newLocal(profile.id) })),
        },
        { label: 'Servers and sessions…', click: () => workspace!.forAction().panel('sessions') },
        { label: 'Switch session…', accelerator: shortcut('P'), click: () => workspace!.forAction().panel('switcher') },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => workspace!.forAction().panel('settings') },
        { type: 'separator' },
        {
          label: tabShortcuts.closeTab.label,
          accelerator: tabShortcuts.closeTab.accelerator,
          click: () => {
            void workspace!.forAction().close()
          },
        },
        { role: 'close', label: 'Close window', accelerator: mac ? 'Cmd+Shift+W' : 'Alt+F4' },
        ...(!mac ? [{ role: 'quit' as const }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Copy', accelerator: shortcut('C'), click: () => workspace!.forAction().edit('copy') },
        { label: 'Paste', accelerator: shortcut('V'), click: () => workspace!.forAction().edit('paste') },
        { label: 'Select all', accelerator: shortcut('A'), click: () => workspace!.forAction().command('select-all') },
        { type: 'separator' },
        { label: 'Find in terminal…', accelerator: 'CmdOrCtrl+F', click: () => workspace!.forAction().command('find') },
        {
          label: clearShortcut.label,
          accelerator: clearShortcut.accelerator,
          click: () => workspace!.forAction().command('clear'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Split side by side',
          accelerator: shortcut('D'),
          click: () => workspace!.forAction().split('columns'),
        },
        { label: 'Split top and bottom', click: () => workspace!.forAction().split('rows') },
        { label: 'Single pane', click: () => workspace!.forAction().split(null) },
        {
          label: 'Focus other pane',
          accelerator: 'CmdOrCtrl+Alt+Right',
          click: () => workspace!.forAction().otherPane(),
        },
        { type: 'separator' },
        {
          label: 'Larger terminal text',
          accelerator: 'CmdOrCtrl+Plus',
          click: increaseFontSize,
        },
        {
          // Accept the unshifted = key without adding a duplicate menu entry.
          label: 'Larger terminal text',
          accelerator: 'CmdOrCtrl+=',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: increaseFontSize,
        },
        {
          label: 'Smaller terminal text',
          accelerator: 'CmdOrCtrl+-',
          click: () => workspace!.forAction().fontSize(-1),
        },
        {
          label: 'Reset terminal text size',
          accelerator: 'CmdOrCtrl+0',
          click: () => workspace!.forAction().fontSize(null),
        },
        { type: 'separator' },
        { label: 'Reconnect terminal', click: () => workspace!.forAction().command('reconnect') },
        {
          label: 'Reload terminal',
          accelerator: shortcut('R'),
          click: () => {
            void workspace!.forAction().reload()
          },
        },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: () => workspace!.forAction().cycle(1) },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: () => workspace!.forAction().cycle(-1) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, index) => ({
          label: index === 8 ? 'Last tab' : `Tab ${index + 1}`,
          accelerator: `${mac ? 'Cmd' : 'Alt'}+${index + 1}`,
          click: () => workspace!.forAction().select(index),
        })),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Outpost guide and shortcuts', click: () => workspace!.forAction().panel('sessions') },
        { type: 'separator' },
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

app.on('open-url', (event, url) => {
  event.preventDefault()
  receive(url)
})
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_event, argv) => {
    const urls = argv.filter(argument => argument.startsWith('outpost:'))
    if (urls.length) for (const url of urls.slice(0, 16)) receive(url)
    else workspace?.show()
  })
  for (const argument of process.argv) if (argument.startsWith('outpost:')) receive(argument)
  void app
    .whenReady()
    .then(async () => {
      await Promise.all([trusted.load(), preferences.load(), recentSessions.load()])
      await recentSessions.retainServers(origin => trusted.has(origin))
      workspace = new DesktopWorkspace(__dirname, trusted, preferences, recentSessions, trust)
      powerMonitor.on('resume', resumeTerminals)
      powerMonitor.on('unlock-screen', resumeTerminals)
      app.setAboutPanelOptions({
        applicationName: 'Outpost',
        applicationVersion: app.getVersion(),
        copyright: 'Outpost contributors',
        iconPath: join(__dirname, 'outpost.png'),
      })
      if (app.isPackaged) app.setAsDefaultProtocolClient('outpost')
      else if (process.platform === 'win32' && process.argv[1])
        app.setAsDefaultProtocolClient('outpost', process.execPath, [resolve(process.argv[1])])
      menus()
      if (waiting.length) workspace.forAction().show()
      else workspace.show()
      for (const url of waiting.splice(0)) receive(url)
      app.on('activate', () => workspace!.show())
    })
    .catch(async error => {
      await report(error instanceof Error ? error.message : 'Could not start Outpost.')
      app.quit()
    })
  app.on('before-quit', event => {
    if (workspace && !workspace.quitting) {
      event.preventDefault()
      void workspace.quit()
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && pending === 0) app.quit()
  })
  app.on('will-quit', () => {
    powerMonitor.removeListener('resume', resumeTerminals)
    powerMonitor.removeListener('unlock-screen', resumeTerminals)
    workspace?.dispose()
  })
}
