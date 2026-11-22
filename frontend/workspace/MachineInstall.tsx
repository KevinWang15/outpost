import { useEffect, useState } from 'react'
import { quote } from '../../shared/shell'
import { api } from '../api'
import { CopyField } from '../ui/CopyField'

type DirectSetup = {
  config: { origin: string; targetId: string; endpoint: string; publicKey: string }
  releaseBase: string
}
type RelaySetup = { origin: string; code: string; expiresAt: string }
const installer = '/api/install/machine.sh'
const resume = '~/.outpost/bin/outpost-terminal connect'

export default function MachineInstall({ id, direct }: { id: string; direct: boolean }) {
  const [setup, setSetup] = useState<DirectSetup | RelaySetup | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const relay = setup && 'code' in setup ? setup : null
  const offline = setup && 'config' in setup ? setup : null

  useEffect(() => {
    if (!relay) return
    const timer = setTimeout(
      () => {
        setSetup(null)
        setError('The pairing code expired. Generate a new install command.')
      },
      Math.max(0, Date.parse(relay.expiresAt) - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [relay])

  async function generate() {
    setBusy(true)
    setError('')
    setSetup(null)
    const path = '/targets/' + encodeURIComponent(id)
    try {
      setSetup(
        direct
          ? await api<DirectSetup>(path + '/direct-install', 'POST', {})
          : await api<RelaySetup>(path + '/pair', 'POST', {}),
      )
    } catch (problem) {
      setError((problem as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const origin = offline?.config.origin ?? relay?.origin ?? ''
  const enrollment = 'OUTPOST_ENROLLMENT=' + quote(offline ? JSON.stringify(offline.config) : (relay?.code ?? ''))
  const command =
    'curl -fsSL ' +
    quote(origin + installer) +
    ' | ' +
    enrollment +
    ' sh -s -- ' +
    (direct ? 'direct' : 'relay ' + quote(origin))

  return (
    <section className="card machine-install" aria-label="Machine installation">
      <h2>Install the machine service</h2>
      <p>
        {direct
          ? 'Download once and listen for direct connections. For a machine with restricted outbound access, use the offline option below.'
          : 'Install the connector on your Linux machine so it can reach this Outpost server.'}
      </p>
      {(!setup || relay) && (
        <button type="button" className="button" disabled={busy} onClick={() => void generate()}>
          {busy ? 'Preparing…' : relay ? 'Generate new command' : 'Get install command'}
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {setup && (
        <>
          <p>
            Run as the Linux user who will own the sessions.{' '}
            {relay
              ? 'This command contains a single-use pairing code valid for five minutes.'
              : 'This command downloads the installer and binary. After enrollment the machine opens no connection to Outpost.'}
          </p>
          <CopyField label="Install command" value={command} />
          <p>
            The connector runs in this terminal. To start it again or run it under your service manager, use{' '}
            <code>{resume}</code>.
          </p>
          {offline ? (
            <>
              <p>
                On the machine’s HTTPS endpoint, forward <code>/api/direct/request</code> and WebSocket{' '}
                <code>/api/direct/terminal</code> to <code>127.0.0.1:8844</code>, preserving the Origin header.
              </p>
              <details>
                <summary>Install without outbound access</summary>
                <p>
                  From a connected computer, download the{' '}
                  <a href={installer} download="machine.sh">
                    installer
                  </a>
                  ,{' '}
                  <a href={offline.releaseBase + '/SHA256SUMS'} download>
                    SHA256SUMS
                  </a>{' '}
                  and one Linux binary matching the machine.
                </p>
                <div className="machine-assets">
                  {['x64-glibc', 'arm64-glibc', 'x64-musl', 'arm64-musl'].map(platform => (
                    <a key={platform} href={offline.releaseBase + '/outpost-terminal-linux-' + platform} download>
                      {platform}
                    </a>
                  ))}
                </div>
                <p>
                  Transfer all three files together with their original names. In that directory on the machine, run
                  this command. It uses only local files.
                </p>
                <CopyField
                  label="Offline install command"
                  value={'OUTPOST_ASSET_DIR=. ' + enrollment + ' sh ./machine.sh direct'}
                />
              </details>
            </>
          ) : (
            <details>
              <summary>Prefer a direct connection when available</summary>
              <p>
                Set <code>OUTPOST_DIRECT_ORIGIN</code> to the machine’s client-reachable HTTPS origin before starting
                the connector. Forward WebSocket <code>/api/terminal/direct</code> to <code>127.0.0.1:8844</code> and
                preserve the Origin header. The relay remains available.
              </p>
            </details>
          )}
        </>
      )}
    </section>
  )
}
