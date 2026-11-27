import { useCallback, useLayoutEffect, useRef, useState, type UIEvent } from 'react'

/** Keeps a scrollable transcript pinned to the bottom until the user scrolls up,
 * then offers a "Latest" jump once new content arrives. */
export function usePinnedScroll(deps: readonly unknown[], onScrollExtra?: (element: HTMLDivElement) => void) {
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [behind, setBehind] = useState(false)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    if (pinned.current) element.scrollTop = element.scrollHeight
    else setBehind(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
    if (pinned.current) setBehind(false)
    onScrollExtra?.(element)
  }

  const jumpToLatest = () => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
    pinned.current = true
    setBehind(false)
  }

  const pin = useCallback(() => {
    pinned.current = true
  }, [])

  return { scroller, behind, onScroll, jumpToLatest, pin }
}
