// The getting started guide: six steps from "what is Outpost" to working in a session.
// Each step is a URL (?step=), so Back, Forward and links between steps all work.
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check } from 'lucide-react'
import type { Target } from '../../shared/model'
import { pagePaths } from '../../shared/pages'
import { api } from '../api'
import { useAuth } from '../auth/useAuth'
import { navigate, useLocation } from '../router'
import { SidebarBody } from '../ui/AppSidebar'
import { Link } from '../ui/Link'
import { getCachedTargets, setCachedTargets } from '../workspace/cache'
import { ONBOARDING_STEPS, type OnboardingStepId } from './onboardingContent'
import { OnboardingShots } from './OnboardingShots'
import { dismissOnboarding, onboardingHref, readCompletedSteps, saveCompletedSteps } from './onboardingState'
import { Inline, OnboardingStepBody } from './OnboardingSteps'
import './onboarding.scss'

function stepIndexFromSearch(search: string): number {
  const requested = new URLSearchParams(search).get('step')
  return Math.max(
    0,
    ONBOARDING_STEPS.findIndex(step => step.id === requested),
  )
}

/** The account's machines, so steps can describe what is already set up. Null until known. */
function useMachines(): Target[] | null {
  const { user } = useAuth()
  const accountKey = user?.id ?? 'local'
  const [machines, setMachines] = useState(() => getCachedTargets(accountKey))
  useEffect(() => {
    const controller = new AbortController()
    api<Target[]>('/targets', 'GET', undefined, controller.signal).then(
      items => {
        setCachedTargets(accountKey, items)
        setMachines(items)
      },
      // The guide reads fine without this; steps just skip what they would have said about machines.
      () => {},
    )
    return () => controller.abort()
  }, [accountKey])
  return machines
}

export default function OnboardingPage() {
  const location = useLocation()
  const index = stepIndexFromSearch(location.search)
  const step = ONBOARDING_STEPS[index]
  const previous = ONBOARDING_STEPS[index - 1]
  const next = ONBOARDING_STEPS[index + 1]
  const total = ONBOARDING_STEPS.length

  const machines = useMachines()
  const [completed, setCompleted] = useState(readCompletedSteps)
  const done = new Set<OnboardingStepId>(completed)
  // A connected machine counts, however it got there.
  if (machines?.length) done.add('add-machine')

  const heading = useRef<HTMLHeadingElement>(null)
  const shownStep = useRef(step.id)

  useEffect(() => {
    document.title = `${step.navLabel} · Getting started · Outpost`
    if (shownStep.current === step.id) return
    shownStep.current = step.id
    // A new step starts at its top, for the eye and for screen readers alike.
    window.scrollTo({ top: 0, behavior: 'auto' })
    heading.current?.focus({ preventScroll: true })
  }, [step.id, step.navLabel])

  function markDone(stepId: OnboardingStepId) {
    if (completed.includes(stepId)) return
    const updated = [...completed, stepId]
    setCompleted(updated)
    saveCompletedSteps(updated)
  }

  function continueGuide() {
    markDone(step.id)
    if (next) {
      navigate(onboardingHref(next.id))
    } else {
      dismissOnboarding()
      navigate(pagePaths.workspace)
    }
  }

  return (
    <>
      <SidebarBody>
        <div className="onboarding-progress">
          <div className="sidebar-heading">
            <span>Getting started</span>
            <span className="onboarding-progress-count">
              {done.size} of {total}
            </span>
          </div>
          <div
            className="onboarding-progress-track"
            role="progressbar"
            aria-label="Steps completed"
            aria-valuenow={done.size}
            aria-valuemin={0}
            aria-valuemax={total}
          >
            <div style={{ width: `${(done.size / total) * 100}%` }} />
          </div>
        </div>
        <nav className="onboarding-step-nav" aria-label="Getting started steps">
          {ONBOARDING_STEPS.map((item, itemIndex) => {
            const current = item.id === step.id
            const finished = done.has(item.id)
            return (
              <Link
                key={item.id}
                className={`nav-item onboarding-step-link${current ? ' active' : ''}${finished ? ' done' : ''}`}
                href={onboardingHref(item.id)}
                aria-current={current ? 'step' : undefined}
              >
                <span className="onboarding-step-mark" aria-hidden="true">
                  {finished ? <Check size={12} strokeWidth={3} /> : itemIndex + 1}
                </span>
                <span className="onboarding-step-label">
                  <strong>{item.navLabel}</strong>
                  {finished && <span className="sr-only"> (done)</span>}
                </span>
              </Link>
            )
          })}
        </nav>
      </SidebarBody>

      <main className="content onboarding-content">
        <article className="onboarding-shell">
          <header className="onboarding-header">
            <p className="onboarding-eyebrow">
              Step {index + 1} of {total}
            </p>
            <h1 ref={heading} tabIndex={-1}>
              {step.title}
            </h1>
            <p className="onboarding-lead">
              <Inline text={step.lead} />
            </p>
          </header>

          <OnboardingStepBody step={step.id} machines={machines} onDone={() => markDone(step.id)} />

          {/* Keyed by step so each one opens on its first screenshot. */}
          <OnboardingShots key={step.id} shots={step.screenshots} />

          <nav className="onboarding-pager" aria-label="Previous and next step">
            {previous && (
              <Link className="button" href={onboardingHref(previous.id)}>
                <ArrowLeft size={15} aria-hidden="true" />
                Back
              </Link>
            )}
            <span className="onboarding-pager-next">{next ? <>Next: {next.navLabel}</> : null}</span>
            <button type="button" className="button primary" onClick={continueGuide}>
              {next ? (
                <>
                  Continue
                  <ArrowRight size={15} aria-hidden="true" />
                </>
              ) : (
                <>
                  <Check size={15} aria-hidden="true" />
                  Finish and open Machines
                </>
              )}
            </button>
          </nav>
        </article>
      </main>
    </>
  )
}
