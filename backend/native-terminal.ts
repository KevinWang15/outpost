import type { Target } from '../shared/session-manager'
import { SessionClient, sessionAttachOperation } from './sessions'
import { transportFor } from './transport'
import { readNativeClipboard } from './native-clipboard'
import { loadNativePty, nativeSession } from './native-session'

// Internal entry point, launched with the same Node runtime as local Outpost.
// Configuration is encoded data, and includes only the signal environment path.
try {
  const config: { target: Target; sessionId: string; signalEnvironment?: string } = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
  const service = new SessionClient()
  const operation = sessionAttachOperation(config.target, config.sessionId, config.signalEnvironment ? { OUTPOST_SIGNAL_ENV: config.signalEnvironment } : undefined)
  process.exitCode = await nativeSession(transportFor(config.target).attach(operation), {
    pty: await loadNativePty(), readClipboard: readNativeClipboard,
    upload: (image, signal) => service.pasteImage(config.target, config.sessionId, image, signal),
  })
} catch (error) {
  process.stderr.write(`Outpost terminal: ${(error as Error).message}\n`)
  process.exitCode = 1
}
