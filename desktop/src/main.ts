import { app, dialog, Menu, powerMonitor, shell, type MenuItemConstructorOptions } from 'electron'
import { join, resolve } from 'node:path'
import { parseDesktopEntry } from '../../shared/desktopAuth'
import { Preferences } from './preferences'
import { ServerTrust } from './server-trust'
import { DesktopWorkspace } from './workspace'
import { checkUpdates } from './updates'
import { paneActionShortcuts, tabActionShortcuts, type PaneAction } from './workspace-shortcuts'
import { RecentSessions } from './recent-sessions'
import { ServerAccounts } from './server-accounts'
import { clearScreenShortcut } from '../../shared/terminalShortcuts'

app.setName('Outpost')
app.setAppUserModelId('dev.outpost.desktop')
const serverTrust = new ServerTrust(join(app.getPath('userData'), 'server-trust.json'), confirmTrust)
const preferences = new Preferences(join(app.getPath('userData'), 'preferences.json'))
const recentSessions = new RecentSessions(join(app.getPath('userData'), 'recent-sessions.json'))
let workspace: DesktopWorkspace | undefined
const accounts = new ServerAccounts(join(app.getPath('userData'), 'server-logins.json'), serverTrust, {
  openBrowser: url => shell.openExternal(url),
  changed: () => workspace?.accountsChanged(),
  failed: error => {
    void report(error.message)
  },
})
const resumeTerminals = () => workspace?.resume()
const waiting: string[] = []
let pending = 0
const report = (message: string) =>
  dialog.showMessageBox({
    type: 'error',
    title: 'Outpost',
    message,
    detail: 'Check the server address and try again from the Outpost tab or your server workspace.',
    buttons: ['OK'],
  })

async function confirmTrust(origin: string) {
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
  return result.response === 0
}
function receive(value: string) {
  if (workspace?.stopping) return
  if (!workspace) {
    if (waiting.length < 16) waiting.push(value)
    return
  }
  if (pending >= 16) return
  pending++
  void Promise.resolve()
    .then(async () => {
      if (workspace!.stopping) return
      if (value.startsWith('outpost://login/')) {
        const sessions = await accounts.complete(value)
        if (workspace!.stopping) return
        workspace!.present()
        if (sessions?.length) {
          for (const session of sessions) {
            if (workspace!.stopping) return
            try {
              await workspace!.open(await accounts.launch(session))
            } catch (error) {
              if (workspace!.stopping) return
              await report(error instanceof Error ? error.message : 'Could not open the session.')
            }
          }
        } else workspace!.forAction()?.panel('sessions')
        return
      }
      const launch = await accounts.connect(parseDesktopEntry(value))
      if (workspace!.stopping) return
      workspace!.present()
      if (launch) await workspace!.open(launch)
      else workspace!.forAction()?.panel('sessions')
    })
    .catch(async error => {
      if (workspace!.stopping) return
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
  const paneShortcuts = paneActionShortcuts(process.platform)
  const clearShortcut = clearScreenShortcut(mac)
  const shortcut = (key: string) => (mac ? 'Cmd+' : 'Ctrl+Shift+') + key
  const increaseFontSize = () => workspace!.forAction()?.fontSize(1)
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
        { label: 'Servers and sessions…', click: () => workspace!.forAction()?.panel('sessions') },
        {
          label: 'Switch session…',
          accelerator: shortcut('P'),
          click: () => workspace!.forAction()?.panel('switcher'),
        },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => workspace!.forAction()?.panel('settings') },
        { type: 'separator' },
        {
          label: paneShortcuts.close.label,
          accelerator: paneShortcuts.close.accelerator,
          click: () => workspace!.forAction()?.paneAction('close'),
        },
        {
          label: 'Close current tab',
          click: () => {
            void workspace!.forAction()?.closeTab()
          },
        },
        { role: 'close', label: 'Close window', accelerator: mac ? 'Cmd+Shift+W' : 'Alt+F4' },
        ...(!mac ? [{ role: 'quit' as const }] : []),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Copy', accelerator: shortcut('C'), click: () => workspace!.edit('copy') },
        { label: 'Paste', accelerator: shortcut('V'), click: () => workspace!.edit('paste') },
        { label: 'Select all', accelerator: shortcut('A'), click: () => workspace!.edit('select-all') },
        { type: 'separator' },
        {
          label: 'Find in terminal…',
          accelerator: 'CmdOrCtrl+F',
          click: () => workspace!.forAction()?.command('find'),
        },
        {
          label: clearShortcut.label,
          accelerator: clearShortcut.accelerator,
          click: () => workspace!.forAction()?.command('clear'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(Object.keys(paneShortcuts) as PaneAction[])
          .filter(action => action !== 'close')
          .map(action => ({
            label: paneShortcuts[action].label,
            accelerator: paneShortcuts[action].accelerator,
            click: () => workspace!.forAction()?.paneAction(action),
          })),
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
          click: () => workspace!.forAction()?.fontSize(-1),
        },
        {
          label: 'Reset terminal text size',
          accelerator: 'CmdOrCtrl+0',
          click: () => workspace!.forAction()?.fontSize(null),
        },
        { type: 'separator' },
        { label: 'Reconnect terminal', click: () => workspace!.forAction()?.command('reconnect') },
        {
          label: 'Reload terminal',
          accelerator: shortcut('R'),
          click: () => {
            void workspace!.forAction()?.reloadPane()
          },
        },
        { role: 'togglefullscreen' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
      ],
    },
    {
      label: 'Tabs',
      submenu: [
        { label: 'Next tab', accelerator: 'Ctrl+Tab', click: () => workspace!.forAction()?.cycle(1) },
        { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: () => workspace!.forAction()?.cycle(-1) },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, index) => ({
          label: index === 8 ? 'Last tab' : `Tab ${index + 1}`,
          accelerator: `${mac ? 'Cmd' : 'Alt'}+${index + 1}`,
          click: () => workspace!.forAction()?.select(index),
        })),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Outpost guide and shortcuts', click: () => workspace!.forAction()?.panel('sessions') },
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
      await Promise.all([serverTrust.load(), preferences.load(), recentSessions.load()])
      await accounts.load()
      await recentSessions.retain(entry => accounts.hasAccount(entry.server, entry.accountId))
      workspace = new DesktopWorkspace(__dirname, preferences, recentSessions, accounts)
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
      if (waiting.length) workspace.present()
      else workspace.show()
      for (const url of waiting.splice(0)) receive(url)
      void accounts.refresh()
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
