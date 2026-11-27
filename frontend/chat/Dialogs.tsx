import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type {
  ConversationMatch,
  ConversationResults,
  DirectorySuggestions,
  Session,
  SessionInput,
} from '../../shared/model'
import { softwareLabel } from '../../shared/model'
import { harnesses, harnessLabel } from '../../shared/harnesses'
import { pagePaths } from '../../shared/pages'
import type { SessionRef } from '../../shared/chatApi'
import type { SessionCreationOptions } from '../../shared/sessionCreation'
import ConversationsDialog from '../workspace/ConversationsDialog'
import FinderDialog from '../workspace/FinderDialog'
import ForkDialog from '../workspace/ForkDialog'
import SessionDialog from '../workspace/SessionDialog'
import { DeleteConfirm, StopConfirm } from '../workspace/SessionMenu'
import SessionSettingsDialog from '../workspace/SessionSettingsDialog'
import { plainRef } from './client'
import { useChat } from './context'

export function DialogFooter({
  busy,
  onClose,
  action,
  form,
  danger,
}: {
  busy: boolean
  onClose: () => void
  action: string
  form: string
  danger?: React.ReactNode
}) {
  return (
    <>
      {danger}
      <button className="button" type="button" disabled={busy} onClick={onClose}>
        Cancel
      </button>
      <button className="button primary" form={form} disabled={busy}>
        {busy ? 'Saving…' : action}
      </button>
    </>
  )
}

/** Create a session that starts in chat, or link a conversation found on a machine. */
export function NewSessionDialog({
  machine,
  conversation = null,
  onClose,
}: {
  machine?: string
  conversation?: ConversationMatch | null
  onClose: () => void
}) {
  const { client, select } = useChat()
  const [targetId, setTargetId] = useState(machine ?? client.targets[0]?.id ?? '')
  const [loaded, setLoaded] = useState<{
    targetId: string
    options: SessionCreationOptions | null
    problem: string
  } | null>(null)
  const requestId = useRef(crypto.randomUUID())
  useEffect(() => {
    if (!targetId) return
    let current = true
    client.call<SessionCreationOptions>({ type: 'session-options', targetId }).then(
      options => current && setLoaded({ targetId, options, problem: '' }),
      error => current && setLoaded({ targetId, options: null, problem: (error as Error).message }),
    )
    return () => {
      current = false
    }
  }, [client, targetId])
  const options = loaded?.targetId === targetId ? loaded.options : null
  const problem = loaded?.targetId === targetId ? loaded.problem : ''
  const directories = useCallback(
    (path: string) => client.call<DirectorySuggestions>({ type: 'directories', targetId, path }),
    [client, targetId],
  )
  const target = client.targets.find(item => item.id === targetId) ?? null
  return (
    <SessionDialog
      target={options ? target : null}
      tools={options && !options.missing.length ? options.tools : []}
      conversation={conversation}
      directories={directories}
      description={target ? `On ${target.name}. It starts in chat.` : undefined}
      copyFrom={client.sessions.map(session => ({
        key: `${session.targetId}/${session.id}`,
        label: `${session.name} · ${harnessLabel(session.tool)} on ${session.target}`,
        session,
      }))}
      beforeFields={
        <>
          <label className="field">
            <span className="label">Machine</span>
            <select
              value={targetId}
              disabled={Boolean(conversation)}
              onChange={event => setTargetId(event.target.value)}
            >
              {client.targets.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {!options && !problem && targetId && (
            <p className="muted">
              <LoaderCircle size={14} className="spin" /> Checking the coding tools on {target?.name}…
            </p>
          )}
          {problem && <p className="error">{problem}</p>}
          {options && options.missing.length > 0 && (
            <p className="warning">
              Set up {options.missing.map(softwareLabel).join(', ')} on {target?.name} first, from{' '}
              <MachineLink targetId={targetId}>its page in Machines</MachineLink>.
            </p>
          )}
          {options && options.missing.length === 0 && options.tools.length === 0 && (
            <p className="warning">
              No coding tools are installed on {target?.name}. Set one up from{' '}
              <MachineLink targetId={targetId}>its page in Machines</MachineLink>.
            </p>
          )}
          {options &&
            options.missing.length === 0 &&
            options.tools.length > 0 &&
            options.tools.length < harnesses.length &&
            !conversation && (
              <p className="hint">
                Need another coding tool? Set it up on{' '}
                <MachineLink targetId={targetId}>{target?.name}’s machine page</MachineLink>.
              </p>
            )}
        </>
      }
      onSave={async (input: SessionInput) => {
        const created = await client.call<SessionRef>({
          type: 'session-create',
          targetId,
          requestId: requestId.current,
          input,
        })
        client.restart(created)
        select({ kind: 'session', ...created })
        onClose()
      }}
      onClose={onClose}
    />
  )
}

export function SessionSettingsChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  const [tools, setTools] = useState<SessionCreationOptions['tools'] | undefined>(undefined)
  useEffect(() => {
    let active = true
    client.call<SessionCreationOptions>({ type: 'session-options', targetId: target.targetId }).then(
      options => active && setTools(options.tools),
      () => {},
    )
    return () => {
      active = false
    }
  }, [client, target.targetId])
  const directories = useCallback(
    (path: string) => client.call<DirectorySuggestions>({ type: 'directories', targetId: target.targetId, path }),
    [client, target.targetId],
  )
  if (!session) return null
  return (
    <SessionSettingsDialog
      session={session}
      tools={tools}
      directories={directories}
      onClose={onClose}
      onSave={update => client.call<Session>({ type: 'session-update', ...target, update })}
      onRestart={async () => {
        await client.call({ type: 'stop', ...target })
        client.restart(target)
      }}
    />
  )
}

export function ConversationsChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return (
    <ConversationsDialog
      session={session}
      whileRunning="Resuming another conversation restarts the coding tool in it."
      onClose={onClose}
      onSwitch={async (conversation, options) => {
        if (session.driver) await client.call({ type: 'stop', ...target })
        await client.call({
          type: 'session-switch',
          ...target,
          conversation,
          ...(options?.reclaim ? { reclaim: true } : {}),
        })
        client.restart(target)
      }}
      onNewConversation={async () => {
        if (session.driver) await client.call({ type: 'stop', ...target })
        await client.call({ type: 'new-conversation', ...target })
        client.restart(target)
      }}
    />
  )
}

export function StopChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return <StopConfirm session={session} onClose={onClose} onConfirm={() => client.call({ type: 'stop', ...target })} />
}

export function DeleteChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client, select } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return (
    <DeleteConfirm
      session={session}
      onClose={onClose}
      onConfirm={async () => {
        await client.call({ type: 'session-delete', ...target })
        select(null)
      }}
    />
  )
}

export function ForkChatDialog({ target: selected, onClose }: { target: SessionRef; onClose: () => void }) {
  const { client, select } = useChat()
  const target = plainRef(selected)
  const session = client.session(target)
  if (!session) return null
  return (
    <ForkDialog
      session={session}
      machine={session.target}
      onClose={onClose}
      onSave={async input => {
        const created = await client.call<SessionRef>({ type: 'session-fork', ...target, input })
        select({ kind: 'session', ...created })
        onClose()
      }}
    />
  )
}

/** Find a conversation on any machine; one Outpost has opens here, others link as new sessions. */
export function FindChatDialog({ query, onClose }: { query: string; onClose: () => void }) {
  const { client, select, open } = useChat()
  return (
    <FinderDialog
      machines={client.targets}
      initialQuery={query}
      search={(targetId, search) => client.call<ConversationResults>({ type: 'conversation-search', targetId, search })}
      onOpen={(targetId, sessionId) => {
        onClose()
        select({ kind: 'session', targetId, sessionId })
      }}
      onLink={(targetId, match) => open({ kind: 'session', targetId, conversation: match })}
      onClose={onClose}
    />
  )
}

export function MachineLink({ targetId, children }: { targetId?: string; children: React.ReactNode }) {
  const href = targetId
    ? `${pagePaths.workspace}?target=${encodeURIComponent(targetId)}`
    : `${pagePaths.workspace}?add=1`
  return <a href={href}>{children}</a>
}
