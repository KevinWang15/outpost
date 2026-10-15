import { useLayoutEffect, type RefObject } from 'react'

/** Follow the visible screen above the keyboard, without reflowing terminal text during pinch zoom. */
export function useTerminalViewport(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = ref.current!
    const viewport = window.visualViewport
    if (!viewport) return
    let frame = 0
    const update = () => {
      frame = 0
      const zoomed = Math.abs(viewport.scale - 1) > 0.01
      element.style.setProperty('--terminal-touch-action', zoomed ? 'auto' : 'pinch-zoom')
      if (zoomed) return
      element.style.setProperty('--viewport-height', `${viewport.height}px`)
      element.style.setProperty('--viewport-width', `${viewport.width}px`)
      element.style.setProperty('--viewport-top', `${viewport.offsetTop}px`)
      element.style.setProperty('--viewport-left', `${viewport.offsetLeft}px`)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    viewport.addEventListener('resize', schedule)
    viewport.addEventListener('scroll', schedule)
    window.addEventListener('pageshow', schedule)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener('resize', schedule)
      viewport.removeEventListener('scroll', schedule)
      window.removeEventListener('pageshow', schedule)
    }
  }, [ref])
}
