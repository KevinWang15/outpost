import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type * as acp from '@agentclientprotocol/sdk'
import {
  ArrowDown,
  ArrowLeft,
  CalendarClock,
  CircleAlert,
  Files,
  LoaderCircle,
  NotebookPen,
  Play,
  Square,
  SquareTerminal,
  Trash2,
} from 'lucide-react'
import { sessionKey, type SessionRef } from '../../shared/chatApi'
import type { ChatInfo } from '../../shared/chatHost'
import { harnessLabel } from '../../shared/harnesses'
import { FileViewer } from '../terminal/FileViewer'
import { useSessionFiles } from '../terminal/useSessionFiles'
import { Menu } from '../ui/Menu'
import { FilesPanel } from './Files'
import { Avatar } from './Avatar'
import { transcriptOf } from './client'
import Composer from './Composer'
import { presence, presenceLabel } from './format'
import { ConversationContext, useChat, type ConversationActions } from './context'
import { Turn } from './Turn'

const page = 60

function flatOptions(option: acp.SessionConfigOption) {
  if (option.type !== 'select') return []
  return option.options.flatMap(item => ('group' in item ? item.options : [item]))
}

/** Mode and model, as the agent offers them. */
function Settings({ target, info }: { target: SessionRef; info: ChatInfo | null }) {
  const { client } = useChat()
  const [error, setError] = useState('')
  if (!info || info.state !== 'ready') return null
  const shown = info.config.filter(
    option => option.type === 'select' && ['mode', 'model', 'thought_level'].includes(option.category ?? option.id),
  )
  const options = shown.length ? shown : info.config.filter(option => option.type === 'select').slice(0, 2)
  const set = async (message: Parameters<typeof client.request>[0]) => {
    setError('')
    const result = await client.request(message)
    if (!result.ok) setError(result.message ?? 'The change was not applied.')
  }
  return (
    <div className="session-settings">
      {options.map(option => (
        <select
          key={option.id}
          aria-label={option.name}
          title={option.description ?? option.name}
          value={String(option.currentValue)}
          onChange={event => void set({ type: 'config', ...target, configId: option.id, value: event.target.value })}
        >
          {flatOptions(option).map(item => (
            <option key={item.value} value={item.value}>
              {item.name}
            </option>
          ))}
        </select>
      ))}
      {!options.length && info.modes && (
        <select
          aria-label="Mode"
          value={info.modes.currentModeId}
          onChange={event => void set({ type: 'mode', ...target, modeId: event.target.value })}
        >
          {info.modes.availableModes.map(mode => (
            <option key={mode.id} value={mode.id}>
              {mode.name}
            </option>
          ))}
        </select>
      )}
      {error && (
        <span className="error" title={error}>
          <CircleAlert size={14} />
        </span>
      )}
    </div>
  )
}

export default function SessionView({ target: selected, onBack }: { target: SessionRef; onBack: () => void }) {
  const { client, open } = useChat()
  const { targetId, sessionId } = selected
  const target = useMemo(() => ({ targetId, sessionId }), [targetId, sessionId])
  const key = sessionKey(target)
  const session = client.session(target)
  const conversation = client.conversations.get(key)
  const journal = conversation?.journal ?? null
  const info = conversation?.info ?? null
  // transcriptOf memoizes per journal version.
  const view = journal ? transcriptOf(journal) : null
  const terminal = session?.driver === 'terminal'
  const [limit, setLimit] = useState(page)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [behind, setBehind] = useState(false)

  // Follow the session while this view shows it. Opening it starts the coding
  // tool, unless the conversation is running in a terminal. (Views are keyed by
  // session, so scroll and paging state start fresh for each one.)
  const loaded = client.sessionsLoaded
  useEffect(() => {
    if (!loaded) return
    return client.open(target, !terminal)
  }, [client, target, loaded, terminal])

  // Mark the latest reply as seen while it is on screen.
  const completion = session?.activity.state === 'finished' ? session.activity.completionId : null
  useEffect(() => {
    if (!completion) return
    const mark = () => document.visibilityState === 'visible' && client.seen(target, completion)
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [client, target, completion])

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (pinned.current) element.scrollTop = element.scrollHeight
    else setBehind(true)
  }, [view, info?.state])

  // Published files: listed over HTTP, refreshed when the agent publishes one.
  const access = useMemo(() => client.files(target), [client, target])
  const published = journal?.entries.reduce((count, entry) => count + Number(entry.kind === 'file'), 0) ?? 0
  const files = useSessionFiles(access, client.status === 'live', published)
  const [panel, setPanel] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)

  const actions: ConversationActions = useMemo(
    () => ({
      readOnly: false,
      answer: async (request, optionId) => {
        const result = await client.request({ type: 'permission', ...target, request, optionId })
        if (!result.ok) throw new Error(result.message ?? 'The answer was not accepted.')
      },
      unqueue: async turn => {
        const result = await client.request({ type: 'unqueue', ...target, turn })
        if (!result.ok) throw new Error(result.message ?? 'The message already started.')
      },
      previews: key => (key ? (client.previews.get(key) ?? []) : []),
      files: { access, state: files, open: setViewing },
    }),
    [client, target, access, files, setViewing],
  )

  if (!session)
    return (
      <section className="conversation">
        <div className="empty">
          {client.sessionsLoaded ? <p>This session no longer exists.</p> : <LoaderCircle className="spin" size={18} />}
        </div>
      </section>
    )

  const link = conversation?.link ?? 'starting'
  const state = presence(session)
  const running = view?.running !== null && view?.running !== undefined
  const turns = (view?.turns ?? []).filter(turn => turn.status !== 'queued' && turn.status !== 'removed')
  const shown = turns.slice(-limit)
  const avatar = <Avatar id={session.id} name={session.name} tool={session.tool} />
  const starting = link === 'starting' || info?.state === 'starting' || info?.state === 'identity'
  const stopped = link === 'stopped' || info?.state === 'exited' || info?.state === 'failed'
  const usage = info?.usage
  return (
    <ConversationContext.Provider value={actions}>
      <section className="conversation">
        <header className="conversation-header">
          <button className="icon-button back" aria-label="Back to the list" onClick={onBack}>
            <ArrowLeft size={18} />
          </button>
          <Avatar id={session.id} name={session.name} tool={session.tool} session={session} size={32} />
          <div className="conversation-title">
            <h1>{session.name}</h1>
            <p>
              <span className={`presence-label ${state}`}>{presenceLabel[state]}</span>
              {' · '}
              {harnessLabel(session.tool)} on {session.target} · <code title={session.rootDir}>{session.rootDir}</code>
            </p>
          </div>
          {(files.files.length > 0 || panel) && (
            <button
              className="icon-button files-button"
              aria-label={`Files (${files.files.length})`}
              aria-pressed={panel}
              title="Files"
              onClick={() => setPanel(!panel)}
            >
              <Files size={17} />
              <span>{files.files.length}</span>
            </button>
          )}
          <Settings target={target} info={info} />
          <Menu
            label={`Actions for ${session.name}`}
            items={[
              {
                label: 'Open in terminal',
                icon: <SquareTerminal size={14} />,
                onSelect: () => open({ kind: 'terminal', ...target }),
              },
              {
                label: session.instructions ? 'Edit instructions' : 'Add instructions',
                icon: <NotebookPen size={14} />,
                onSelect: () => open({ kind: 'instructions', ...target }),
              },
              {
                label: 'Schedule a task',
                icon: <CalendarClock size={14} />,
                onSelect: () => open({ kind: 'schedule', scheduleId: null, session: target }),
              },
              'separator',
              stopped || terminal
                ? {
                    label: 'Start chat',
                    icon: <Play size={14} />,
                    disabled: terminal,
                    onSelect: () => client.restart(target),
                  }
                : {
                    label: 'Stop coding tool',
                    icon: <Square size={14} />,
                    danger: true,
                    onSelect: () => void client.request({ type: 'stop', ...target }),
                  },
            ]}
          />
        </header>
        <div
          className="transcript"
          ref={scroller}
          onScroll={event => {
            const element = event.currentTarget
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
            if (pinned.current) setBehind(false)
          }}
        >
          <div className="transcript-inner">
            {view?.truncated && <p className="transcript-note">Earlier steps of this chat are no longer kept here.</p>}
            {turns.length > limit && (
              <button className="button small more" onClick={() => setLimit(limit + page)}>
                Show earlier messages
              </button>
            )}
            {!turns.length && journal && !starting && (
              <div className="transcript-empty">
                <Avatar id={session.id} name={session.name} tool={session.tool} size={44} />
                <h2>{session.name}</h2>
                <p>
                  {harnessLabel(session.tool)} in <code>{session.rootDir}</code>. Ask it anything about this project.
                </p>
              </div>
            )}
            {shown.map(turn => (
              <Turn key={turn.id} turn={turn} avatar={avatar} />
            ))}
            {terminal ? (
              <div className="status-card">
                <SquareTerminal size={18} />
                <div>
                  <strong>This conversation is open in a terminal.</strong>
                  <p>To continue here, end the terminal process; the conversation itself stays the same.</p>
                </div>
                <button className="button small" onClick={() => open({ kind: 'terminal', ...target })}>
                  Open terminal
                </button>
              </div>
            ) : link === 'unavailable' ? (
              <div className="status-card error">
                <CircleAlert size={18} />
                <div>
                  <strong>The chat could not open.</strong>
                  <p>{conversation?.message ?? 'Check Required Software for this target.'}</p>
                </div>
                <button className="button small" onClick={() => client.restart(target)}>
                  Try again
                </button>
              </div>
            ) : stopped ? (
              <div className={`status-card ${info?.error ? 'error' : ''}`}>
                {info?.error ? <CircleAlert size={18} /> : <Square size={16} />}
                <div>
                  <strong>{info?.error ? 'The coding tool stopped.' : 'The coding tool is not running.'}</strong>
                  {(info?.error || conversation?.message) && <p>{info?.error ?? conversation?.message}</p>}
                </div>
                <button className="button small primary" onClick={() => client.restart(target)}>
                  <Play size={14} /> Start
                </button>
              </div>
            ) : starting ? (
              <p className="transcript-status">
                <LoaderCircle size={14} className="spin" />
                {journal ? 'Starting the coding tool…' : 'Opening the conversation…'}
              </p>
            ) : null}
          </div>
        </div>
        {behind && (
          <button
            className="jump"
            onClick={() => {
              const element = scroller.current
              if (element) element.scrollTop = element.scrollHeight
              pinned.current = true
              setBehind(false)
            }}
          >
            <ArrowDown size={14} /> Latest
          </button>
        )}
        {!terminal && (
          <footer className="conversation-footer">
            {view && view.queue.length > 0 && (
              <ul className="queue" aria-label="Queued messages">
                {view.queue.map(turn => (
                  <li key={turn.id}>
                    <span>
                      {turn.prompt
                        .map(block => (block.type === 'text' ? block.text : '[image]'))
                        .join(' ')
                        .slice(0, 140)}
                    </span>
                    <button
                      className="icon-button"
                      aria-label="Remove queued message"
                      onClick={() => void actions.unqueue(turn.id).catch(() => {})}
                    >
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Composer
              draftKey={`session:${key}`}
              placeholder={`Message ${session.name}`}
              images={info?.images ?? true}
              commands={(info?.commands ?? []).map(command => ({ value: command.name, label: command.description }))}
              running={running}
              disabled={
                link === 'unavailable'
                  ? 'This chat is unavailable.'
                  : stopped
                    ? 'Start the coding tool to send messages.'
                    : null
              }
              onSend={async (text, images, key) => {
                pinned.current = true
                await client.prompt(target, text, images, key)
              }}
              onStop={() => void client.request({ type: 'cancel', ...target })}
            />
            {usage && usage.size > 0 && (
              <p className="usage">
                {Math.round((usage.used / usage.size) * 100)}% of {Math.round(usage.size / 1000)}k context
                {usage.cost &&
                  usage.cost.amount > 0 &&
                  ` · ${usage.cost.currency === 'USD' ? '$' : ''}${usage.cost.amount.toFixed(2)}${usage.cost.currency === 'USD' ? '' : ` ${usage.cost.currency}`}`}
              </p>
            )}
          </footer>
        )}
      </section>
      {panel && <FilesPanel access={access} state={files} onOpen={setViewing} onClose={() => setPanel(false)} />}
      {viewing && <FileViewer selected={viewing} access={access} state={files} close={() => setViewing(null)} />}
    </ConversationContext.Provider>
  )
}
