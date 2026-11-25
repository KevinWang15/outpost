import { useState, type ReactNode } from 'react'
import { ArrowLeft, BookOpen, LogOut, MessagesSquare, Monitor, ScrollText, Settings2, UserRound } from 'lucide-react'
import { pagePaths } from '../../shared/pages'
import AccountDialog from '../auth/AccountDialog'
import { useAuth } from '../auth/useAuth'
import ConnectionPreferences from '../connect/ConnectionPreferences'
import { useDesktopEntry } from '../desktop/useDesktopEntry'
import { Menu } from './Menu'
import { useToast } from './toast-context'

type SidebarPage = 'machines' | 'chat' | 'logs' | 'guide'

export function AppSidebar({ page, children }: { page: SidebarPage; children: ReactNode }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <a className="brand" href={pagePaths.workspace}>
          <img src="/outpost.svg" width="26" height="26" alt="" />
          <span>Outpost</span>
          <DeploymentBadge />
        </a>
        {page !== 'machines' && (
          <a className="sidebar-link" href={pagePaths.workspace}>
            <ArrowLeft size={15} /> Back to machines
          </a>
        )}
      </div>
      <div className="sidebar-body">{children}</div>
      <SidebarFooter page={page} />
    </aside>
  )
}

function DeploymentBadge() {
  const { mode } = useAuth()
  return <span className="mode">{mode === 'hosted' ? 'Hosted' : 'Local'}</span>
}

function SidebarFooter({ page }: { page: SidebarPage }) {
  const { mode, user, signOut } = useAuth()
  const toast = useToast()
  const openDesktop = useDesktopEntry()
  const [account, setAccount] = useState(false),
    [preferences, setPreferences] = useState(false)
  return (
    <div className="sidebar-footer">
      <nav className="workspace-tools" aria-label="Workspace tools">
        <a className="sidebar-link" href={pagePaths.chat} aria-current={page === 'chat' ? 'page' : undefined}>
          <MessagesSquare size={16} /> Chat
        </a>
        <a className="sidebar-link" href={pagePaths.logs} aria-current={page === 'logs' ? 'page' : undefined}>
          <ScrollText size={16} /> Logs and webhooks
        </a>
        <a className="sidebar-link" href={pagePaths.guide} aria-current={page === 'guide' ? 'page' : undefined}>
          <BookOpen size={16} /> User guide
        </a>
      </nav>
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
        <p className="muted">Local Outpost server. Sessions keep running on your machines.</p>
      )}
      {account && <AccountDialog onClose={() => setAccount(false)} />}
      {preferences && <ConnectionPreferences onClose={() => setPreferences(false)} />}
    </div>
  )
}
