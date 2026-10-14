import { app, dialog, shell } from 'electron'
import { desktopReleases } from '../../shared/desktop'

let checking = false
/** Unsigned previews update by reinstalling. Never download or execute remote code here. */
export async function checkUpdates() {
  if (checking) return
  checking = true
  try {
    const response = await fetch('https://api.github.com/repos/KevinWang15/outpost/releases?per_page=50', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error('Could not check releases.')
    const releases: unknown = await response.json()
    if (!Array.isArray(releases)) throw new Error('Invalid release metadata.')
    const versions = releases
      .flatMap(release => {
        if (!release || release.draft || typeof release.tag_name !== 'string') return []
        const match = /^desktop-v(\d+\.\d+\.\d+)$/.exec(release.tag_name)
        return match ? [match[1]] : []
      })
      .sort((a, b) => compare(b, a))
    const latest = versions[0]
    const available = latest && compare(latest, app.getVersion()) > 0
    const result = await dialog.showMessageBox({
      type: 'info',
      title: 'Outpost updates',
      message: available
        ? `Outpost ${latest} is available`
        : latest
          ? 'Outpost is up to date'
          : 'No desktop releases are published yet',
      detail: available
        ? 'Download and install the new preview. Your remote sessions keep running while the app is closed.'
        : `You are running Outpost ${app.getVersion()}.`,
      buttons: available ? ['Download update', 'Later'] : ['OK'],
      cancelId: available ? 1 : 0,
    })
    if (available && result.response === 0) await shell.openExternal(`${desktopReleases}/tag/desktop-v${latest}`)
  } catch {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Outpost updates',
      message: 'Could not check for updates.',
      detail: 'Check your connection and try again, or visit Outpost’s GitHub releases.',
      buttons: ['OK'],
    })
  } finally {
    checking = false
  }
}
function compare(a: string, b: string) {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}
