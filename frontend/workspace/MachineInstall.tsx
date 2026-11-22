import { useEffect, useState } from 'react'
import { quote } from '../../shared/shell'
import { api } from '../api'
import { CopyField } from '../ui/CopyField'

type Enrollment = { code: string; expiresAt: string; origin: string }

export default function MachineInstall({ id, onReady }: { id: string; onReady: (ready: boolean) => void }) {
  const [setup, setSetup] = useState<Enrollment | null>(null)
  const [enrolled, setEnrolled] = useState(false)
  const [connected, setConnected] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const path = '/targets/' + encodeURIComponent(id) + '/enrollment'
  useEffect(() => {
    const controller = new AbortController()
    async function check() {
      try {
        const result = await api<{ enrolled: boolean; connected: boolean }>(path, 'GET', undefined, controller.signal)
        if (!controller.signal.aborted) {
          setEnrolled(result.enrolled)
          setConnected(result.connected)
          onReady(result.connected)
          if (result.connected && setup) setSetup(null)
        }
      } catch (problem) {
        if (!controller.signal.aborted) setError((problem as Error).message)
      }
    }
    void check()
    const poll = setInterval(
      () => {
        if (document.visibilityState === 'visible') void check()
      },
      connected ? 15_000 : 2500,
    )
    return () => {
      controller.abort()
      if (poll) clearInterval(poll)
    }
  }, [path, setup, connected, onReady])
  useEffect(() => {
    if (!setup) return
    const timer = setTimeout(
      () => {
        setSetup(null)
        setError('The command expired. Generate a new one to enroll this machine.')
      },
      Math.max(0, Date.parse(setup.expiresAt) - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [setup])

  async function generate() {
    setBusy(true)
    setError('')
    try {
      setSetup(await api<Enrollment>(path, 'POST'))
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (connected) return null
  return (
    <section className="card machine-install" aria-label="Machine installation">
      <h2>{enrolled ? 'Waiting for the machine' : 'Run setup on the machine'}</h2>
      {enrolled ? (
        <p>
          The machine is enrolled. Check <code>systemctl status outpost-machine</code> or{' '}
          <code>rc-service outpost-machine status</code> on the machine. To repair its service, run the setup command
          again under the same account.
        </p>
      ) : (
        <p>
          Open a shell as the Linux user who will run the coding agents. This command installs the machine service and
          starts its outbound connection to this Outpost server at boot.
        </p>
      )}
      <button type="button" className="button" disabled={busy} onClick={() => void generate()}>
        {busy ? 'Preparing…' : setup ? 'Generate new command' : 'Get install command'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {setup && (
        <>
          <p>
            This private command is valid for five minutes. Setup needs systemd or OpenRC and permission to install a
            system service.
          </p>
          <CopyField
            label="Install command"
            value={
              'curl -fsS ' +
              quote(setup.origin + '/api/install/machine.sh') +
              ' | OUTPOST_ENROLLMENT=' +
              quote(setup.code) +
              ' sh -s -- ' +
              quote(setup.origin) +
              ' ' +
              quote(id)
            }
          />
        </>
      )}
    </section>
  )
}
