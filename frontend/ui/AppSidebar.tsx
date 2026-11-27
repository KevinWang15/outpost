import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  BookOpen,
  Compass,
  LogOut,
  MessagesSquare,
  Monitor,
  ScrollText,
  Settings2,
  UserRound,
} from 'lucide-react'
import { pagePaths } from '../../shared/pages'
import AccountDialog from '../auth/AccountDialog'
import { useAuth } from '../auth/useAuth'
import ConnectionPreferences from '../connect/ConnectionPreferences'
import { useDesktopEntry } from '../desktop/useDesktopEntry'
import type { RouteLocation } from '../router'
import { Link } from './Link'
import { Menu } from './Menu'
import { useToast } from './toast-context'

export type SidebarPage = 'machines' | 'chat' | 'logs' | 'onboarding' | 'guide'

const SidebarSlotContext = createContext<HTMLDivElement | null>(null)

function workspaceShellClass(page: SidebarPage, search: string): string {
  if (page === 'chat') {
    const query = new URLSearchParams(search)
    const hasSelection = Boolean(query.get('channel') || (query.get('target') && query.get('session')))
    return hasSelection ? 'chat-app has-selection' : 'chat-app'
  }
  if (page === 'logs') return 'app logs-app'
  if (page === 'onboarding') return 'app onboarding-app'
  if (page === 'guide') return 'app guide-app'
  return 'app'
}

/** Persistent workspace chrome shared across Machines, Chat, Logs, and User Guide.
 * Keeps the sidebar, brand logo, and footer continuously mounted across route changes
 * so navigation never flashes or re-decodes shared chrome. */
export function WorkspaceShell({
  page,
  location,
  children,
}: {
  page: SidebarPage
  location: RouteLocation
  children: ReactNode
}) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [page])

  return (
    <div className={workspaceShellClass(page, location.search)}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link className="brand" href={pagePaths.workspace}>
            <img src="/outpost.svg" width="26" height="26" alt="" decoding="sync" />
            <span>Outpost</span>
            <DeploymentBadge />
          </Link>
          {page !== 'machines' && (
            <Link className="sidebar-link" href={pagePaths.workspace}>
              <ArrowLeft size={15} /> Back to machines
            </Link>
          )}
        </div>
        <div className="sidebar-body" ref={setSlot} />
        <SidebarFooter page={page} />
      </aside>
      <SidebarSlotContext.Provider value={slot}>{children}</SidebarSlotContext.Provider>
    </div>
  )
}

/** Portals page-specific navigation into the persistent workspace sidebar body. */
export function SidebarBody({ children }: { children: ReactNode }) {
  const slot = useContext(SidebarSlotContext)
  if (!slot) return null
  return createPortal(children, slot)
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
        <Link className="sidebar-link" href={pagePaths.chat} aria-current={page === 'chat' ? 'page' : undefined}>
          <MessagesSquare size={16} /> Chat
        </Link>
        <Link className="sidebar-link" href={pagePaths.logs} aria-current={page === 'logs' ? 'page' : undefined}>
          <ScrollText size={16} /> Logs and webhooks
        </Link>
        <Link
          className="sidebar-link"
          href={pagePaths.onboarding}
          aria-current={page === 'onboarding' ? 'page' : undefined}
        >
          <Compass size={16} /> Getting started
        </Link>
        <Link className="sidebar-link" href={pagePaths.guide} aria-current={page === 'guide' ? 'page' : undefined}>
          <BookOpen size={16} /> User guide
        </Link>
      </nav>
      <button
        type="button"
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
      <button type="button" className="sidebar-link" onClick={() => setPreferences(true)}>
        <Settings2 size={16} />
        Connection preferences
      </button>
      {mode === 'hosted' && user ? (
        <Menu
          label="Account"
          trigger={
            <button type="button" className="account-button" aria-label="Account">
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
