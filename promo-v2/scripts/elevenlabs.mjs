// Minimal ElevenLabs client. The key is read from ELEVENLABS_API_KEY only and
// is never written to disk, logs, or generated files.
function apiKey() {
  const key = process.env.ELEVENLABS_API_KEY?.trim()
  if (!key) throw new Error('Set ELEVENLABS_API_KEY in the environment to record new audio.')
  return key
}

export async function elevenlabs(path, body) {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'xi-api-key': apiKey(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(600_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`ElevenLabs ${path.split('?')[0]} failed: HTTP ${response.status} ${detail.slice(0, 400)}`)
  }
  return response
}
