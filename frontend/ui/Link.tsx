// Progressive-enhancement SPA link: renders a real `<a>` for accessibility and modifier clicks,
// prefetches lazy route chunks on hover/focus, and transitions without full page reloads.
import type { AnchorHTMLAttributes, FocusEvent, MouseEvent } from 'react'
import { isPlainLeftClick, navigate } from '../router'
import { prefetchRoute } from '../routes'

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string
  replace?: boolean
  prefetch?: boolean
}

export function Link({
  href,
  replace,
  prefetch = true,
  target,
  download,
  onClick,
  onMouseEnter,
  onFocus,
  ...rest
}: LinkProps) {
  const handlePrefetch = () => {
    if (prefetch) prefetchRoute(href)
  }

  function handleMouseEnter(event: MouseEvent<HTMLAnchorElement>) {
    onMouseEnter?.(event)
    handlePrefetch()
  }

  function handleFocus(event: FocusEvent<HTMLAnchorElement>) {
    onFocus?.(event)
    handlePrefetch()
  }

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event)
    if (event.defaultPrevented || !isPlainLeftClick(event)) return
    if (download !== undefined || (target && target !== '_self')) return
    event.preventDefault()
    navigate(href, { replace })
  }

  return (
    <a
      href={href}
      target={target}
      download={download}
      onMouseEnter={handleMouseEnter}
      onFocus={handleFocus}
      onClick={handleClick}
      {...rest}
    />
  )
}
