// Subtle, dismissable onboarding entry banner mounted in Machines (minimal intrusion).
import { useState } from 'react'
import { ArrowRight, Compass, X } from 'lucide-react'
import { pagePaths } from '../../shared/pages'
import { Link } from '../ui/Link'
import { dismissOnboarding, isOnboardingDismissed } from './onboardingState'
import './onboarding.scss'

export function OnboardingBanner({ hasMachines }: { hasMachines: boolean }) {
  const [dismissed, setDismissed] = useState(isOnboardingDismissed)

  if (dismissed) return null

  return (
    <section className="onboarding-banner" aria-label="Getting started">
      <div className="onboarding-banner-icon" aria-hidden="true">
        <Compass size={18} />
      </div>
      <div className="onboarding-banner-body">
        <strong>{hasMachines ? 'New to Outpost?' : 'Get set up in a few minutes'}</strong>
        <p>
          Walk through Outpost concepts, installing Outpost Desktop, connecting this server, adding Linux machines, and
          launching AI coding sessions.
        </p>
      </div>
      <div className="onboarding-banner-actions">
        <Link className="button primary small" href={pagePaths.onboarding}>
          Start onboarding <ArrowRight size={14} aria-hidden="true" />
        </Link>
        <button
          type="button"
          className="icon-button"
          aria-label="Dismiss onboarding banner"
          title="Dismiss"
          onClick={() => {
            dismissOnboarding()
            setDismissed(true)
          }}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  )
}
