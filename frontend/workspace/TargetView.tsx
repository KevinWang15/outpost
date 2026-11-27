import { useCallback, useEffect, useEffectEvent, useState } from 'react'
import { Monitor, Pencil, Plus, Search, Server, Trash2 } from 'lucide-react'
import {
  compareSessionsByRecency,
  harnessSoftware,
  type ConversationMatch,
  type DirectorySuggestions,
  type Session,
  type SessionInput,
  type SessionUpdate,
  type Target,
  type TargetUpdate,
} from '../../shared/model'
import { harnesses, harnessLabel, supportsTerminal } from '../../shared/harnesses'
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
import { DeleteConfirm, StopConfirm } from './SessionMenu'
import SessionSettingsDialog from './SessionSettingsDialog'
import SessionTable from './SessionTable'
import SoftwarePanel from './SoftwarePanel'
import MachineInstall from './MachineInstall'
import TargetDialog from './TargetDialog'
import { useSessions } from './useSessions'
import { useSoftware } from './useSoftware'
import { address, chatHref } from './labels'
import { sessionCreationOptions } from '../../shared/sessionCreation'

type Panel =
  | { kind: 'session'; conversation: ConversationMatch | null }
  | { kind: 'fork' | 'settings' | 'conversations' | 'stop' | 'delete'; session: Session }
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
  const [available, setAvailable] = useState(target.kind !== 'outbound')
  const { sessions, error, refreshing, refresh } = useSessions(target.id, available)
  const connectFlow = useConnect(target, refresh)
  const software = useSoftware(target.id, available)
  const [panel, setPanel] = useState<Panel | null>(() =>
    request?.kind === 'link' ? { kind: 'session', conversation: request.match } : null,
  )
  const [checking, setChecking] = useState<string[]>([])
  const options = sessionCreationOptions(software.report?.software ?? [])
  const tools = options.tools
  const missing = options.missing
  const unavailableTools = harnesses.map(h => h.id).filter(id => !tools.includes(id))
  const ready = available && missing.length === 0 && tools.length > 0
  const createDisabledTitle = !available
    ? 'Connect the machine first'
    : missing.length > 0
      ? 'Set up machine software first'
      : tools.length === 0
        ? 'Set up a coding tool first'
        : undefined
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

  /** Prefer Chat for ACP-driven sessions and tools without a native CLI. */
  const opensInChat = (session: Session) => session.driver === 'chat' || !supportsTerminal(session.tool)
  function open(session: Session) {
    if (opensInChat(session)) inChat(session)
    else connect(session)
  }

  /** Stop the session and start it again with its current settings. */
  async function restart(session: Session) {
    await api(`${sessionPath(session)}/terminate`, 'POST')
    if (opensInChat(session)) inChat(session, { start: true })
    else connect(session)
    await refresh()
  }

  // A conversation found on this machine opens its session; linking one starts in the dialog above.
  const opening = request?.kind === 'open' ? request.sessionId : null
  const openFound = useEffectEvent((session: Session) => open(session))
  const failed = useEffectEvent((problem: Error) => toast(problem.message, 'error'))
  useEffect(() => {
    if (!opening) return
    const controller = new AbortController()
    void api<Session>(`/targets/${target.id}/sessions/${opening}`, 'GET', undefined, controller.signal).then(
      session => {
        if (!controller.signal.aborted) openFound(session)
      },
      problem => {
        if (!controller.signal.aborted) failed(problem as Error)
      },
    )
    return () => controller.abort()
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
  const TargetIcon = target.kind === 'local' ? Monitor : Server

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
              {tools.map(tool => (
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
            title={createDisabledTitle}
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
      {target.kind === 'outbound' && <MachineInstall key={target.id} id={target.id} onReady={setAvailable} />}
      {available && (
        <>
          <SoftwarePanel target={target} state={software} onInstalled={() => void refresh()} />
          <SessionTable
            sessions={sessions}
            error={missing.length > 0 ? '' : error}
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
              ...(opensInChat(session) ? { terminal: () => connect(session) } : { chat: () => inChat(session) }),
              conversations: () => setPanel({ kind: 'conversations', session }),
              edit: () => setPanel({ kind: 'settings', session }),
              fork: () => setPanel({ kind: 'fork', session }),
              schedule: () => inChat(session, { schedule: true }),
              stop: () => setPanel({ kind: 'stop', session }),
              remove: () => setPanel({ kind: 'delete', session }),
            })}
            onRestart={session => void restart(session).catch(problem => toast((problem as Error).message, 'error'))}
            onConversations={session => setPanel({ kind: 'conversations', session })}
            onCheck={session => void check(session)}
          />
        </>
      )}

      {panel?.kind === 'session' && (
        <SessionDialog
          target={target}
          tools={ready ? tools : []}
          unavailableTools={available && missing.length === 0 ? unavailableTools : []}
          settingUpTools={software.job?.status === 'running' ? software.job.software : []}
          setupError={software.job?.status === 'failed' ? software.job.error : software.error || null}
          onSetupTool={tool => void software.setup(harnessSoftware(tool))}
          beforeFields={!available && <p className="warning">Reconnect this machine to create a session.</p>}
          conversation={panel.conversation}
          directories={directories}
          copyFrom={[...(sessions ?? [])].sort(compareSessionsByRecency).map(session => ({
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
          tools={ready ? tools : undefined}
          directories={directories}
          onClose={close}
          onSave={async (update: SessionUpdate) => {
            const updated = await api<Session>(sessionPath(panel.session), 'PATCH', update)
            await refresh()
            return updated
          }}
          onRestart={updated => restart(updated)}
        />
      )}
      {panel?.kind === 'conversations' && (
        <ConversationsDialog
          session={panel.session}
          whileRunning="Resuming another conversation stops the coding tool. The session continues in that conversation when it starts again."
          onClose={close}
          onSwitch={async (conversation, options) => {
            if (panel.session.driver) await api(`${sessionPath(panel.session)}/terminate`, 'POST')
            await api<Session>(`${sessionPath(panel.session)}/switch`, 'POST', {
              conversation,
              ...(options?.reclaim ? { reclaim: true } : {}),
            })
            await refresh()
          }}
          onNewConversation={async () => {
            if (panel.session.driver) await api(`${sessionPath(panel.session)}/terminate`, 'POST')
            await api<Session>(`${sessionPath(panel.session)}/conversations`, 'POST', {})
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
          description="This removes the machine from your workspace. Its sessions and files stay on the machine. If it was enrolled, run ~/.outpost/bin/outpost-terminal unenroll as the original Linux user before adding it again."
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
    </div>
  )
}
