import { useState } from 'react'
import { Monitor, Pencil, Plus, Search, Server, Trash2 } from 'lucide-react'
import type { ConversationMatch, Session, SessionInput, Target, TargetUpdate } from '../../shared/model'
import { harnessLabel } from '../../shared/harnesses'
import { api } from '../api'
import ConnectDialog from '../connect/ConnectDialog'
import { Confirm } from '../ui/Dialog'
import { Menu } from '../ui/Menu'
import { useToast } from '../ui/toast-context'
import FinderDialog from './FinderDialog'
import ImageDialog from './ImageDialog'
import SessionDialog from './SessionDialog'
import SessionTable from './SessionTable'
import SoftwarePanel from './SoftwarePanel'
import TargetDialog from './TargetDialog'
import { useSessions } from './useSessions'
import { useSoftware } from './useSoftware'
import { address } from './labels'

type Panel =
  | { kind: 'session'; conversation: ConversationMatch | null }
  | { kind: 'finder' }
  | { kind: 'connect'; session: Session }
  | { kind: 'image'; session: Session }
  | { kind: 'edit' }
  | { kind: 'remove' }
  | { kind: 'terminate' | 'delete'; session: Session }

export default function TargetView({
  target,
  onUpdated,
  onRemoved,
  onWebTerminal,
}: {
  target: Target
  onUpdated: (target: Target) => void
  onRemoved: (target: Target) => void
  onWebTerminal: (token: string, title: string) => void
}) {
  const toast = useToast()
  const { sessions, error, refreshing, refresh } = useSessions(target.id)
  const software = useSoftware(target.id, target.tools.join(','))
  const [panel, setPanel] = useState<Panel | null>(null)
  const [checking, setChecking] = useState<string[]>([])
  const installed = new Set(software.report?.software.filter(item => item.status === 'installed').map(item => item.id))
  const tools = target.tools.filter(tool => installed.has(tool))
  const ready = ['bash', 'python3', 'tmux'].every(id => installed.has(id as never)) && tools.length > 0
  const close = () => setPanel(null)

  async function check(session: Session) {
    if (!session.activity.completionId) return
    setChecking(current => [...current, session.id])
    try {
      await api(`/targets/${target.id}/sessions/${session.id}/acknowledge`, 'POST', {
        completionId: session.activity.completionId,
      })
      await refresh()
    } catch (problem) {
      toast((problem as Error).message, 'error')
    } finally {
      setChecking(current => current.filter(id => id !== session.id))
    }
  }
  const TargetIcon = target.kind === 'ssh' ? Server : Monitor

  return (
    <div className="target-view">
      <header className="page-header">
        <div className="page-title">
          <span className="page-icon">
            <TargetIcon size={20} />
          </span>
          <div>
            <h1>{target.name}</h1>
            <p>
              <code>{address(target)}</code>
              {target.tools.map(tool => (
                <span key={tool} className="chip">
                  {harnessLabel(tool)}
                </span>
              ))}
            </p>
          </div>
        </div>
        <div className="page-actions">
          <button className="button" onClick={() => setPanel({ kind: 'finder' })}>
            <Search size={15} />
            Find conversation
          </button>
          <button
            className="button primary"
            disabled={!ready}
            title={ready ? undefined : 'Install the required software first'}
            onClick={() => setPanel({ kind: 'session', conversation: null })}
          >
            <Plus size={15} />
            New session
          </button>
          <Menu
            label={`Actions for ${target.name}`}
            items={[
              { label: 'Edit target', icon: <Pencil size={14} />, onSelect: () => setPanel({ kind: 'edit' }) },
              'separator',
              {
                label: 'Remove target',
                icon: <Trash2 size={14} />,
                danger: true,
                onSelect: () => setPanel({ kind: 'remove' }),
              },
            ]}
          />
        </div>
      </header>
      <SoftwarePanel targetId={target.id} state={software} onInstalled={() => void refresh()} />
      <SessionTable
        sessions={sessions}
        error={error}
        refreshing={refreshing}
        canCreate={ready}
        checking={checking}
        onRefresh={() => void refresh()}
        onCreate={() => setPanel({ kind: 'session', conversation: null })}
        onConnect={session => setPanel({ kind: 'connect', session })}
        onImage={session => setPanel({ kind: 'image', session })}
        onCheck={session => void check(session)}
        onTerminate={session => setPanel({ kind: 'terminate', session })}
        onDelete={session => setPanel({ kind: 'delete', session })}
      />

      {panel?.kind === 'session' && (
        <SessionDialog
          target={target}
          tools={tools}
          conversation={panel.conversation}
          onClose={close}
          onSave={async (input: SessionInput) => {
            const session = await api<Session>(`/targets/${target.id}/sessions`, 'POST', input)
            close()
            toast(`Created ${session.name}`)
            void refresh()
          }}
        />
      )}
      {panel?.kind === 'finder' && (
        <FinderDialog
          target={target}
          tools={tools}
          onClose={close}
          onLink={conversation => setPanel({ kind: 'session', conversation })}
          onConnect={session => setPanel({ kind: 'connect', session })}
        />
      )}
      {panel?.kind === 'connect' && (
        <ConnectDialog
          target={target}
          session={panel.session}
          onClose={() => {
            close()
            void refresh()
          }}
          onWeb={(token, title) => {
            close()
            onWebTerminal(token, title)
          }}
        />
      )}
      {panel?.kind === 'image' && <ImageDialog targetId={target.id} session={panel.session} onClose={close} />}
      {panel?.kind === 'edit' && (
        <TargetDialog
          target={target}
          onClose={close}
          onSave={async input => {
            onUpdated(await api<Target>(`/targets/${target.id}`, 'PATCH', input as TargetUpdate))
            close()
          }}
        />
      )}
      {panel?.kind === 'remove' && (
        <Confirm
          title={`Remove ${target.name}?`}
          action="Remove target"
          onClose={close}
          description="Outpost forgets this target. Sessions and coding tools keep running on it, and adding it again shows them."
          onConfirm={async () => {
            await api(`/targets/${target.id}`, 'DELETE')
            onRemoved(target)
          }}
        />
      )}
      {panel?.kind === 'terminate' && (
        <Confirm
          title={`Terminate ${panel.session.name}?`}
          action="Terminate"
          onClose={close}
          description="This stops the coding tool and its processes and disconnects open terminals. The conversation is kept; connecting again resumes it."
          onConfirm={async () => {
            await api(`/targets/${target.id}/sessions/${panel.session.id}/terminate`, 'POST')
            await refresh()
          }}
        />
      )}
      {panel?.kind === 'delete' && (
        <Confirm
          title={`Delete ${panel.session.name}?`}
          action="Delete"
          onClose={close}
          description="This removes the session from Outpost. The project directory and the coding tool’s history are kept."
          onConfirm={async () => {
            await api(`/targets/${target.id}/sessions/${panel.session.id}`, 'DELETE')
            await refresh()
          }}
        />
      )}
    </div>
  )
}
