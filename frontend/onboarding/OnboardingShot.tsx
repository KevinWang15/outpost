// Self-contained click-to-zoom image frame for the onboarding module (no coupling to guide styles).
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X } from 'lucide-react'
import { onboardingImageUrl } from './onboardingAssets'
import type { OnboardingScreenshot } from './onboardingContent'

export function OnboardingShot({ shot }: { shot: OnboardingScreenshot }) {
  const src = onboardingImageUrl(shot.filename)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  if (!src) {
    return (
      <figure className="onboarding-shot onboarding-shot-missing">
        <div className="onboarding-shot-placeholder">
          <span>Screenshot not generated yet ({shot.filename})</span>
          <code>npm run onboarding:capture</code>
        </div>
        <figcaption>{shot.caption}</figcaption>
      </figure>
    )
  }

  return (
    <>
      <figure className="onboarding-shot">
        <button
          type="button"
          className="onboarding-shot-frame"
          title="Click to enlarge screenshot"
          onClick={() => setOpen(true)}
        >
          <span className="onboarding-shot-zoom" aria-hidden="true">
            <Maximize2 size={13} />
          </span>
          <img src={src} alt={shot.caption} loading="lazy" />
        </button>
        <figcaption>
          {shot.badge && <span className="onboarding-shot-badge">{shot.badge}</span>}
          <span>{shot.caption}</span>
        </figcaption>
      </figure>

      {open &&
        createPortal(
          <div
            className="onboarding-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={shot.caption}
            onClick={close}
          >
            <button
              type="button"
              className="onboarding-lightbox-close"
              aria-label="Close screenshot preview"
              onClick={close}
            >
              <X size={18} aria-hidden="true" />
            </button>
            <div className="onboarding-lightbox-content" onClick={event => event.stopPropagation()}>
              <img src={src} alt={shot.caption} />
              <p>{shot.caption}</p>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
