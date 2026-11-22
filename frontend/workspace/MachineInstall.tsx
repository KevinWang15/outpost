import { useEffect, useState } from 'react'
import { useAuth } from '../auth/useAuth'
import { directApiPath, directTerminalPath, type DirectEnrollment } from '../../shared/direct'
import { quote } from '../../shared/shell'
import { api } from '../api'
import { CopyField } from '../ui/CopyField'

type DirectSetup = {
  config: DirectEnrollment
  releaseBase: string
}
type RelaySetup = { origin: string; code: string; expiresAt: string }
const installer = '/api/install/machine.sh'
const resume = '~/.outpost/bin/outpost-terminal connect'

export default function MachineInstall({ id, direct }: { id: string; direct: boolean }) {
  const local = useAuth().mode === 'local'
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

  const offlineKit = offline && (
    <>
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
        Transfer the three files and the private enrollment command through a trusted channel. Keep their original
        filenames and run the command in that directory on the machine.
      </p>
      <CopyField
        label="Offline install command"
        value={'OUTPOST_ASSET_DIR=. ' + enrollment + ' sh ./machine.sh direct'}
      />
    </>
  )
  return (
    <section className="card machine-install" aria-label="Machine installation">
      <h2>Install the machine service</h2>
      <p>
        {direct
          ? local
            ? 'Download the offline kit here and transfer it to the Linux machine. The connector accepts incoming connections only.'
            : 'Download once, or use the offline kit for a machine with restricted outbound access.'
          : local
            ? 'Local Outpost accepts only loopback connections. Before using this command, forward this server’s loopback address and port to the same loopback port on the trusted machine. Keep that tunnel open for relay.'
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
              : local
                ? ''
                : 'This command downloads the installer and binary. After enrollment the connector opens no connection to Outpost.'}
          </p>
          {local && offline ? offlineKit : <CopyField label="Install command" value={command} />}
          {!local && offline && (
            <details>
              <summary>Install without outbound access</summary>
              {offlineKit}
            </details>
          )}
          <p>
            The connector runs in this terminal. To start it again or run it under your service manager, use{' '}
            <code>{resume}</code>.
          </p>
          <p>
            {direct
              ? 'Configure the machine’s HTTPS endpoint for direct access'
              : 'To enable direct access, set the machine HTTPS address in Edit machine'}
            . Forward <code>{directApiPath}</code> and WebSocket <code>{directTerminalPath}</code> from that address to{' '}
            <code>127.0.0.1:8844</code>, preserving the Origin header.
          </p>
        </>
      )}
    </section>
  )
}
