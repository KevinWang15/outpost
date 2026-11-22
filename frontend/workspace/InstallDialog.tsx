import { useEffect, useRef, useState } from 'react'
import type { Installation, InstallationEvent } from '../../shared/model'
import { streamInstallation } from '../api'
import { Dialog } from '../ui/Dialog'

const logLimit = 256 * 1024
export default function InstallDialog({
  targetId,
  installation,
  onClose,
}: {
  targetId: string
  installation: Installation
  onClose: () => void
}) {
  const [job, setJob] = useState(installation)
  const [error, setError] = useState(''),
    [log, setLog] = useState('')
  const output = useRef<HTMLPreElement>(null)
  const jobId = installation.id
  useEffect(() => {
    if (!jobId) return
    const controller = new AbortController()
    let complete = false
    streamInstallation(
      targetId,
      jobId,
      (event: InstallationEvent) => {
        if (event.type === 'output')
          setLog(previous => {
            const next = previous + event.text
            return next.length > logLimit ? '[Earlier output omitted]\n' + next.slice(-logLimit) : next
          })
        else {
          setJob(event.installation)
          complete ||= event.type === 'complete'
        }
      },
      controller.signal,
    )
      .then(() => {
        if (!complete && !controller.signal.aborted)
          setError('The log stream disconnected. Reopen the log to reconnect.')
      })
      .catch(problem => {
        if (!controller.signal.aborted) setError(problem.message)
      })
    return () => controller.abort()
  }, [targetId, jobId])
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight
  }, [log])
  return (
    <Dialog
      size="large"
      title="Machine setup log"
      onClose={onClose}
      footer={
        <button className="button" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className={`installation-status ${job.status}`} role="status">
        {job.status === 'running'
          ? 'Installing…'
          : job.status === 'succeeded'
            ? 'The machine service and selected tools are ready.'
            : `The installation failed. ${job.error ?? ''}`}
      </p>
      <pre className="log" aria-label="Installation output" ref={output}>
        {log || 'Waiting for output…'}
      </pre>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  )
}
