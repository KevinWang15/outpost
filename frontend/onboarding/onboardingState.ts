// Persistent client-side onboarding progress and banner dismissal state.
const DISMISSED_KEY = 'outpost.onboarding.dismissed'
const STEPS_KEY = 'outpost.onboarding.completedSteps'

function readStorage(key: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Ignore storage quota / private-browsing failures.
  }
}

function removeStorage(key: string) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Ignore storage failures.
  }
}

export function isOnboardingDismissed(): boolean {
  return readStorage(DISMISSED_KEY) === '1'
}

export function dismissOnboarding() {
  writeStorage(DISMISSED_KEY, '1')
}

export function resetOnboarding() {
  removeStorage(DISMISSED_KEY)
  removeStorage(STEPS_KEY)
}

export function readCompletedSteps(): string[] {
  const raw = readStorage(STEPS_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function saveCompletedSteps(stepIds: readonly string[]) {
  writeStorage(STEPS_KEY, JSON.stringify([...new Set(stepIds)]))
}
