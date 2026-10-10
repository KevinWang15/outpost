import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Target } from '../shared/session-manager'
import type { SignalEnvironment } from '../shared/signals'
import { connectScript } from './sessions'
import { terminalScript } from './terminal'

export function desktopConnectScript(target: Target, sessionId: string, shell: 'bash' | 'powershell', signals?: SignalEnvironment, platform = process.platform) {
  if (platform !== 'darwin' && platform !== 'win32') return connectScript(target, sessionId, shell, signals)
  const source = new URL('./native-terminal.ts', import.meta.url)
  const runtime = existsSync(source) ? ['--import', import.meta.resolve('tsx'), fileURLToPath(source)] : [fileURLToPath(new URL('./native-terminal.js', import.meta.url))]
  const config = Buffer.from(JSON.stringify({ target, sessionId, signalEnvironment: signals?.OUTPOST_SIGNAL_ENV })).toString('base64')
  return terminalScript({ executable: process.execPath, args: [...runtime, config], label: 'Outpost terminal' }, shell, false)
}
