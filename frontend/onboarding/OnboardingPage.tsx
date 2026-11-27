// Interactive, step-by-step Outpost Onboarding Guide.
// Self-contained module covering core concepts & terminologies, installing Outpost Desktop,
// connecting the native terminal to this server, adding Linux machines, and starting AI sessions.
import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Compass,
  Download,
  ExternalLink,
  Globe,
  Laptop,
  Monitor,
  Plus,
  Server,
  Sparkles,
  Terminal,
} from 'lucide-react'
import { pagePaths } from '../../shared/pages'
import { useAuth } from '../auth/useAuth'
import { copyText, isMac } from '../browser'
import { useDesktopEntry } from '../desktop/useDesktopEntry'
import { navigate, replaceUrl, useLocation } from '../router'
import { SidebarBody } from '../ui/AppSidebar'
import { Link } from '../ui/Link'
import { useToast } from '../ui/toast-context'
import {
  DESKTOP_RELEASES_URL,
  ONBOARDING_STEPS,
  ONBOARDING_TERMS,
  type OnboardingStepId,
  type OnboardingStepMeta,
} from './onboardingContent'
import { OnboardingShot } from './OnboardingShot'
import { dismissOnboarding, readCompletedSteps, saveCompletedSteps } from './onboardingState'
import './onboarding.scss'

function termIcon(id: string) {
  switch (id) {
    case 'machine':
      return <Server size={16} aria-hidden="true" />
    case 'session':
      return <Sparkles size={16} aria-hidden="true" />
    case 'desktop':
      return <Monitor size={16} aria-hidden="true" />
    case 'web-terminal':
      return <Globe size={16} aria-hidden="true" />
    default:
      return <Terminal size={16} aria-hidden="true" />
  }
}

function stepFromSearch(search: string): OnboardingStepId {
  const requested = new URLSearchParams(search).get('step')
  const match = ONBOARDING_STEPS.find(step => step.id === requested)
  return match?.id ?? ONBOARDING_STEPS[0].id
}

function renderInlineCode(text: string) {
  const parts = text.split(/(`[^`]+`)/g)
  return parts.map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code key={index} className="onboarding-inline-code">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  )
}

function detectPlatformLabel(): 'macOS' | 'Windows' | 'Linux' {
  if (typeof navigator === 'undefined') return 'macOS'
  if (isMac()) return 'macOS'
  if (/Win/i.test(navigator.platform) || /Windows/i.test(navigator.userAgent)) return 'Windows'
  return 'Linux'
}

export default function OnboardingPage() {
  const { mode } = useAuth()
  const toast = useToast()
  const openDesktop = useDesktopEntry()
  const location = useLocation()
  const activeStepId = stepFromSearch(location.search)
  const activeIndex = Math.max(
    0,
    ONBOARDING_STEPS.findIndex(step => step.id === activeStepId),
  )
  const activeStep: OnboardingStepMeta = ONBOARDING_STEPS[activeIndex] ?? ONBOARDING_STEPS[0]
  const previousStep = activeIndex > 0 ? ONBOARDING_STEPS[activeIndex - 1] : null
  const nextStep = activeIndex + 1 < ONBOARDING_STEPS.length ? ONBOARDING_STEPS[activeIndex + 1] : null

  const [completed, setCompleted] = useState<string[]>(readCompletedSteps)
  const [copiedUrl, setCopiedUrl] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const macInstaller = import.meta.env.VITE_OUTPOST_MAC_ARM64_INSTALLER
  const platform = detectPlatformLabel()
  const serverUrl = typeof window !== 'undefined' ? window.location.origin : ''

  useEffect(() => {
    document.title = `${activeStep.navLabel} · Getting Started · Outpost`
  }, [activeStep.navLabel])

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

  const completedSet = new Set(completed)
  const progressPercent = Math.round((completedSet.size / ONBOARDING_STEPS.length) * 100)

  function goToStep(stepId: OnboardingStepId) {
    replaceUrl(`${pagePaths.onboarding}?step=${stepId}`)
    window.scrollTo({ top: 0, behavior: 'auto' })
  }

  function markStepDone(stepId: OnboardingStepId) {
    if (completedSet.has(stepId)) return
    const next = [...completed, stepId]
    setCompleted(next)
    saveCompletedSteps(next)
  }

  function toggleStepDone(stepId: OnboardingStepId) {
    const next = completedSet.has(stepId) ? completed.filter(id => id !== stepId) : [...completed, stepId]
    setCompleted(next)
    saveCompletedSteps(next)
  }

  function handleNext() {
    markStepDone(activeStep.id)
    if (nextStep) {
      goToStep(nextStep.id)
    } else {
      dismissOnboarding()
      navigate(pagePaths.workspace)
    }
  }

  function handleCopyServerUrl() {
    if (!serverUrl) return
    void copyText(serverUrl)
      .then(() => {
        setCopiedUrl(true)
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => {
          setCopiedUrl(false)
          copyTimer.current = null
        }, 1600)
      })
      .catch(() => toast('Could not copy server URL.', 'error'))
  }

  function handleLaunchDesktop() {
    try {
      openDesktop()
      markStepDone('connect-desktop')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not open Outpost Desktop.', 'error')
    }
  }

  function finishOnboarding() {
    const allIds = ONBOARDING_STEPS.map(step => step.id)
    setCompleted(allIds)
    saveCompletedSteps(allIds)
    dismissOnboarding()
    navigate(pagePaths.workspace)
  }

  return (
    <>
      <SidebarBody>
        <div className="onboarding-sidebar-progress">
          <div className="onboarding-progress-head">
            <span className="onboarding-progress-label">Getting started</span>
            <span className="onboarding-progress-count">
              {completedSet.size}/{ONBOARDING_STEPS.length}
            </span>
          </div>
          <div
            className="onboarding-progress-track"
            role="progressbar"
            aria-valuenow={progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="onboarding-progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>

        <nav className="onboarding-step-nav" aria-label="Onboarding steps">
          {ONBOARDING_STEPS.map(step => {
            const isCurrent = step.id === activeStep.id
            const isDone = completedSet.has(step.id)
            return (
              <button
                key={step.id}
                type="button"
                className={`nav-item onboarding-step-link${isCurrent ? ' active' : ''}${isDone ? ' done' : ''}`}
                aria-current={isCurrent ? 'step' : undefined}
                onClick={() => goToStep(step.id)}
              >
                <span className={`onboarding-step-num${isDone ? ' done' : ''}`} aria-hidden="true">
                  {isDone ? <Check size={12} /> : step.number}
                </span>
                <span>
                  <strong>{step.navLabel}</strong>
                </span>
              </button>
            )
          })}
        </nav>
      </SidebarBody>

      <main className="content onboarding-content">
        <div className="onboarding-shell">
          <div className="onboarding-topbar">
            <span className="onboarding-pill">
              <Compass size={13} aria-hidden="true" />
              Step {activeStep.number} of {ONBOARDING_STEPS.length}
            </span>
            <div className="onboarding-topbar-actions">
              <button type="button" className="button small" onClick={() => toggleStepDone(activeStep.id)}>
                <CheckCircle2 size={13} aria-hidden="true" />
                {completedSet.has(activeStep.id) ? 'Completed' : 'Mark done'}
              </button>
              <Link className="button small" href={pagePaths.guide}>
                <BookOpen size={13} aria-hidden="true" />
                User guide
              </Link>
            </div>
          </div>

          <header className="onboarding-hero">
            <h1>{activeStep.title}</h1>
            <p>{renderInlineCode(activeStep.subtitle)}</p>
          </header>

          {activeStep.id === 'welcome' && (
            <section className="onboarding-section">
              <div className="onboarding-callout">
                <strong>Sessions live on your Linux machine, not your browser tab.</strong>
                <span>
                  Start Claude Code, Codex, Kimi Code, Antigravity CLI, or DeepSeek Harness on any Linux box you
                  own—then close your laptop, switch devices, or drop Wi-Fi and reconnect right where you left off.
                </span>
              </div>

              <h2 className="onboarding-subheading">Core terminology</h2>
              <div className="onboarding-terms-grid">
                {ONBOARDING_TERMS.map(item => (
                  <article key={item.id} className="onboarding-term-card">
                    <div className="onboarding-term-head">
                      <span className="onboarding-term-icon">{termIcon(item.id)}</span>
                      <div>
                        <h3>{item.term}</h3>
                        <small>{item.summary}</small>
                      </div>
                    </div>
                    <p>{renderInlineCode(item.detail)}</p>
                  </article>
                ))}
              </div>
            </section>
          )}

          {activeStep.id === 'install-desktop' && (
            <section className="onboarding-section">
              <div className="onboarding-action-card">
                <div className="onboarding-action-copy">
                  <div className="onboarding-platform-tag">
                    <Laptop size={13} aria-hidden="true" />
                    Detected platform: <strong>{platform}</strong>
                  </div>
                  <h3>Download Outpost Desktop</h3>
                  <p>
                    Available for <strong>macOS</strong> (Apple silicon &amp; Intel) and <strong>Windows</strong>.
                    Install the app and launch it once so your browser can open <code>outpost://</code> session links
                    directly.
                  </p>
                </div>
                <div className="onboarding-action-buttons">
                  {macInstaller && platform === 'macOS' ? (
                    <a className="button primary" href={macInstaller} download>
                      <Download size={15} aria-hidden="true" />
                      Download for macOS (Apple silicon)
                    </a>
                  ) : (
                    <a className="button primary" href={DESKTOP_RELEASES_URL} target="_blank" rel="noopener noreferrer">
                      <Download size={15} aria-hidden="true" />
                      Download from GitHub Releases
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  )}
                  <Link className="button" href={pagePaths.desktop}>
                    All download options
                  </Link>
                </div>
              </div>

              <ol className="onboarding-checklist">
                <li>
                  <strong>Install the app</strong> — on macOS, drag Outpost into Applications; on Windows, run the
                  installer.
                </li>
                <li>
                  <strong>Launch Outpost Desktop once</strong> — this registers the <code>outpost://</code> protocol
                  handler with your operating system.
                </li>
                <li>
                  <strong>No install right now?</strong> You can still open any session immediately in the built-in{' '}
                  <strong>Web terminal</strong> from your browser or phone.
                </li>
              </ol>
            </section>
          )}

          {activeStep.id === 'connect-desktop' && (
            <section className="onboarding-section">
              <div className="onboarding-action-card">
                <div className="onboarding-action-copy">
                  <h3>Connect Outpost Desktop to this server</h3>
                  <p>
                    Click <strong>Open in Outpost Desktop</strong> to hand this server URL directly to the installed
                    app, or copy the server address below and paste it into <strong>Connect a server</strong> inside the
                    app.
                  </p>
                  <div className="onboarding-url-bar">
                    <code>{serverUrl}</code>
                    <button type="button" className="button small" onClick={handleCopyServerUrl}>
                      {copiedUrl ? (
                        <Check size={13} aria-hidden="true" />
                      ) : (
                        <ClipboardCopy size={13} aria-hidden="true" />
                      )}
                      {copiedUrl ? 'Copied' : 'Copy URL'}
                    </button>
                  </div>
                </div>
                <div className="onboarding-action-buttons">
                  <button type="button" className="button primary" onClick={handleLaunchDesktop}>
                    <Monitor size={15} aria-hidden="true" />
                    Open in Outpost Desktop
                  </button>
                </div>
              </div>

              <div className="onboarding-callout">
                <strong>Passwords never enter the desktop app.</strong>
                <span>
                  Clicking <strong>Sign in with browser</strong> opens a one-click approval screen in your browser and
                  grants a revocable 30-day desktop login.
                </span>
              </div>
            </section>
          )}

          {activeStep.id === 'add-machine' && (
            <section className="onboarding-section">
              {mode === 'local' && (
                <div className="onboarding-callout onboarding-callout-success">
                  <strong>Local mode detected — this host is already ready!</strong>
                  <span>
                    Outpost automatically added your local Linux/WSL host so you can start sessions right away, or add
                    more remote Linux servers over SSH below.
                  </span>
                </div>
              )}

              <div className="onboarding-two-col">
                <div className="onboarding-method-card">
                  <h3>Option A · Connect over SSH</h3>
                  <p>
                    Best when Outpost can reach your Linux host over SSH (directly or through a jump/bastion host).
                    Outpost installs <code>~/.outpost/bin/outpost-terminal</code> automatically over SSH.
                  </p>
                </div>
                <div className="onboarding-method-card">
                  <h3>Option B · Run setup on the machine</h3>
                  <p>
                    Best for Linux machines behind NAT or a corporate firewall. Paste a single one-time{' '}
                    <code>curl</code> command on the machine to enroll an authenticated outbound HTTPS tunnel.
                  </p>
                </div>
              </div>

              <div className="onboarding-inline-cta">
                <Link
                  className="button primary"
                  href={`${pagePaths.workspace}?add=1`}
                  onClick={() => markStepDone('add-machine')}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add a machine now
                </Link>
                <Link className="button" href={pagePaths.workspace}>
                  View Machines &amp; Software
                </Link>
              </div>
            </section>
          )}

          {activeStep.id === 'start-session' && (
            <section className="onboarding-section">
              <ol className="onboarding-checklist">
                <li>
                  <strong>Verify coding tools</strong> — open your machine in{' '}
                  <Link href={pagePaths.workspace}>Machines</Link> and check the <strong>Software</strong> card. Click{' '}
                  <strong>Set up</strong> next to any missing tool (Claude Code, Codex, Kimi Code, Antigravity CLI, or
                  DeepSeek Harness).
                </li>
                <li>
                  <strong>Create the session</strong> — click <strong>New session</strong> in the web UI, or click{' '}
                  <strong>+ New session</strong> inside Outpost Desktop, then choose the coding tool and project folder.
                </li>
                <li>
                  <strong>Or launch from any Linux shell</strong> — run <code>outpost new</code> on the machine itself
                  to spin up a session and auto-open it in Outpost Desktop.
                </li>
              </ol>

              <div className="onboarding-inline-cta">
                <Link
                  className="button primary"
                  href={pagePaths.workspace}
                  onClick={() => markStepDone('start-session')}
                >
                  Go to Machines
                  <ArrowRight size={15} aria-hidden="true" />
                </Link>
              </div>
            </section>
          )}

          {activeStep.id === 'connect-and-work' && (
            <section className="onboarding-section">
              <div className="onboarding-two-col">
                <div className="onboarding-method-card">
                  <h3>Native tabs &amp; split panes</h3>
                  <p>
                    Click <strong>+</strong> or press <code>Ctrl+Shift+D</code> (<code>Cmd+D</code> on macOS) to split
                    any pane side by side and open another local shell or remote AI session.
                  </p>
                </div>
                <div className="onboarding-method-card">
                  <h3>Built for AI coding workflows</h3>
                  <p>
                    Paste screenshots directly with <code>Ctrl+V</code> / <code>Cmd+V</code>, search full scrollback
                    with <code>Ctrl+Shift+F</code> / <code>Cmd+F</code>, and watch live working/idle/finished status
                    badges.
                  </p>
                </div>
              </div>

              <div className="onboarding-finish-card">
                <div>
                  <h3>You&apos;re ready to go</h3>
                  <p>
                    Jump into your Machines workspace to launch sessions, or explore keyboard shortcuts and CLI flags in
                    the User Guide.
                  </p>
                </div>
                <div className="onboarding-action-buttons">
                  <button type="button" className="button primary" onClick={finishOnboarding}>
                    <Check size={15} aria-hidden="true" />
                    Finish &amp; open Machines
                  </button>
                  <Link className="button" href={pagePaths.guide}>
                    <BookOpen size={14} aria-hidden="true" />
                    Browse User Guide
                  </Link>
                </div>
              </div>
            </section>
          )}

          {activeStep.screenshots.length > 0 && (
            <section className="onboarding-gallery" aria-label="Step screenshots">
              <div className={`onboarding-shots-grid count-${activeStep.screenshots.length}`}>
                {activeStep.screenshots.map(shot => (
                  <OnboardingShot key={`${activeStep.id}-${shot.filename}`} shot={shot} />
                ))}
              </div>
            </section>
          )}

          <nav className="onboarding-pager" aria-label="Onboarding step navigation">
            {previousStep ? (
              <button type="button" className="onboarding-pager-btn" onClick={() => goToStep(previousStep.id)}>
                <span className="onboarding-pager-dir">
                  <ArrowLeft size={13} aria-hidden="true" /> Previous
                </span>
                <strong>
                  {previousStep.number}. {previousStep.navLabel}
                </strong>
              </button>
            ) : (
              <div />
            )}
            <button type="button" className="onboarding-pager-btn next" onClick={handleNext}>
              <span className="onboarding-pager-dir">
                {nextStep ? (
                  <>
                    Next <ArrowRight size={13} aria-hidden="true" />
                  </>
                ) : (
                  <>
                    Complete <Check size={13} aria-hidden="true" />
                  </>
                )}
              </span>
              <strong>{nextStep ? `${nextStep.number}. ${nextStep.navLabel}` : 'Open Machines workspace'}</strong>
            </button>
          </nav>
        </div>
      </main>
    </>
  )
}
