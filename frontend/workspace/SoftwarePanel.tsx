import { useState } from 'react'
import { Check, ChevronDown, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { softwareLabel, type Target } from '../../shared/model'
import type { useSoftware } from './useSoftware'
import InstallDialog from './InstallDialog'
import { shortVersion } from './labels'

export default function SoftwarePanel({
  target,
  state,
  onInstalled,
}: {
  target: Target
  state: ReturnType<typeof useSoftware>
  onInstalled: () => void
}) {
  const { report, checking, error, refresh, job, setup } = state
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [showLog, setShowLog] = useState(false)
  const software = report?.software ?? []
  const missing = software.filter(item => item.status !== 'installed')
  const running = job?.status === 'running'
  const ready = !running && !error && !!report && !missing.length
  const open = expanded ?? (running || !!error || missing.length > 0 || job?.status === 'failed')
  return (
    <section className={`card software ${ready ? 'ready' : 'attention'}`} aria-label="Required software">
      <div className="software-summary">
        <button className="software-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>
          {checking || running ? (
            <LoaderCircle className="spin" size={16} />
          ) : ready ? (
            <Check size={16} />
          ) : (
            <TriangleAlert size={16} />
          )}
          <strong>Required software</strong>
          <span>{running ? 'Setting up…' : checking ? 'Checking…' : ready ? 'Ready' : 'Needs attention'}</span>
          <ChevronDown size={15} className="chevron" />
        </button>
        <button
          className="icon-button"
          aria-label="Check software again"
          disabled={checking}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      {open && (
        <div className="software-details">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {job?.error && <p className="error">{job.error}</p>}
          {!!software.length && (
            <ul>
              {software.map(item => (
                <li key={item.id} className={item.status}>
                  {item.status === 'installed' ? <Check size={15} /> : <TriangleAlert size={15} />}
                  <strong>{softwareLabel(item.id)}</strong>
                  <span>{item.detail || shortVersion(item.version)}</span>
                  <code title={item.path ?? ''}>{item.path ?? ''}</code>
                </li>
              ))}
            </ul>
          )}
          {job && (
            <button className="link" onClick={() => setShowLog(true)}>
              View setup log
            </button>
          )}
          {!running && (!ready || job?.status === 'failed') && (
            <button className="button small" onClick={() => void setup()}>
              Set up required software
            </button>
          )}
        </div>
      )}
      {showLog && job && (
        <InstallDialog
          targetId={target.id}
          installation={job}
          onClose={() => {
            setShowLog(false)
            void refresh()
            onInstalled()
          }}
        />
      )}
    </section>
  )
}
