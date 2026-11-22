import { useState } from 'react'
import { Check, ChevronDown, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { softwareLabel, type Installation, type SoftwareId, type Target } from '../../shared/model'
import type { useSoftware } from './useSoftware'
import InstallDialog from './InstallDialog'
import { shortVersion } from './labels'

/** Required software, checked live on the machine. Collapsed to one line when everything is ready. */
export default function SoftwarePanel({
  target,
  state,
  onInstalled,
}: {
  target: Target
  state: ReturnType<typeof useSoftware>
  onInstalled: () => void
}) {
  const { report, checking, error, refresh } = state
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [install, setInstall] = useState<{ softwareId: SoftwareId; installation?: Installation } | null>(null)
  const manualInstall = target.kind === 'direct' || target.kind === 'paired'
  const software = (report?.software ?? []).filter(item => target.kind !== 'direct' || item.id !== 'claude-agent-acp')
  const required = software.filter(item => item.id !== 'claude-agent-acp')
  const problems = required.filter(item => item.status !== 'installed')
  const ready = Boolean(report) && !problems.length
  const open = expanded ?? (!checking && (!!error || problems.length > 0))
  const job = report?.installation
  const summary =
    checking && !report
      ? 'Checking…'
      : error
        ? 'Could not check it'
        : ready
          ? required.map(item => `${softwareLabel(item.id)} ${shortVersion(item.version)}`).join(' · ')
          : `${problems.length} ${problems.length === 1 ? 'requirement needs' : 'requirements need'} attention`
  return (
    <section
      className={`card software ${ready ? 'ready' : error || problems.length ? 'attention' : ''}`}
      aria-label="Required software"
    >
      <div className="software-summary">
        <button className="software-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>
          {checking ? (
            <LoaderCircle className="spin" size={16} />
          ) : ready ? (
            <Check size={16} />
          ) : (
            <TriangleAlert size={16} />
          )}
          <strong>Required software</strong>
          {ready && <span className="software-ready">Ready</span>}
          <span>{summary}</span>
          <ChevronDown size={15} className="chevron" />
        </button>
        <button
          className="icon-button"
          aria-label="Check software again"
          title="Check again"
          disabled={checking}
          onClick={() => {
            setExpanded(null)
            void refresh()
          }}
        >
          <RefreshCw size={15} className={checking ? 'spin' : ''} />
        </button>
      </div>
      {open && (
        <div className="software-details">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {report && (
            <ul>
              {software.map(item => (
                <li key={item.id} className={item.status}>
                  {item.status === 'installed' ? <Check size={15} /> : <TriangleAlert size={15} />}
                  <strong>
                    {softwareLabel(item.id)}
                    {item.id === 'claude-agent-acp' && ' (for sessions started in Chat)'}
                  </strong>
                  <span>
                    {item.status === 'missing'
                      ? 'Not installed'
                      : item.status === 'broken'
                        ? item.detail
                        : shortVersion(item.version)}
                  </span>
                  <code title={item.path ?? ''}>{item.path ?? ''}</code>
                  {item.status !== 'installed' && !manualInstall && (
                    <button
                      className="button small"
                      disabled={job?.status === 'running'}
                      onClick={() => setInstall({ softwareId: item.id })}
                    >
                      Install…
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {job && (
            <p className="installation-line" role="status">
              {softwareLabel(job.softwareId)} installation{' '}
              {job.status === 'running' ? 'is running' : job.status === 'succeeded' ? 'finished' : 'failed'}.
              <button className="link" onClick={() => setInstall({ softwareId: job.softwareId, installation: job })}>
                View log
              </button>
            </p>
          )}
          {manualInstall && problems.length > 0 && (
            <p className="hint">Install the missing tools on this machine, then check again.</p>
          )}
          <p className="hint">Checked in the machine’s login shell. Coding tools sign in when you first connect.</p>
        </div>
      )}
      {install && (
        <InstallDialog
          targetId={target.id}
          {...install}
          onClose={() => {
            setInstall(null)
            setExpanded(null)
            void refresh()
            onInstalled()
          }}
        />
      )}
    </section>
  )
}
