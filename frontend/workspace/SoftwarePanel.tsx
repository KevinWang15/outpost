import { useState } from 'react'
import { Check, ChevronDown, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import type { Installation, SoftwareId } from '../../shared/model'
import type { useSoftware } from './useSoftware'
import InstallDialog from './InstallDialog'
import { shortVersion, softwareLabel } from './labels'

/** Required software, checked live on the target. Collapsed to one line when everything is ready. */
export default function SoftwarePanel({ targetId, state, onInstalled }: {
  targetId: string
  state: ReturnType<typeof useSoftware>
  onInstalled: () => void
}) {
  const { report, checking, error, refresh } = state
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const [install, setInstall] = useState<{ softwareId: SoftwareId; installation?: Installation } | null>(null)
  const problems = report?.software.filter(item => item.status !== 'installed') ?? []
  const ready = Boolean(report) && !problems.length
  const open = expanded ?? (!checking && (!!error || problems.length > 0))
  const job = report?.installation
  const summary = checking && !report ? 'Checking required software…'
    : error ? 'Could not check required software'
      : ready ? report!.software.map(item => `${softwareLabel(item.id)} ${shortVersion(item.version)}`).join(' · ')
        : `${problems.length} ${problems.length === 1 ? 'requirement needs' : 'requirements need'} attention`
  return <section className={`card software ${ready ? 'ready' : error || problems.length ? 'attention' : ''}`} aria-label="Required software">
    <div className="software-summary">
      <button className="software-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>
        {checking ? <LoaderCircle className="spin" size={16} /> : ready ? <Check size={16} /> : <TriangleAlert size={16} />}
        <strong>{ready ? 'Ready' : 'Software'}</strong>
        <span>{summary}</span>
        <ChevronDown size={15} className="chevron" />
      </button>
      <button className="icon-button" aria-label="Check software again" title="Check again" disabled={checking} onClick={() => { setExpanded(null); void refresh() }}>
        <RefreshCw size={15} className={checking ? 'spin' : ''} />
      </button>
    </div>
    {open && <div className="software-details">
      {error && <p className="error" role="alert">{error}</p>}
      {report && <ul>
        {report.software.map(item => <li key={item.id} className={item.status}>
          {item.status === 'installed' ? <Check size={15} /> : <TriangleAlert size={15} />}
          <strong>{softwareLabel(item.id)}</strong>
          <span>{item.status === 'missing' ? 'Not installed' : item.status === 'broken' ? item.detail : shortVersion(item.version)}</span>
          <code title={item.path ?? ''}>{item.path ?? ''}</code>
          {item.status !== 'installed' && <button className="button small" disabled={job?.status === 'running'}
            onClick={() => setInstall({ softwareId: item.id })}>Install…</button>}
        </li>)}
      </ul>}
      {job && <p className="installation-line" role="status">
        {softwareLabel(job.softwareId)} installation {job.status === 'running' ? 'is running' : job.status === 'succeeded' ? 'finished' : 'failed'}.
        <button className="link" onClick={() => setInstall({ softwareId: job.softwareId, installation: job })}>View log</button>
      </p>}
      <p className="hint">Checked on the target’s login shell. Coding tools sign in when you first connect.</p>
    </div>}
    {install && <InstallDialog targetId={targetId} {...install} onClose={() => { setInstall(null); setExpanded(null); void refresh(); onInstalled() }} />}
  </section>
}
