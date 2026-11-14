import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { Monitor, Pencil, Plus, Search, Server, Trash2 } from 'lucide-react'
import type { ConversationMatch, Session, SessionInput, SessionUpdate, Target, TargetUpdate } from '../../shared/model'
import { harnessLabel, supportsTerminal } from '../../shared/harnesses'
import { ToolIcon } from '../ui/ToolIcon'
import { api } from '../api'
import ConnectDialog from '../connect/ConnectDialog'
import { useConnect } from '../connect/useConnect'
import { Confirm } from '../ui/Dialog'
import { Menu } from '../ui/Menu'
import { useToast } from '../ui/toast-context'
import ConversationsDialog from './ConversationsDialog'
import ForkDialog from './ForkDialog'
import SessionDialog from './SessionDialog'
import { ContinueInChat, DeleteConfirm, MoveToTerminal, StopConfirm } from './SessionMenu'
import SessionSettingsDialog from './SessionSettingsDialog'
import SessionTable from './SessionTable'
import SoftwarePanel from './SoftwarePanel'
import TargetDialog from './TargetDialog'
import { useSessions } from './useSessions'
import { useSoftware } from './useSoftware'
import { address, chatHref } from './labels'
import { sessionCreationOptions } from '../../shared/sessionCreation'
import type { DirectorySuggestions } from '../../shared/model'

type Panel =
  | { kind: 'session'; conversation: ConversationMatch | null }
  | { kind: 'fork' | 'settings' | 'conversations' | 'stop' | 'delete' | 'chat' | 'terminal'; session: Session }
  | { kind: 'edit' }
  | { kind: 'remove' }

/** What a machine's page does first when another view sends the user here. */
export type TargetRequest = { kind: 'open'; sessionId: string } | { kind: 'link'; match: ConversationMatch }

export default function TargetView({
  target,
  request,
  onFind,
  onUpdated,
  onRemoved,
}: {
  target: Target
  request: TargetRequest | null
  onFind: () => void
  onUpdated: (target: Target) => void
  onRemoved: (target: Target) => void
}) {
  const toast = useToast()
  const { sessions, error, refreshing, refresh } = useSessions(target.id)
  const connectFlow = useConnect(target, refresh)
  const software = useSoftware(target.id, target.tools.join(','))
  const [panel, setPanel] = useState<Panel | null>(() =>
    request?.kind === 'link' ? { kind: 'session', conversation: request.match } : null,
  )
  const [checking, setChecking] = useState<string[]>([])
  const { tools, missing } = sessionCreationOptions(target, software.report?.software ?? [])
  const ready = missing.length === 0 && tools.length > 0
  const directories = useCallback(
    (path: string, signal: AbortSignal) =>
      api<DirectorySuggestions>(
        `/targets/${target.id}/directories?path=${encodeURIComponent(path)}`,
        'GET',
        undefined,
        signal,
      ),
    [target.id],
  )
  const close = () => setPanel(null)

  function connect(session: Session) {
    close()
    connectFlow.connect(session)
  }

  const sessionPath = (session: Session) => `/targets/${target.id}/sessions/${session.id}`

  const inChat = (session: Session, extra?: { start?: boolean; schedule?: boolean }) =>
    window.location.assign(chatHref(target.id, session.id, extra))

  /** The session's main action: chat when it runs there or has no terminal, else a terminal. */
  const opensInChat = (session: Session) => session.driver === 'chat' || !supportsTerminal(session.tool)
  function open(session: Session) {
    if (opensInChat(session)) inChat(session)
    else connect(session)
  }

  /** Stop the session and start it again in the same conversation with its current settings. */
  async function restart(session: Session) {
    try {
      await api(`${sessionPath(session)}/terminate`, 'POST')
      if (session.driver === 'chat') inChat(session, { start: true })
      else connect(session)
      await refresh()
    } catch (problem) {
      toast((problem as Error).message, 'error')
    }
  }

  // A conversation found on this machine opens its session; linking one starts in the dialog above.
  const opening = request?.kind === 'open' ? request.sessionId : null
  const openFound = useEffectEvent((session: Session) => open(session))
  const failed = useEffectEvent((problem: Error) => toast(problem.message, 'error'))
  useEffect(() => {
    if (!opening) return
    api<Session>(`/targets/${target.id}/sessions/${opening}`).then(openFound, failed)
  }, [opening, target.id])

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
                  <ToolIcon tool={tool} size={11} />
                  {harnessLabel(tool)}
                </span>
              ))}
            </p>
          </div>
        </div>
        <div className="page-actions">
          <button className="button find-button" aria-label="Find a conversation" onClick={onFind}>
            <Search size={15} />
            <span>Find a conversation</span>
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
              { label: 'Edit machine', icon: <Pencil size={14} />, onSelect: () => setPanel({ kind: 'edit' }) },
              'separator',
              {
                label: 'Remove machine',
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
        primary={session =>
          opensInChat(session)
            ? { kind: 'chat', href: chatHref(target.id, session.id) }
            : { kind: 'terminal', connect: () => connect(session) }
        }
        actionsFor={session => ({
          ...(opensInChat(session)
            ? {
                terminal: () =>
                  session.driver === 'chat' ? setPanel({ kind: 'terminal', session }) : connect(session),
              }
            : {
                chat: () => (session.driver === 'terminal' ? setPanel({ kind: 'chat', session }) : inChat(session)),
              }),
          conversations: () => setPanel({ kind: 'conversations', session }),
          edit: () => setPanel({ kind: 'settings', session }),
          fork: () => setPanel({ kind: 'fork', session }),
          schedule: () => inChat(session, { schedule: true }),
          stop: () => setPanel({ kind: 'stop', session }),
          remove: () => setPanel({ kind: 'delete', session }),
        })}
        onRestart={session => void restart(session)}
        onConversations={session => setPanel({ kind: 'conversations', session })}
        onCheck={session => void check(session)}
      />

      {panel?.kind === 'session' && (
        <SessionDialog
          target={target}
          tools={tools}
          conversation={panel.conversation}
          directories={directories}
          copyFrom={(sessions ?? []).map(session => ({
            key: session.id,
            label: `${session.name} · ${harnessLabel(session.tool)}`,
            session,
          }))}
          onClose={close}
          onSave={async (input: SessionInput) => {
            const session = await api<Session>(`/targets/${target.id}/sessions`, 'POST', input)
            close()
            toast(`Created ${session.name}`)
            void refresh()
          }}
        />
      )}
      {panel?.kind === 'fork' && (
        <ForkDialog
          session={panel.session}
          machine={target.name}
          onClose={close}
          onSave={async input => {
            const session = await api<Session>(`/targets/${target.id}/sessions/${panel.session.id}/fork`, 'POST', input)
            close()
            toast(`Created ${session.name}`)
            void refresh()
          }}
        />
      )}
      {panel?.kind === 'settings' && (
        <SessionSettingsDialog
          session={panel.session}
          onClose={close}
          onSave={async (update: SessionUpdate) => {
            await api<Session>(sessionPath(panel.session), 'PATCH', update)
            await refresh()
          }}
          onRestart={() => restart(panel.session)}
        />
      )}
      {panel?.kind === 'conversations' && (
        <ConversationsDialog
          session={panel.session}
          whileRunning="Resuming another conversation stops the coding tool. The session continues in that conversation when it starts again."
          onClose={close}
          onSwitch={async conversation => {
            if (panel.session.driver) await api(`${sessionPath(panel.session)}/terminate`, 'POST')
            await api<Session>(`${sessionPath(panel.session)}/switch`, 'POST', { conversation })
            await refresh()
          }}
        />
      )}
      {connectFlow.connection && (
        <ConnectDialog
          target={target}
          connection={connectFlow.connection}
          onChoose={connectFlow.choose}
          onBack={connectFlow.back}
          onClose={connectFlow.close}
        />
      )}
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
          action="Remove machine"
          onClose={close}
          description="Outpost forgets this machine. Sessions and coding tools keep running on it, and adding it again shows them."
          onConfirm={async () => {
            await api(`/targets/${target.id}`, 'DELETE')
            onRemoved(target)
          }}
        />
      )}
      {panel?.kind === 'stop' && (
        <StopConfirm
          session={panel.session}
          onClose={close}
          onConfirm={async () => {
            await api(`${sessionPath(panel.session)}/terminate`, 'POST')
            await refresh()
          }}
        />
      )}
      {panel?.kind === 'delete' && (
        <DeleteConfirm
          session={panel.session}
          onClose={close}
          onConfirm={async () => {
            await api(sessionPath(panel.session), 'DELETE')
            await refresh()
          }}
        />
      )}
      {panel?.kind === 'chat' && (
        <ContinueInChat
          session={panel.session}
          onClose={close}
          onConfirm={async () => {
            await api(`${sessionPath(panel.session)}/terminate`, 'POST')
            inChat(panel.session, { start: true })
          }}
        />
      )}
      {panel?.kind === 'terminal' && (
        <MoveToTerminal
          session={panel.session}
          onClose={close}
          stop={async () => {
            await api(`${sessionPath(panel.session)}/terminate`, 'POST')
            await refresh()
          }}
          onOpen={() => connect(panel.session)}
        />
      )}
    </div>
  )
}
