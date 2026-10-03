import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type {
  Installation,
  InstallationEvent,
  InstallationPlan,
  SoftwareId,
} from '../shared/session-manager'
import { softwareLabels } from '../shared/session-manager'
import { api, streamInstallation } from './api'
import { Modal } from './ui'

const ScriptEditor = lazy(() => import('./ScriptEditor'))
const logLimit = 256 * 1024
export default function InstallModal({
  targetId,
  softwareId,
  installation,
  onClose,
}: {
  targetId: string
  softwareId: SoftwareId
  installation?: Installation
  onClose: () => void
}) {
  const [plan, setPlan] = useState<InstallationPlan | null>(null),
    [script, setScript] = useState('')
  const [job, setJob] = useState<Installation | null>(installation ?? null)
  const [loading, setLoading] = useState(!installation),
    [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(''),
    [log, setLog] = useState(''),
    [streaming, setStreaming] = useState(false)
  const output = useRef<HTMLPreElement>(null),
    lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    if (!installation)
      api<InstallationPlan>(
        `/targets/${targetId}/software/${softwareId}/script`,
        'GET',
        undefined,
        controller.signal,
      )
        .then((result) => {
          setPlan(result)
          setScript(result.script)
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message)
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false)
        })
    return () => controller.abort()
  }, [targetId, softwareId, installation])
  const jobId = job?.id
  useEffect(() => {
    if (!jobId) return
    const controller = new AbortController()
    const start = setTimeout(() => {
      setStreaming(true)
      setLog('')
      setError('')
      let complete = false
      streamInstallation(
        targetId,
        jobId,
        (event: InstallationEvent) => {
          if (event.type === 'output')
            setLog((previous) => {
              const next = previous + event.text
              return next.length > logLimit
                ? '[Earlier output omitted]\n' + next.slice(-logLimit)
                : next
            })
          else {
            setJob(event.installation)
            if (event.type === 'complete') complete = true
          }
        },
        controller.signal,
      )
        .then(() => {
          if (!complete && !controller.signal.aborted)
            setError(
              'The log stream disconnected. Reopen the installation log to reconnect.',
            )
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(error.message)
        })
        .finally(() => {
          if (!controller.signal.aborted) setStreaming(false)
        })
    }, 0)
    return () => {
      clearTimeout(start)
      controller.abort()
    }
  }, [targetId, jobId])
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight
  }, [log])
  async function submit() {
    setSubmitting(true)
    setError('')
    try {
      const installed = await api<Installation>(
        `/targets/${targetId}/installations`,
        'POST',
        { softwareId, script },
        lifetime.current?.signal,
      )
      setJob(installed)
    } catch (error) {
      if (!lifetime.current?.signal.aborted) setError((error as Error).message)
    } finally {
      setSubmitting(false)
    }
  }
  return (
    <Modal
      title={`${job ? 'Installation log' : 'Install'} · ${softwareLabels[softwareId]}`}
      subtitle={
        job
          ? 'The installation runs on this instance. You can close this window and reopen the log while it runs.'
          : 'Review or edit this POSIX shell script. Submitting runs exactly this script on the instance as its execution user.'
      }
      onClose={onClose}
      className="install-modal"
    >
      {loading ? (
        <p role="status">Preparing installation script…</p>
      ) : !job && plan ? (
        <>
          <div className="script-heading">
            <strong>Installation script</strong>
            <span>Shell · editable</span>
          </div>
          <Suspense fallback={<p role="status">Loading editor…</p>}>
            <ScriptEditor initialValue={plan.script} onChange={setScript} />
          </Suspense>
        </>
      ) : null}
      {job && (
        <>
          <p className={`installation-status ${job.status}`} role="status">
            {job.status === 'running'
              ? 'Installing…'
              : job.status === 'succeeded'
                ? 'Script completed successfully. Close to check the installed software.'
                : `Installation failed. ${job.error ?? ''}`}
          </p>
          <pre
            className="installation-log"
            aria-label="Installation output"
            ref={output}
          >
            {log ||
              (streaming
                ? 'Waiting for output…'
                : 'Connecting to installation log…')}
          </pre>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          {job ? 'Close' : 'Cancel'}
        </button>
        {!job && (
          <button
            className="button primary"
            disabled={loading || !plan || !script.trim() || submitting}
            onClick={() => void submit()}
          >
            {submitting ? 'Starting…' : 'Run installation'}
          </button>
        )}
      </div>
    </Modal>
  )
}
