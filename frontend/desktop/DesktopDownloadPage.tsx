import { desktopReleases } from '../../shared/desktop'
import { desktopConnectUrl } from '../../shared/desktopAuth'
import { pagePaths } from '../../shared/pages'

export default function DesktopDownloadPage() {
  const macInstaller = import.meta.env.VITE_OUTPOST_MAC_ARM64_INSTALLER
  return (
    <main className="desktop-setup">
      <img src="/outpost.svg" width="48" height="48" alt="" />
      <h1>Outpost Desktop</h1>
      <p>Open local shells and managed Outpost sessions in native tabs and split panes.</p>
      {macInstaller && (
        <a className="button primary" href={macInstaller} download>
          Download for Mac with Apple silicon
        </a>
      )}
      <a
        className={macInstaller ? 'button' : 'button primary'}
        href={desktopReleases}
        target="_blank"
        rel="noopener noreferrer"
      >
        {macInstaller ? 'Browse published releases' : 'Download for macOS or Windows'}
      </a>
      <a className="button" href={desktopConnectUrl(window.location.origin)}>
        Connect the installed app to this server
      </a>
      <ol>
        <li>On macOS, drag Outpost into Applications. On Windows, run the installer.</li>
        <li>
          Open Outpost once, then return here and choose <strong>Connect → Outpost Desktop</strong> for a session.
        </li>
        <li>Allow the browser to open Outpost, and confirm this server in the app on your first connection.</li>
      </ol>
      <p className="hint">
        These are unsigned previews. macOS may require System Settings → Privacy &amp; Security → Open Anyway after the
        first launch attempt. Windows may show a SmartScreen warning. Check the downloaded release before continuing.
      </p>
      <p>
        Sign in through your browser and approve app access for 30 days. Connect several servers in the app and search
        all their sessions. The app never handles your password.
      </p>
      <a href={pagePaths.workspace}>Back to Outpost</a>
    </main>
  )
}
