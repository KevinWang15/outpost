export type AppMode = 'chat' | 'machines'

/** The workspace address opens the mode used last in this browser. */
export function rememberMode(mode: AppMode) {
  try {
    localStorage.setItem('outpost:mode', mode)
  } catch {
    /* Storage is optional. */
  }
}
export function rememberedMode(): AppMode {
  try {
    return localStorage.getItem('outpost:mode') === 'chat' ? 'chat' : 'machines'
  } catch {
    return 'machines'
  }
}
