import { useState, type ReactNode } from 'react'
import { LogOut, MessagesSquare, Monitor, Server, Settings2, UserRound } from 'lucide-react'
import { pagePaths } from '../../shared/pages'
import AccountDialog from '../auth/AccountDialog'
import { useAuth } from '../auth/useAuth'
import ConnectionPreferences from '../connect/ConnectionPreferences'
import { useDesktopEntry } from '../desktop/useDesktopEntry'
import { rememberMode, type AppMode } from '../mode'
import { Menu } from './Menu'
import { useToast } from './toast-context'

const modes = [
  { mode: 'chat', label: 'Chat', href: pagePaths.chat, Icon: MessagesSquare },
  { mode: 'machines', label: 'Machines', href: pagePaths.workspace, Icon: Server },
] as const

/** The sidebar both modes share: the brand and mode switch, the mode's own
 * content, and the account footer. Outpost Desktop's chat window is `embedded`:
 * it has no browser login and stays on chat. */
export function AppSidebar({
  mode,
  embedded = false,
  children,
}: {
  mode: AppMode
  embedded?: boolean
  children: ReactNode
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <a className="brand" href={modes.find(item => item.mode === mode)!.href}>
          <img src="/outpost.svg" width="26" height="26" alt="" />
          <span>Outpost</span>
          {!embedded && <DeploymentBadge />}
        </a>
        {!embedded && (
          <nav className="mode-switch" aria-label="Mode">
            {modes.map(({ mode: item, label, href, Icon }) => (
              <a
                key={item}
                href={href}
                aria-current={item === mode ? 'page' : undefined}
                onClick={() => rememberMode(item)}
              >
                <Icon size={14} /> {label}
              </a>
            ))}
          </nav>
        )}
      </div>
      <div className="sidebar-body">{children}</div>
      {!embedded && <SidebarFooter />}
    </aside>
  )
}

function DeploymentBadge() {
  const { mode } = useAuth()
  return <span className="mode">{mode === 'hosted' ? 'Hosted' : 'Local'}</span>
}

function SidebarFooter() {
  const { mode, user, signOut } = useAuth()
  const toast = useToast()
  const openDesktop = useDesktopEntry()
  const [account, setAccount] = useState(false),
    [preferences, setPreferences] = useState(false)
  return (
    <div className="sidebar-footer">
      <button
        className="sidebar-link desktop-entry"
        onClick={() => {
          try {
            openDesktop()
          } catch (error) {
            toast(error instanceof Error ? error.message : 'Could not open Outpost Desktop.', 'error')
          }
        }}
      >
        <Monitor size={16} />
        Open in Outpost Desktop
      </button>
      <button className="sidebar-link" onClick={() => setPreferences(true)}>
        <Settings2 size={16} />
        Connection preferences
      </button>
      {mode === 'hosted' && user ? (
        <Menu
          label="Account"
          trigger={
            <button className="account-button" aria-label="Account">
              <span className="avatar">{user.name.slice(0, 1).toUpperCase()}</span>
              <span>
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </span>
            </button>
          }
          items={[
            { label: 'Account settings', icon: <UserRound size={14} />, onSelect: () => setAccount(true) },
            {
              label: 'Sign out',
              icon: <LogOut size={14} />,
              onSelect: () => void signOut().catch(problem => toast((problem as Error).message, 'error')),
            },
          ]}
        />
      ) : (
        <p className="muted">Runs on this computer. Sessions keep running on your machines.</p>
      )}
      {account && <AccountDialog onClose={() => setAccount(false)} />}
      {preferences && <ConnectionPreferences onClose={() => setPreferences(false)} />}
    </div>
  )
}
