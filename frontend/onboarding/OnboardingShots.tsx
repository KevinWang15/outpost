// A step's screenshots: one large frame, tabs when there are several, and a full-size preview.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, Maximize2, X } from 'lucide-react'
import { onboardingImageUrl } from './onboardingAssets'
import type { OnboardingScreenshot } from './onboardingContent'

/** Moves between tabs, or between pictures in the preview, with the arrow, Home and End keys. */
function arrowTarget(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count
    case 'ArrowLeft':
      return (index + count - 1) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

export function OnboardingShots({ shots }: { shots: readonly OnboardingScreenshot[] }) {
  const id = useId()
  const [active, setActive] = useState(0)
  const [previewing, setPreviewing] = useState(false)
  const shot = shots[active]
  const tabbed = shots.length > 1

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = arrowTarget(event.key, index, shots.length)
    if (next === null) return
    event.preventDefault()
    setActive(next)
    document.getElementById(`${id}-tab-${next}`)?.focus()
  }

  return (
    <figure className="onboarding-shots">
      {tabbed && (
        <div className="onboarding-shot-tabs" role="tablist" aria-label="Screenshots">
          {shots.map((item, index) => (
            <button
              key={item.filename}
              id={`${id}-tab-${index}`}
              type="button"
              role="tab"
              aria-selected={index === active}
              aria-controls={`${id}-panel`}
              tabIndex={index === active ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={event => onTabKeyDown(event, index)}
            >
              <span aria-hidden="true">{index + 1}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
      <div
        id={`${id}-panel`}
        className="onboarding-shot-panel"
        role={tabbed ? 'tabpanel' : undefined}
        aria-labelledby={tabbed ? `${id}-tab-${active}` : undefined}
      >
        <button
          type="button"
          className="onboarding-shot-frame"
          aria-label={`Enlarge screenshot: ${shot.label}`}
          onClick={() => setPreviewing(true)}
        >
          {/* Every picture stays mounted so switching tabs never waits for a download. */}
          {shots.map((item, index) => (
            <ShotImage key={item.filename} shot={item} shown={index === active} />
          ))}
          <span className="onboarding-shot-zoom" aria-hidden="true">
            <Maximize2 size={13} />
            Enlarge
          </span>
        </button>
        <figcaption>{shot.caption}</figcaption>
      </div>
      {previewing && (
        <ShotPreview shots={shots} index={active} onIndex={setActive} onClose={() => setPreviewing(false)} />
      )}
    </figure>
  )
}

function ShotImage({ shot, shown }: { shot: OnboardingScreenshot; shown: boolean }) {
  const src = onboardingImageUrl(shot.filename)
  if (!src) {
    return (
      <span className={`onboarding-shot-missing${shown ? ' shown' : ''}`}>
        {shot.filename} has not been captured. Run <code>npm run onboarding:capture</code>.
      </span>
    )
  }
  const { focus } = shot
  return (
    <img
      className={shown ? 'shown' : undefined}
      src={src}
      alt={shown ? shot.alt : ''}
      aria-hidden={shown ? undefined : true}
      draggable={false}
      style={focus ? { transform: `scale(${focus.zoom})`, transformOrigin: `${focus.x}% ${focus.y}%` } : undefined}
    />
  )
}

function ShotPreview({
  shots,
  index,
  onIndex,
  onClose,
}: {
  shots: readonly OnboardingScreenshot[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const shot = shots[index]
  const src = onboardingImageUrl(shot.filename)
  const several = shots.length > 1

  // A modal <dialog> traps focus, closes on Escape and returns focus to the frame it was opened from.
  useEffect(() => {
    ref.current?.showModal()
  }, [])

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    const next = arrowTarget(event.key, index, shots.length)
    if (next === null) return
    event.preventDefault()
    onIndex(next)
  }

  return (
    <dialog
      ref={ref}
      className="onboarding-preview"
      aria-label={`Screenshot: ${shot.label}`}
      onClose={onClose}
      onKeyDown={several ? onKeyDown : undefined}
      // The dialog fills the window, so a click that lands on it missed the picture and its controls.
      onClick={event => {
        if (event.target === event.currentTarget) ref.current?.close()
      }}
    >
      <button
        type="button"
        className="onboarding-preview-close"
        aria-label="Close screenshot"
        onClick={() => ref.current?.close()}
      >
        <X size={18} aria-hidden="true" />
      </button>
      {src && <img src={src} alt={shot.alt} />}
      <div className="onboarding-preview-bar">
        {several && (
          <button
            type="button"
            aria-label="Previous screenshot"
            onClick={() => onIndex((index + shots.length - 1) % shots.length)}
          >
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
        )}
        <p aria-live="polite">
          {several && (
            <span>
              {index + 1} of {shots.length}
            </span>
          )}
          {shot.caption}
        </p>
        {several && (
          <button type="button" aria-label="Next screenshot" onClick={() => onIndex((index + 1) % shots.length)}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        )}
      </div>
    </dialog>
  )
}
