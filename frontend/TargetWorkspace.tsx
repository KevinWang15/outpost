import { lazy, Suspense, useRef, useState } from 'react'
import { Circle, Plus, Search, Terminal, X } from 'lucide-react'
import type {
  Connection,
  Target,
  Session,
  SessionInput,
  CodingSessionMatch,
} from '../shared/session-manager'
import { requiredSoftware } from '../shared/session-manager'
import { api } from './api'
import { Modal } from './ui'
import ConnectModal from './ConnectModal'
import Toast from './Toast'
import ImageAttach from './ImageAttach'
import SessionForm from './SessionForm'
import { useLiveSessions } from './useLiveSessions'
import { useRequiredSoftware } from './useRequiredSoftware'
import RequiredSoftware from './RequiredSoftware'
import CodingSessionFinder from './CodingSessionFinder'
import SessionList from './SessionList'
import { useSessionConnection, type ConnectionMode } from './useSessionConnection'
import { useAuth } from './useAuth'
const WebTerminalModal = lazy(() => import('./WebTerminalModal'))

type WorkspaceDialog =
  | { kind: 'session'; id: number; conversation: CodingSessionMatch | null }
  | { kind: 'finder' }
  | { kind: 'connection'; session: Session; data: Connection }
  | { kind: 'image'; session: Session }
  | { kind: 'web-terminal'; session: Session }
  | { kind: 'confirm'; session: Session; action: 'delete' | 'terminate' }

export default function TargetWorkspace({
  target,
  onUpdate,
  externalDialogOpen,
}: {
  target: Target
  onUpdate: (target: Target) => void
  externalDialogOpen: boolean
}) {
  const hosted = useAuth().mode === 'hosted'
  const { sessions, registryPath, sessionLoadError, refreshing, refresh } =
    useLiveSessions(target.id)
  const software = useRequiredSoftware(target.id, `${target.backends.join(',')}|${target.tools.join(',')}`)
  const report = software.report
  const installed = new Set(report?.software.filter((item) => item.status === 'installed').map((item) => item.id))
  const installedTools = target.tools.filter((tool) => installed.has(tool))
  const installedBackends = report
    ? target.backends.filter((backend) =>
        requiredSoftware({ backends: [backend], tools: [] }, report.environment.platform)
          .every((id) => installed.has(id)),
      )
    : []
  const canCreate =
    installedBackends.length > 0 && installedTools.length > 0 && !software.checking
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<WorkspaceDialog | null>(null)
  const nextFormId = useRef(0)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [checking, setChecking] = useState<string[]>([])
  const connection = useSessionConnection(target.id, externalDialogOpen,
    (session, data) => setDialog({ kind: 'connection', session, data }), setError)

  function openDialog(next: WorkspaceDialog | null) {
    connection.cancel()
    setDialog(next)
  }
  function openSessionForm(conversation: CodingSessionMatch | null = null) {
    openDialog({ kind: 'session', id: ++nextFormId.current, conversation })
  }
  async function addSession(input: SessionInput) {
    const formId = dialog?.kind === 'session' ? dialog.id : null
    await api(`/targets/${target.id}/sessions`, 'POST', input)
    setDialog(current => current?.kind === 'session' && current.id === formId ? null : current)
    await refresh()
  }
  function connect(session: Session, mode: ConnectionMode) {
    setDialog(null)
    void connection.connect(session, mode)
  }
  async function checkSession(session: Session) {
    if (!session.activity.completionId) return
    setChecking(current => [...current, session.id])
    try {
      await api(`/targets/${target.id}/sessions/${session.id}/acknowledge`, 'POST', { completionId: session.activity.completionId })
      await refresh()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setChecking(current => current.filter(id => id !== session.id))
    }
  }
  async function confirmAction() {
    if (dialog?.kind !== 'confirm') return
    const confirmation = dialog
    setConfirmBusy(true)
    try {
      if (confirmation.action === 'terminate') {
        await api(`/targets/${target.id}/sessions/${confirmation.session.id}/terminate`, 'POST')
      } else {
        await api(`/targets/${target.id}/sessions/${confirmation.session.id}`, 'DELETE')
      }
      await refresh()
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setDialog(current => current === confirmation ? null : current)
      setConfirmBusy(false)
    }
  }
  const running = sessions.filter((session) =>
    ['attached', 'detached'].includes(session.status),
  ).length
  const { notice, dismissNotice } = connection
  const notification = notice && <Toast key={notice.id} message={notice.message} tone={notice.tone} onClose={dismissNotice} />
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h1>{target.name}</h1>
          <p className="target-address">
            <Circle className="status-indicator green" size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            <code>
              {target.kind === 'ssh'
                ? `root@${target.host}${target.port ? `:${target.port}` : ''}`
                : `${software.report?.environment.username ?? target.environment?.username ?? 'Current user'} · ${target.distribution ?? 'This computer'}`}
            </code>
            <span className="tag">
              {target.kind === 'ssh'
                ? 'SSH'
                : target.distribution
                  ? 'LOCAL / WSL'
                  : 'LOCAL'}
            </span>
          </p>
          <p className="target-backend">
            Session backends: <strong>{target.backends.join(' + ')}</strong>
          </p>
        </div>
        <div className="workspace-actions">
        <button className="button secondary" onClick={() => openDialog({ kind: 'finder' })}><Search size={16} /> Find coding sessions</button>
        <button
          className="button primary"
          disabled={!canCreate}
          onClick={() => openSessionForm()}
        >
          <Plus /> New session
        </button>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => {
              setError('')
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <RequiredSoftware
        target={target}
        state={software}
        onUpdate={onUpdate}
        onInstallClose={() => void refresh()}
        onDialogOpen={() => openDialog(null)}
      />
      <section className="stats-row">
        <div>
          <span>TOTAL SESSIONS</span>
          <strong>{sessions.length.toString().padStart(2, '0')}</strong>
        </div>
        <div>
          <span>RUNNING SESSIONS</span>
          <strong>
            {running.toString().padStart(2, '0')}
            <Circle className="status-indicator running-indicator" size={6} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          </strong>
        </div>
        <div className="registry-stat">
          <span>SESSION REGISTRY</span>
          <code>
            {registryPath ||
              (software.report
                ? `${software.report.environment.home}/.outpost/sessions.json`
                : '~/.outpost/sessions.json')}
          </code>
          <small>All managed tmux and dtach sessions on this instance</small>
        </div>
      </section>
      <SessionList sessions={sessions} error={sessionLoadError} refreshing={refreshing}
        canCreate={canCreate} connecting={connection.connecting}
        checking={checking} onCheck={session => void checkSession(session)}
        onRefresh={() => void refresh()} onCreate={() => openSessionForm()}
        onConnect={connect} onImage={session => openDialog({ kind: 'image', session })}
        onWebTerminal={target.kind === 'ssh' ? session => openDialog({ kind: 'web-terminal', session }) : undefined}
        onConfirm={(session, action) => openDialog({ kind: 'confirm', session, action })} />
      <div className="bottom-note">
        <Terminal />
        <p>
          <strong>Your work stays where it runs.</strong>{' '}
          {hosted
            ? <>Choose <strong>… → Launch with web terminal</strong> to connect in your browser, including on your phone. Outpost holds the SSH connection to your server.</>
            : <>Click <strong>Connect</strong> to open a terminal on this computer. Detach with <kbd>Ctrl</kbd> + <kbd>\</kbd>, and return whenever you’re ready.</>}
        </p>
      </div>
      {dialog?.kind === 'session' && (
        <SessionForm key={dialog.id} target={target} tools={installedTools} backends={installedBackends}
          conversation={dialog.conversation} onSave={addSession} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'finder' && (
        <CodingSessionFinder target={target} tools={installedTools} canLink={canCreate}
          onClose={() => setDialog(null)} onLink={openSessionForm}
          onOpen={session => connect(session, 'launch')} />
      )}
      {dialog?.kind === 'connection' && (
        <ConnectModal targetId={target.id} kind={target.kind} session={dialog.session}
          connection={dialog.data} notification={notification}
          onClose={() => { setDialog(null); dismissNotice() }} />
      )}
      {dialog?.kind !== 'connection' && notification}
      {dialog?.kind === 'image' && (
        <ImageAttach targetId={target.id} session={dialog.session} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'web-terminal' && <Suspense fallback={<Modal title="Web terminal" subtitle="Loading terminal…" onClose={() => setDialog(null)}><p role="status">Loading…</p></Modal>}>
        <WebTerminalModal target={target} session={dialog.session} onClose={() => { setDialog(null); void refresh() }} />
      </Suspense>}
      {dialog?.kind === 'confirm' && (
        <Modal
          title={`${dialog.action === 'terminate' ? 'Terminate' : 'Remove'} ${dialog.session.name} (${dialog.session.backend})?`}
          subtitle={dialog.action === 'terminate'
            ? 'This stops the coding tool and its child processes, including any work in progress, and disconnects attached terminals. The session record, project files, and coding CLI session ID are kept. Connecting again resumes the same conversation.'
            : 'This removes the session record. The project directory and coding tool history are kept.'}
          closeDisabled={confirmBusy} onClose={() => setDialog(null)}
        >
          <div className="modal-actions">
            <button className="button secondary" disabled={confirmBusy} onClick={() => setDialog(null)}>Cancel</button>
            <button className="button danger" disabled={confirmBusy} onClick={() => void confirmAction()}>
              {dialog.action === 'terminate'
                ? confirmBusy ? 'Terminating…' : 'Terminate session'
                : confirmBusy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
