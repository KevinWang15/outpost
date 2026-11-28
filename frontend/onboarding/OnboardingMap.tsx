// "How it fits together": the devices you connect from, the Outpost server, and the machine
// that owns the sessions. The session rows and badges mirror the real Machines page.
// The wires between them are drawn in onboarding.scss.
import { useSyncExternalStore, type CSSProperties } from 'react'
import { Bell, Globe, LoaderCircle, Monitor, Server } from 'lucide-react'
import { activityLabel, unavailableActivity, type ActivityState } from '../../shared/activity'
import { harnesses, type HarnessId } from '../../shared/harnesses'
import { ToolIcon } from '../ui/ToolIcon'

export type ExampleActivity = Extract<ActivityState, 'working' | 'finished' | 'idle'>

const EXAMPLE_SESSIONS: readonly { name: string; tool: HarnessId; activity: ExampleActivity }[] = [
  { name: 'Billing API refactor', tool: 'claude', activity: 'working' },
  { name: 'API rate limiter', tool: 'codex', activity: 'finished' },
  { name: 'Release checklist', tool: 'kimi', activity: 'idle' },
]

const toolLabel = (id: HarnessId) => harnesses.find(harness => harness.id === id)?.label ?? id

/** A session's activity badge as Machines shows it, with the app's own label. */
export function ActivityExample({ state }: { state: ExampleActivity }) {
  return (
    <span className={`badge ${state}`}>
      {state === 'working' ? (
        <LoaderCircle className="spin" size={12} aria-hidden="true" />
      ) : state === 'finished' ? (
        <Bell size={12} aria-hidden="true" />
      ) : (
        <i />
      )}
      {activityLabel({ ...unavailableActivity(''), state })}
    </span>
  )
}

/** Calls back when the display scale changes: on page zoom, or when the window moves to another display. */
function watchDisplayScale(onChange: () => void) {
  // A resolution query matches a single scale, so it reports the moment the current one stops applying.
  const watch = () => {
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    query.addEventListener('change', changed)
    return query
  }
  const changed = () => {
    display.removeEventListener('change', changed)
    display = watch()
    onChange()
  }
  let display = watch()
  return () => display.removeEventListener('change', changed)
}

/** Wire sizes in device pixels, as variables for onboarding.scss.
 * On a display scaled to 125% or 150%, a CSS pixel is not a whole number of device pixels. A 1px
 * line and a 7px port are then rounded to the screen separately, and the port ends up half a
 * pixel off its line. Counted in device pixels, every edge of a wire lands on the pixel grid. */
function wireMetrics(scale: number): CSSProperties {
  return {
    '--device-pixel': `${1 / scale}px`,
    // As thick as the browser draws a 1px border: whole device pixels, rounded down.
    '--wire-pixels': Math.max(1, Math.floor(scale)),
    // A port extends this far on each side of its line, about 3 CSS pixels.
    '--port-reach-pixels': Math.max(1, Math.round(3 * scale)),
  } as CSSProperties
}

export function OnboardingMap() {
  const scale = useSyncExternalStore(watchDisplayScale, () => window.devicePixelRatio)
  return (
    <div className="onboarding-map" style={wireMetrics(scale)}>
      <p className="onboarding-map-label from">You connect from</p>
      <div className="onboarding-map-body from">
        <div className="onboarding-map-node">
          <Monitor size={18} aria-hidden="true" />
          <span>
            <strong>Outpost Desktop</strong>
            <small>macOS and Windows</small>
          </span>
        </div>
        <div className="onboarding-map-node">
          <Globe size={18} aria-hidden="true" />
          <span>
            <strong>Web terminal</strong>
            <small>Any browser, phones included</small>
          </span>
        </div>
        <span className="onboarding-map-merge" aria-hidden="true" />
      </div>
      <p className="onboarding-map-note from">Connect, disconnect and switch devices whenever you like.</p>

      <span className="onboarding-map-wire first" aria-hidden="true" />

      <p className="onboarding-map-label through">Through</p>
      <div className="onboarding-map-body through">
        <div className="onboarding-map-node server">
          <img src="/outpost.svg" width="22" height="22" alt="" />
          <span>
            <strong>This Outpost server</strong>
            <small>{window.location.host}</small>
          </span>
        </div>
      </div>
      <p className="onboarding-map-note through">Knows your machines and carries each terminal to you.</p>

      <span className="onboarding-map-wire second" aria-hidden="true" />

      <p className="onboarding-map-label on">Sessions run on</p>
      <div className="onboarding-map-body on">
        <div className="onboarding-map-machine">
          <div className="onboarding-map-machine-head">
            <Server size={16} aria-hidden="true" />
            <strong>Your Linux machine</strong>
          </div>
          <ul>
            {EXAMPLE_SESSIONS.map(session => (
              <li key={session.name}>
                <ToolIcon tool={session.tool} size={15} />
                <span>
                  <strong>{session.name}</strong>
                  <small>{toolLabel(session.tool)}</small>
                </span>
                <ActivityExample state={session.activity} />
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="onboarding-map-note on">Agents keep working here while nothing is connected.</p>
    </div>
  )
}
