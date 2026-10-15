import { desktopReleases } from '../../shared/desktop'
import { pagePaths } from '../../shared/pages'

export default function DesktopDownloadPage() {
  return (
    <main className="desktop-setup">
      <img src="/outpost.svg" width="48" height="48" alt="" />
      <h1>Outpost Desktop</h1>
      <p>
        Your coding sessions in one workspace, with tabs, split panes, desktop notifications, and the same terminal as
        your browser.
      </p>
      <a className="button primary" href={desktopReleases} target="_blank" rel="noopener noreferrer">
        Download for macOS or Windows
      </a>
      <ol>
        <li>
          Choose the newest <strong>Outpost Desktop</strong> release. For a Mac, download the Apple silicon (arm64) or
          Intel (x64) DMG. For Windows, download the x64 installer.
        </li>
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
        The app uses your existing sign-in through a temporary connection ticket. Chrome, Python, and WSL are not
        required on your computer.
      </p>
      <p>
        Enable Outpost in system notification settings to receive alerts. Use Help → Check for updates in the app to
        install newer previews.
      </p>
      <a href={pagePaths.workspace}>Back to Outpost</a>
    </main>
  )
}
