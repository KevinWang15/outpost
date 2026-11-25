import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { Check, ChevronDown, CircleDashed, Download, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { harnesses } from '../../shared/harnesses'
import {
  coreSoftware,
  harnessSoftware,
  softwareLabel,
  type SoftwareId,
  type SoftwareStatus,
  type Target,
} from '../../shared/model'
import { ToolIcon } from '../ui/ToolIcon'
import type { useSoftware } from './useSoftware'
import InstallDialog from './InstallDialog'
import { shortVersion } from './labels'

function describeSetup(ids: readonly SoftwareId[]) {
  const visible = ids.filter(id => !(id === 'claude-agent-acp' && ids.includes('claude')))
  if (!visible.length || visible.every(id => coreSoftware.includes(id))) return 'machine software'
  return visible.map(softwareLabel).join(', ')
}

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
  const byId = new Map<SoftwareId, SoftwareStatus>(software.map(item => [item.id, item]))
  const coreItems = coreSoftware.map(id => byId.get(id)).filter((item): item is SoftwareStatus => Boolean(item))
  const coreMissing = coreItems.filter(item => item.status !== 'installed')
  const harnessRows = harnesses
    .map(harness => ({
      harness,
      item: byId.get(harness.id),
    }))
    .filter((entry): entry is { harness: (typeof harnesses)[number]; item: SoftwareStatus } => Boolean(entry.item))
  const availableHarnesses = harnessRows.filter(entry => entry.item.status === 'installed')
  const unavailableHarnesses = harnessRows.filter(entry => entry.item.status !== 'installed')
  const orderedHarnesses = [...availableHarnesses, ...unavailableHarnesses]
  const claudeAdapter = byId.get('claude-agent-acp')
  const running = job?.status === 'running'
  const needsCoreSetup = coreMissing.length > 0 || (!!error && !report && target.kind !== 'outbound')
  const prevJobStatus = useRef(job?.status)
  const notifyInstalled = useEffectEvent(onInstalled)
  useEffect(() => {
    const previous = prevJobStatus.current
    prevJobStatus.current = job?.status
    if (previous === 'running' && job?.status === 'succeeded') notifyInstalled()
  }, [job?.status])
  const ready = !running && !error && !!report && coreMissing.length === 0 && availableHarnesses.length > 0
  const open =
    expanded ??
    (running ||
      !!error ||
      coreMissing.length > 0 ||
      (report !== null && availableHarnesses.length === 0) ||
      job?.status === 'failed')

  const summary = running
    ? `Setting up ${describeSetup(job.software)}…`
    : checking
      ? 'Checking…'
      : error || coreMissing.length > 0 || job?.status === 'failed'
        ? 'Needs attention'
        : availableHarnesses.length === 0
          ? 'No coding tools installed'
          : `Ready · ${availableHarnesses.length} of ${harnesses.length} coding tools available`

  return (
    <section className={`card software ${ready ? 'ready' : 'attention'}`} aria-label="Software">
      <div className="software-summary">
        <button className="software-toggle" aria-expanded={open} onClick={() => setExpanded(!open)}>
          {checking || running ? (
            <LoaderCircle className="spin" size={16} />
          ) : ready ? (
            <Check size={16} />
          ) : (
            <TriangleAlert size={16} />
          )}
          <strong>Software</strong>
          <span>{summary}</span>
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
          {running && (
            <div className="software-banner" role="status">
              <LoaderCircle className="spin" size={15} />
              <span>Setting up {describeSetup(job.software)}…</span>
              <button className="link" onClick={() => setShowLog(true)}>
                View setup log
              </button>
            </div>
          )}
          {!!orderedHarnesses.length && (
            <div className="software-group">
              <h3 className="software-heading">Coding tools</h3>
              <ul>
                {orderedHarnesses.map(({ harness, item }) => {
                  const installed = item.status === 'installed'
                  const settingUpTool = running && job.software.includes(harness.id)
                  const adapterMissing =
                    harness.id === 'claude' && installed && claudeAdapter && claudeAdapter.status !== 'installed'
                  const settingUpAdapter = running && job.software.includes('claude-agent-acp') && !settingUpTool
                  return (
                    <li key={harness.id} className={item.status}>
                      {installed ? (
                        <Check size={15} />
                      ) : item.status === 'broken' ? (
                        <TriangleAlert size={15} />
                      ) : (
                        <CircleDashed size={15} />
                      )}
                      <strong className="software-name">
                        <ToolIcon tool={harness.id} size={14} />
                        {harness.label}
                      </strong>
                      <span>
                        {installed
                          ? shortVersion(item.version) || 'Installed'
                          : item.status === 'broken'
                            ? item.detail
                            : 'Not installed'}
                      </span>
                      <code title={item.path ?? ''}>{item.path ?? ''}</code>
                      <div className="software-row-action">
                        {installed ? (
                          adapterMissing ? (
                            <button
                              className="button small"
                              disabled={running}
                              title={claudeAdapter.detail ?? 'Needed for Claude Code sessions in Chat'}
                              onClick={() => void setup(['claude-agent-acp'])}
                            >
                              {settingUpAdapter ? (
                                <>
                                  <LoaderCircle className="spin" size={13} />
                                  Setting up…
                                </>
                              ) : (
                                <>
                                  <Download size={13} />
                                  Set up chat adapter
                                </>
                              )}
                            </button>
                          ) : (
                            <span className="software-status available">Available</span>
                          )
                        ) : (
                          <button
                            className="button small"
                            aria-label={`Set up ${harness.label}`}
                            disabled={running}
                            onClick={() => void setup(harnessSoftware(harness.id))}
                          >
                            {settingUpTool ? (
                              <>
                                <LoaderCircle className="spin" size={13} />
                                Setting up…
                              </>
                            ) : (
                              <>
                                <Download size={13} />
                                Set up
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {!!coreItems.length && (
            <div className="software-group">
              <h3 className="software-heading">Machine software</h3>
              <ul>
                {coreItems.map(item => (
                  <li key={item.id} className={item.status === 'installed' ? 'installed' : 'broken'}>
                    {item.status === 'installed' ? <Check size={15} /> : <TriangleAlert size={15} />}
                    <strong>{softwareLabel(item.id)}</strong>
                    <span>{item.detail || shortVersion(item.version)}</span>
                    <code title={item.path ?? ''}>{item.path ?? ''}</code>
                    <div className="software-row-action">
                      {item.status === 'installed' && <span className="software-status available">Ready</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {((job && !running) || (!running && needsCoreSetup)) && (
            <div className="software-actions">
              {!running && needsCoreSetup && (
                <button className="button primary small" onClick={() => void setup()}>
                  Set up machine software
                </button>
              )}
              {job && !running && (
                <button className="link" onClick={() => setShowLog(true)}>
                  View setup log
                </button>
              )}
            </div>
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
