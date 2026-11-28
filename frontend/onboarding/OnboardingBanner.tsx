// A one-line pointer to the getting started guide on Machines, until it is dismissed or the guide is finished.
import { useState } from 'react'
import { ArrowRight, Compass, X } from 'lucide-react'
import { Link } from '../ui/Link'
import { ONBOARDING_STEPS } from './onboardingContent'
import {
  dismissOnboarding,
  isOnboardingDismissed,
  nextOnboardingStep,
  onboardingHref,
  readCompletedSteps,
} from './onboardingState'
import './banner.scss'

export function OnboardingBanner() {
  const [dismissed, setDismissed] = useState(isOnboardingDismissed)
  const [completed] = useState(readCompletedSteps)
  const resume = nextOnboardingStep(completed)

  if (dismissed || !resume) return null
  const started = completed.length > 0

  return (
    <section className="onboarding-banner" aria-label="Getting started">
      <Compass size={16} aria-hidden="true" />
      <p>
        {started ? (
          <>
            <strong>Getting started</strong> {completed.length} of {ONBOARDING_STEPS.length} steps done.
          </>
        ) : (
          <>
            <strong>New to Outpost?</strong> The getting started guide covers Outpost Desktop, machines and sessions.
          </>
        )}
      </p>
      <Link className="button small" href={onboardingHref(resume)}>
        {started ? 'Continue' : 'Open the guide'}
        <ArrowRight size={14} aria-hidden="true" />
      </Link>
      <button
        type="button"
        className="icon-button"
        aria-label="Dismiss getting started"
        title="Dismiss"
        onClick={() => {
          dismissOnboarding()
          setDismissed(true)
        }}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </section>
  )
}
