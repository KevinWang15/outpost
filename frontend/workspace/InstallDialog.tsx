import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Installation, InstallationEvent, InstallationPlan, SoftwareId } from '../../shared/model'
import { api, streamInstallation } from '../api'
import { Dialog } from '../ui/Dialog'
import { softwareLabel } from './labels'

const ScriptEditor = lazy(() => import('./ScriptEditor'))
const logLimit = 256 * 1024

/** Review an editable install script, run exactly that script, and follow its log. */
export default function InstallDialog({ targetId, softwareId, installation, onClose }: {
  targetId: string; softwareId: SoftwareId; installation?: Installation; onClose: () => void
}) {
  const [plan, setPlan] = useState<InstallationPlan | null>(null), [script, setScript] = useState('')
  const [job, setJob] = useState<Installation | null>(installation ?? null)
  const [loading, setLoading] = useState(!installation), [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(''), [log, setLog] = useState('')
  const output = useRef<HTMLPreElement>(null), lifetime = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    if (!installation) api<InstallationPlan>(`/targets/${targetId}/software/${softwareId}/script`, 'GET', undefined, controller.signal)
      .then(result => { setPlan(result); setScript(result.script) })
      .catch(problem => { if (!controller.signal.aborted) setError(problem.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [targetId, softwareId, installation])
  const jobId = job?.id
  useEffect(() => {
    if (!jobId) return
    const controller = new AbortController()
    let complete = false
    streamInstallation(targetId, jobId, (event: InstallationEvent) => {
      if (event.type === 'output') setLog(previous => {
        const next = previous + event.text
        return next.length > logLimit ? '[Earlier output omitted]\n' + next.slice(-logLimit) : next
      })
      else { setJob(event.installation); complete ||= event.type === 'complete' }
    }, controller.signal)
      .then(() => { if (!complete && !controller.signal.aborted) setError('The log stream disconnected. Reopen the log to reconnect.') })
      .catch(problem => { if (!controller.signal.aborted) setError(problem.message) })
    return () => controller.abort()
  }, [targetId, jobId])
  useEffect(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight }, [log])
  async function submit() {
    setSubmitting(true); setError('')
    try { setJob(await api<Installation>(`/targets/${targetId}/installations`, 'POST', { softwareId, script }, lifetime.current?.signal)) }
    catch (problem) { if (!lifetime.current?.signal.aborted) setError((problem as Error).message) }
    finally { setSubmitting(false) }
  }
  return <Dialog size="large" title={`${job ? 'Installing' : 'Install'} ${softwareLabel(softwareId)}`} onClose={onClose}
    description={job ? 'The installation keeps running if you close this dialog.' : 'Review or edit the script. Outpost runs exactly this script on the target.'}
    footer={<>
      <button className="button" onClick={onClose}>{job ? 'Close' : 'Cancel'}</button>
      {!job && <button className="button primary" disabled={loading || !plan || !script.trim() || submitting} onClick={() => void submit()}>{submitting ? 'Starting…' : 'Run script'}</button>}
    </>}>
    {loading && <p role="status" className="muted">Preparing the script…</p>}
    {!job && plan && <Suspense fallback={<p role="status" className="muted">Loading editor…</p>}><ScriptEditor initialValue={plan.script} onChange={setScript} /></Suspense>}
    {job && <>
      <p className={`installation-status ${job.status}`} role="status">
        {job.status === 'running' ? 'Installing…' : job.status === 'succeeded' ? 'The script finished. Close to check the software again.' : `The installation failed. ${job.error ?? ''}`}
      </p>
      <pre className="log" aria-label="Installation output" ref={output}>{log || 'Waiting for output…'}</pre>
    </>}
    {error && <p className="error" role="alert">{error}</p>}
  </Dialog>
}
