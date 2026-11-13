import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Plus, Webhook as WebhookIcon } from 'lucide-react'
import type { LogKind, LogView, Webhook } from '../../shared/logs'
import { api } from '../api'
import { AppSidebar } from '../ui/AppSidebar'
import WebhookDialog from './WebhookDialog'
import '../styles/logs.scss'

/** Quick views over the log; each one sets the viewer's filter. */
const views: { id: string; label: string; criteria: object }[] = [
  { id: 'all', label: 'All activity', criteria: {} },
  { id: 'agent', label: 'Agent status', criteria: { loggers: ['agent' satisfies LogKind] } },
  { id: 'message', label: 'Messages', criteria: { loggers: ['message' satisfies LogKind] } },
  { id: 'session', label: 'Sessions', criteria: { loggers: ['session' satisfies LogKind] } },
  { id: 'machine', label: 'Machines', criteria: { loggers: ['machine' satisfies LogKind] } },
  // Viewer levels: 3 WARN, 4 ERROR, 5 FATAL.
  { id: 'problems', label: 'Warnings and errors', criteria: { levels: [3, 4, 5] } },
]

/** The account's activity log, in the log viewer, and its webhooks. */
export default function LogsPage() {
  const [view, setView] = useState<LogView | null>(null)
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState('all')
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    document.title = 'Logs · Outpost'
    const controller = new AbortController()
    Promise.all([
      api<LogView>('/logs', 'GET', undefined, controller.signal),
      api<Webhook[]>('/webhooks', 'GET', undefined, controller.signal),
    ]).then(
      ([logView, list]) => {
        setView(logView)
        setWebhooks(list)
      },
      problem => !controller.signal.aborted && setError((problem as Error).message),
    )
    return () => controller.abort()
  }, [])

  // The embedded viewer says when it is ready; filters are posted to it after that.
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return
      if (event.data?.logViewer === 'ready') setReady(true)
    }
    window.addEventListener('message', listen)
    return () => window.removeEventListener('message', listen)
  }, [])
  useEffect(() => {
    if (!ready) return
    const criteria = views.find(item => item.id === selected)!.criteria
    frame.current?.contentWindow?.postMessage({ logViewer: 'setCriteria', criteria }, window.location.origin)
  }, [ready, selected])

  const source =
    view &&
    `${view.path}embed.html?${new URLSearchParams({
      channel: view.channel,
      title: 'Activity',
      allowOrigin: window.location.origin,
    })}`

  return (
    <div className="app logs-app">
      <AppSidebar mode={null}>
        <div className="sidebar-heading">
          <span>Show</span>
        </div>
        <nav aria-label="Log views">
          {views.map(item => (
            <button
              key={item.id}
              className={`nav-item ${item.id === selected ? 'active' : ''}`}
              aria-current={item.id === selected ? 'true' : undefined}
              disabled={!ready}
              onClick={() => setSelected(item.id)}
            >
              <span>
                <strong>{item.label}</strong>
              </span>
            </button>
          ))}
        </nav>
        <div className="sidebar-heading logs-webhooks-heading">
          <span>Webhooks</span>
          <button
            className="icon-button"
            aria-label="New webhook"
            title="New webhook"
            disabled={!webhooks}
            onClick={() => setEditing('new')}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav aria-label="Webhooks">
          {webhooks?.map(webhook => (
            <button key={webhook.id} className="nav-item" onClick={() => setEditing(webhook)}>
              <WebhookIcon size={16} />
              <span>
                <strong>{webhook.name}</strong>
                <small className={webhook.lastDelivery && !webhook.lastDelivery.ok ? 'error' : undefined}>
                  {!webhook.enabled
                    ? 'Paused'
                    : webhook.lastDelivery && !webhook.lastDelivery.ok
                      ? 'Last delivery failed'
                      : new URL(webhook.url).host}
                </small>
              </span>
            </button>
          ))}
          {webhooks && !webhooks.length && (
            <p className="hint-row muted">Send log events to another service as they happen.</p>
          )}
        </nav>
      </AppSidebar>
      <main className="content logs-content">
        <header className="page-header">
          <div className="page-title">
            <div>
              <h1>Logs</h1>
              <p>Agent status, messages between sessions, errors and changes across your machines.</p>
            </div>
          </div>
        </header>
        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : source ? (
          <iframe ref={frame} className="log-frame" title="Activity log" src={source} />
        ) : (
          <div className="empty page-empty">
            <LoaderCircle className="spin" size={20} />
          </div>
        )}
      </main>
      {editing && (
        <WebhookDialog
          webhook={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={saved => {
            setWebhooks(list => {
              const rest = (list ?? []).filter(item => item.id !== saved.id)
              return editing === 'new'
                ? [...rest, saved]
                : (list ?? []).map(item => (item.id === saved.id ? saved : item))
            })
            setEditing(null)
          }}
          onDeleted={id => {
            setWebhooks(list => (list ?? []).filter(item => item.id !== id))
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
