// Onboarding progress and banner dismissal, kept in this browser's local storage.
import { pagePaths } from '../../shared/pages'
import { ONBOARDING_STEPS, type OnboardingStepId } from './onboardingContent'

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
    // Storage is full or unavailable (private browsing). Progress then lasts for this visit only.
  }
}

export function isOnboardingDismissed(): boolean {
  return readStorage(DISMISSED_KEY) === '1'
}

export function dismissOnboarding() {
  writeStorage(DISMISSED_KEY, '1')
}

/** The steps a stored value marks as done, in guide order, ignoring anything that is not a step. */
export function parseCompletedSteps(raw: string | null): OnboardingStepId[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return ONBOARDING_STEPS.map(step => step.id).filter(id => parsed.includes(id))
}

export function readCompletedSteps(): OnboardingStepId[] {
  return parseCompletedSteps(readStorage(STEPS_KEY))
}

export function saveCompletedSteps(stepIds: readonly OnboardingStepId[]) {
  writeStorage(STEPS_KEY, JSON.stringify([...new Set(stepIds)]))
}

/** The first step that is not done yet, or null when the guide is complete. */
export function nextOnboardingStep(completed: readonly string[]): OnboardingStepId | null {
  return ONBOARDING_STEPS.find(step => !completed.includes(step.id))?.id ?? null
}

export function onboardingHref(stepId: OnboardingStepId): string {
  return `${pagePaths.onboarding}?step=${stepId}`
}
