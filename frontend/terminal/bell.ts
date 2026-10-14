import type { Terminal } from '@xterm/xterm'

/** Use the parser's bell event: BEL also terminates OSC sequences, where it
 * must not ring. Browser attention and sound belong to this connection. */
export function attachBell(term: Terminal, changed: (ringing: boolean) => void) {
  let audio: AudioContext | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSound = -Infinity
  const active = () => document.visibilityState === 'visible' && document.hasFocus()
  const acknowledge = () => {
    clearTimeout(timer)
    changed(false)
  }
  const prepareSound = () => {
    try {
      audio ??= new AudioContext()
      if (audio.state === 'suspended') void audio.resume().catch(() => {})
    } catch {
      // Audio may be unavailable or blocked; the visual bell still works.
    }
  }
  const playSound = () => {
    prepareSound()
    if (!audio || audio.state !== 'running' || performance.now() - lastSound < 1000) return
    try {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      const now = audio.currentTime
      oscillator.frequency.setValueAtTime(880, now)
      gain.gain.setValueAtTime(0, now)
      gain.gain.linearRampToValueAtTime(0.12, now + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2)
      oscillator.connect(gain)
      gain.connect(audio.destination)
      oscillator.onended = () => {
        oscillator.disconnect()
        gain.disconnect()
      }
      oscillator.start(now)
      oscillator.stop(now + 0.22)
      lastSound = performance.now()
    } catch {
      // Audio failures must never interrupt terminal output.
    }
  }
  const interact = () => {
    // Unlock sound during a browser gesture, before a later background bell.
    prepareSound()
    acknowledge()
  }
  const returned = () => {
    if (active()) acknowledge()
  }
  const listener = term.onBell(() => {
    changed(true)
    playSound()
    clearTimeout(timer)
    if (active()) timer = setTimeout(returned, 4000)
  })
  window.addEventListener('click', interact, true)
  window.addEventListener('keydown', interact, true)
  window.addEventListener('focus', returned)
  document.addEventListener('visibilitychange', returned)

  return {
    acknowledge,
    dispose() {
      listener.dispose()
      clearTimeout(timer)
      window.removeEventListener('click', interact, true)
      window.removeEventListener('keydown', interact, true)
      window.removeEventListener('focus', returned)
      document.removeEventListener('visibilitychange', returned)
      if (audio) void audio.close().catch(() => {})
    },
  }
}
