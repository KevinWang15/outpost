// What each onboarding step asks the reader to do. Titles, leads and screenshots live in onboardingContent.ts.
import { Fragment, type ReactNode } from 'react'
import {
  ArrowRight,
  Cable,
  CircleCheck,
  Download,
  ExternalLink,
  Info,
  Monitor,
  Plus,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react'
import { harnesses } from '../../shared/harnesses'
import { machineSetupLabels, type Target } from '../../shared/model'
import { pagePaths } from '../../shared/pages'
import { appleMobile, isMac } from '../browser'
import { useDesktopEntry } from '../desktop/useDesktopEntry'
import { CopyField } from '../ui/CopyField'
import { Link } from '../ui/Link'
import { useToast } from '../ui/toast-context'
import { ToolIcon } from '../ui/ToolIcon'
import {
  DESKTOP_RELEASES_URL,
  ONBOARDING_SHORTCUTS,
  ONBOARDING_TERMS,
  type OnboardingShortcut,
  type OnboardingStepId,
} from './onboardingContent'
import { ActivityExample, OnboardingMap, type ExampleActivity } from './OnboardingMap'
import { onboardingHref } from './onboardingState'

/** Outpost Desktop exists for macOS and Windows; everything else uses the Web terminal. */
type Platform = 'mac' | 'windows' | 'other'

function detectPlatform(): Platform {
  if (isMac() && !appleMobile()) return 'mac'
  if (/Win/.test(navigator.platform)) return 'windows'
  return 'other'
}

/** Onboarding copy with its `code` and **strong** marks rendered. */
export function Inline({ text }: { text: string }) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (part.startsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>
    if (part.startsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    return part
  })
}

function Keys({ shortcut, platform }: { shortcut: OnboardingShortcut; platform: Platform }) {
  const mac = platform === 'mac'
  const keys = mac ? shortcut.mac : shortcut.other
  return (
    <span className="onboarding-keys">
      {keys.map((key, index) => (
        <Fragment key={key}>
          {/* macOS writes shortcuts as adjacent symbols; other systems join key names with a plus. */}
          {index > 0 && !mac && <span aria-hidden="true">+</span>}
          <kbd>{key}</kbd>
        </Fragment>
      ))}
    </span>
  )
}

function Note({
  icon: Icon = Info,
  tone = 'info',
  children,
}: {
  icon?: LucideIcon
  tone?: 'info' | 'success'
  children: ReactNode
}) {
  return (
    <div className={`onboarding-note ${tone}`}>
      <Icon size={16} aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

function ExternalButton({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return (
    <a className={primary ? 'button primary' : 'button'} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  )
}

const sentenceList = (items: readonly string[]) =>
  new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(items)

function Welcome() {
  return (
    <>
      <section className="onboarding-section" aria-labelledby="onboarding-map-heading">
        <h2 id="onboarding-map-heading">How it fits together</h2>
        <OnboardingMap />
      </section>
      <section className="onboarding-section" aria-labelledby="onboarding-terms-heading">
        <h2 id="onboarding-terms-heading">Words you&apos;ll see</h2>
        <dl className="onboarding-definitions">
          {ONBOARDING_TERMS.map(item => (
            <div key={item.id}>
              <dt>{item.term}</dt>
              <dd>
                <Inline text={item.detail} />
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  )
}

function InstallDesktop({ platform }: { platform: Platform }) {
  const macInstaller: string | undefined = import.meta.env.VITE_OUTPOST_MAC_ARM64_INSTALLER
  return (
    <>
      <Note>
        {platform === 'other'
          ? 'Outpost Desktop runs on macOS and Windows, so there is nothing to install on this device. Your sessions open in the Web terminal here. '
          : 'This step is optional. Every session also opens in the Web terminal, with nothing to install. '}
        <Link href={onboardingHref('add-machine')}>Skip to adding a machine</Link>
      </Note>
      <ol className="onboarding-actions">
        <li>
          <h3>Download the app</h3>
          <p>
            {platform === 'other'
              ? 'For a Mac or a Windows PC, builds are published on GitHub.'
              : 'Builds for macOS (Apple silicon and Intel) and Windows are published on GitHub.'}
          </p>
          <div className="onboarding-controls">
            {platform === 'mac' && macInstaller ? (
              <>
                <a className="button primary" href={macInstaller} download>
                  <Download size={15} aria-hidden="true" />
                  Download for Mac (Apple silicon)
                </a>
                <ExternalButton href={DESKTOP_RELEASES_URL}>Intel and other builds</ExternalButton>
              </>
            ) : (
              <ExternalButton href={DESKTOP_RELEASES_URL} primary={platform !== 'other'}>
                <Download size={15} aria-hidden="true" />
                {platform === 'mac'
                  ? 'Download for macOS'
                  : platform === 'windows'
                    ? 'Download for Windows'
                    : 'Browse releases'}
              </ExternalButton>
            )}
          </div>
        </li>
        <li>
          <h3>Install it</h3>
          <p>
            {platform === 'mac'
              ? 'Open the download and drag Outpost into Applications.'
              : platform === 'windows'
                ? 'Run the installer.'
                : 'On macOS, drag Outpost into Applications. On Windows, run the installer.'}
          </p>
          <p className="hint">
            {platform === 'mac'
              ? 'Preview builds are unsigned. If macOS blocks the first launch, choose Open Anyway in System Settings → Privacy & Security.'
              : platform === 'windows'
                ? 'Preview builds are unsigned, so Windows may show a SmartScreen warning.'
                : 'Preview builds are unsigned. macOS may need Open Anyway in System Settings → Privacy & Security, and Windows may show a SmartScreen warning.'}
          </p>
        </li>
        <li>
          <h3>Open it once</h3>
          <p>
            Launching Outpost Desktop registers it with your system. After that, <strong>Connect</strong> in the browser
            can open a session straight in the app.
          </p>
        </li>
      </ol>
    </>
  )
}

function ConnectDesktop({ onDone }: { onDone: () => void }) {
  const toast = useToast()
  const openDesktop = useDesktopEntry()
  return (
    <ol className="onboarding-actions">
      <li>
        <h3>Send this server to the app</h3>
        <p>Your browser asks whether it may open Outpost Desktop. Allow it, and the app starts with this server.</p>
        <div className="onboarding-controls">
          <button
            type="button"
            className="button primary"
            onClick={() => {
              try {
                openDesktop()
                onDone()
              } catch (error) {
                toast(error instanceof Error ? error.message : 'Could not open Outpost Desktop.', 'error')
              }
            }}
          >
            <Monitor size={15} aria-hidden="true" />
            Open in Outpost Desktop
          </button>
        </div>
        <p className="hint">
          If the app does not open, paste this address under <strong>Connect a server</strong> in the app and choose{' '}
          <strong>Sign in with browser</strong>.
        </p>
        <CopyField value={window.location.origin} label="Server address" />
      </li>
      <li>
        <h3>Approve it in your browser</h3>
        <p>
          The app sends you to an approval page. Check the server and the account, then choose{' '}
          <strong>Connect app</strong>.
        </p>
      </li>
      <li>
        <h3>Check the app</h3>
        <p>
          This server appears under <strong>Logged-in Outpost servers</strong>, with shortcuts to its machines and
          sessions. You can sign out there at any time.
        </p>
      </li>
    </ol>
  )
}

function ConnectedMachines({ machines }: { machines: Target[] }) {
  const names = machines.map(machine => machine.name)
  const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names
  return (
    <Note icon={CircleCheck} tone="success">
      <strong>{sentenceList(shown)}</strong> {machines.length === 1 ? 'is' : 'are'} already connected. Add another
      machine below, or continue to start a session.
    </Note>
  )
}

function AddMachine({ machines, onDone }: { machines: Target[] | null; onDone: () => void }) {
  const connected = Boolean(machines?.length)
  return (
    <>
      {machines && machines.length > 0 && <ConnectedMachines machines={machines} />}
      <div className="onboarding-options">
        <section className="onboarding-option">
          <span className="onboarding-option-icon">
            <SquareTerminal size={17} aria-hidden="true" />
          </span>
          <h3>{machineSetupLabels.ssh}</h3>
          <p>Use this when the Outpost server can open SSH to the machine, directly or through a jump host.</p>
          <p className="onboarding-option-how">
            Outpost installs its machine service over SSH and detects the coding tools already there.
          </p>
        </section>
        <section className="onboarding-option">
          <span className="onboarding-option-icon">
            <Cable size={17} aria-hidden="true" />
          </span>
          <h3>{machineSetupLabels.outbound}</h3>
          <p>Use this when the machine sits behind NAT or a firewall but can reach the Outpost server.</p>
          <p className="onboarding-option-how">
            You paste a one-time <code>curl</code> command into a shell on the machine. It then keeps a connection open
            to Outpost.
          </p>
        </section>
      </div>
      <div className="onboarding-controls">
        <Link
          className={connected ? 'button' : 'button primary'}
          href={`${pagePaths.workspace}?add=1`}
          onClick={onDone}
        >
          <Plus size={15} aria-hidden="true" />
          {connected ? 'Add another machine' : 'Add a machine'}
        </Link>
      </div>
      <p className="onboarding-aside">
        Once a machine is added, its page shows a <strong>Software</strong> panel. It lists the coding tools Outpost
        found and offers <strong>Set up</strong> for the ones that are missing.
      </p>
    </>
  )
}

function StartSession({
  machines,
  platform,
  onDone,
}: {
  machines: Target[] | null
  platform: Platform
  onDone: () => void
}) {
  const picker = ONBOARDING_SHORTCUTS.find(shortcut => shortcut.id === 'sessions-picker')
  return (
    <>
      {machines?.length === 0 && (
        <Note>
          Sessions need a machine to run on. <Link href={onboardingHref('add-machine')}>Add a machine first</Link>
        </Note>
      )}
      <ol className="onboarding-actions">
        <li>
          <h3>Open a machine</h3>
          <p>
            Select it in <strong>Machines</strong> and check that its <strong>Software</strong> panel lists the coding
            tool you want. <strong>Set up</strong> installs a missing one.
          </p>
          <ul className="onboarding-tools" aria-label="Coding tools Outpost can run">
            {harnesses.map(harness => (
              <li key={harness.id} className="chip">
                <ToolIcon tool={harness.id} size={13} />
                {harness.label}
              </li>
            ))}
          </ul>
          <div className="onboarding-controls">
            <Link className="button primary" href={pagePaths.workspace} onClick={onDone}>
              Open Machines
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </li>
        <li>
          <h3>Choose New session</h3>
          <p>
            Name the session, pick the coding tool and enter the project directory. Outpost can create the directory if
            it does not exist yet.
          </p>
        </li>
        <li>
          <h3>Create it</h3>
          <p>The session joins the machine&apos;s list, ready for you to connect.</p>
        </li>
      </ol>
      <section className="onboarding-section" aria-labelledby="onboarding-other-ways-heading">
        <h2 id="onboarding-other-ways-heading">Two more ways to start one</h2>
        <dl className="onboarding-definitions">
          <div>
            <dt>In Outpost Desktop</dt>
            <dd>
              Press {picker && <Keys shortcut={picker} platform={platform} />} to open the sessions picker, then choose{' '}
              <strong>New session</strong>.
            </dd>
          </div>
          <div>
            <dt>From a shell</dt>
            <dd>
              Run <code>outpost new</code> in a project directory on the machine. Inside an Outpost terminal, the new
              session opens in its own tab.
            </dd>
          </div>
        </dl>
      </section>
    </>
  )
}

const ACTIVITY_MEANINGS: readonly { state: ExampleActivity; meaning: string }[] = [
  { state: 'working', meaning: 'The agent is in the middle of a turn.' },
  { state: 'finished', meaning: 'The agent finished a turn you have not looked at yet.' },
  { state: 'idle', meaning: 'Nothing is running, and you have seen the latest result.' },
]

function ConnectAndWork({ platform }: { platform: Platform }) {
  return (
    <>
      <section className="onboarding-section" aria-labelledby="onboarding-activity-heading">
        <h2 id="onboarding-activity-heading">See which session needs you</h2>
        <p>Every session shows what its agent is doing, in Machines and on each Outpost Desktop tab.</p>
        <dl className="onboarding-definitions">
          {ACTIVITY_MEANINGS.map(item => (
            <div key={item.state}>
              <dt>
                <ActivityExample state={item.state} />
              </dt>
              <dd>{item.meaning}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="onboarding-section" aria-labelledby="onboarding-shortcuts-heading">
        <h2 id="onboarding-shortcuts-heading">Shortcuts in Outpost Desktop</h2>
        <dl className="onboarding-shortcuts">
          {ONBOARDING_SHORTCUTS.map(shortcut => (
            <div key={shortcut.id}>
              <dt>{shortcut.label}</dt>
              <dd>
                <Keys shortcut={shortcut} platform={platform} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="onboarding-aside">
          The <Link href={pagePaths.guide}>user guide</Link> covers the rest: every shortcut, the Machine CLI, session
          settings and search across your machines.
        </p>
      </section>
    </>
  )
}

export function OnboardingStepBody({
  step,
  machines,
  onDone,
}: {
  step: OnboardingStepId
  /** The account's machines, or null while they are unknown. */
  machines: Target[] | null
  /** Marks the step as done because the reader acted on it. */
  onDone: () => void
}) {
  const platform = detectPlatform()
  switch (step) {
    case 'welcome':
      return <Welcome />
    case 'install-desktop':
      return <InstallDesktop platform={platform} />
    case 'connect-desktop':
      return <ConnectDesktop onDone={onDone} />
    case 'add-machine':
      return <AddMachine machines={machines} onDone={onDone} />
    case 'start-session':
      return <StartSession machines={machines} platform={platform} onDone={onDone} />
    case 'connect-and-work':
      return <ConnectAndWork platform={platform} />
  }
}
