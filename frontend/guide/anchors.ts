// Smooth anchor scrolling and temporary search-match highlighting for the User Guide.
const DEFAULT_SCROLL_Y = 96
const SEARCH_TARGET_HIGHLIGHT_CLASS = 'search-target-highlight'
const SEARCH_INLINE_HIGHLIGHT_CLASS = 'search-inline-highlight'
const HIGHLIGHT_BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, blockquote, aside, tr, pre, header'

let clearActiveHighlight: (() => void) | null = null

interface ScrollHighlightOptions {
  matchedTerm?: string | null
  scrollOffset?: number
}

export function scrollToAnchorWithHighlight(anchor: string, options: ScrollHighlightOptions = {}) {
  const element = document.getElementById(anchor)
  if (!(element instanceof HTMLElement)) return

  const cleanupInlineHighlight = options.matchedTerm ? highlightMatchedTerm(element, options.matchedTerm) : null
  highlightElement(element, cleanupInlineHighlight)

  const targetTop = window.scrollY + element.getBoundingClientRect().top - (options.scrollOffset ?? DEFAULT_SCROLL_Y)
  window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
}

export function highlightSearchMatchInScopes(
  scopes: Array<HTMLElement | null | undefined>,
  matchedTerm: string | null,
  scrollOffset = DEFAULT_SCROLL_Y,
) {
  for (const scope of scopes) {
    if (!(scope instanceof HTMLElement)) continue
    const cleanupInlineHighlight = matchedTerm ? highlightMatchedTerm(scope, matchedTerm) : null
    if (!cleanupInlineHighlight) continue

    const firstMark = scope.querySelector(`.${SEARCH_INLINE_HIGHLIGHT_CLASS}`)
    const highlightTarget =
      (firstMark instanceof HTMLElement ? firstMark.closest<HTMLElement>(HIGHLIGHT_BLOCK_SELECTOR) : null) ?? scope
    highlightElement(highlightTarget, cleanupInlineHighlight)

    const scrollTarget = firstMark instanceof HTMLElement ? firstMark : highlightTarget
    const targetTop = window.scrollY + scrollTarget.getBoundingClientRect().top - scrollOffset
    window.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
    return true
  }
  return false
}

export function dismissSearchHighlight() {
  clearActiveHighlight?.()
}

function highlightElement(element: HTMLElement, cleanupInlineHighlight: (() => void) | null) {
  clearActiveHighlight?.()

  element.classList.remove(SEARCH_TARGET_HIGHLIGHT_CLASS)
  void element.offsetWidth
  element.classList.add(SEARCH_TARGET_HIGHLIGHT_CLASS)

  let timerId: number | null = null
  const dismiss = () => {
    if (timerId !== null) {
      window.clearTimeout(timerId)
      timerId = null
    }
    element.classList.remove(SEARCH_TARGET_HIGHLIGHT_CLASS)
    cleanupInlineHighlight?.()
    window.removeEventListener('click', dismiss, true)
    if (clearActiveHighlight === dismiss) clearActiveHighlight = null
  }

  clearActiveHighlight = dismiss
  timerId = window.setTimeout(() => {
    timerId = null
    if (clearActiveHighlight === dismiss) {
      window.addEventListener('click', dismiss, true)
    }
  }, 0)
}

function highlightMatchedTerm(anchorElement: HTMLElement, matchedTerm: string) {
  const normalizedTerm = normalizeHighlightTerm(matchedTerm)
  if (!normalizedTerm) return null

  const regex = new RegExp(escapeHighlightTerm(normalizedTerm), 'gi')
  const marks = collectHighlightRoots(anchorElement).flatMap(root => wrapMatchesInRoot(root, regex))
  if (marks.length === 0) return null

  return () => {
    for (const mark of marks) unwrapMark(mark)
  }
}

function collectHighlightRoots(anchorElement: HTMLElement): HTMLElement[] {
  if (!anchorElement.classList.contains('guide-heading')) return [anchorElement]

  const headingLevel = getHeadingLevel(anchorElement)
  if (!headingLevel) return [anchorElement]

  const roots: HTMLElement[] = [anchorElement]
  let sibling = anchorElement.nextElementSibling
  while (sibling instanceof HTMLElement) {
    const siblingHeadingLevel = getHeadingLevel(sibling)
    if (siblingHeadingLevel && siblingHeadingLevel <= headingLevel) break
    roots.push(sibling)
    sibling = sibling.nextElementSibling
  }
  return roots
}

function getHeadingLevel(element: Element): number | null {
  const match = element.tagName.match(/^H([1-6])$/)
  return match ? Number(match[1]) : null
}

function wrapMatchesInRoot(root: HTMLElement, regex: RegExp): HTMLElement[] {
  const textNodes = collectTextNodes(root)
  const marks: HTMLElement[] = []

  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? ''
    regex.lastIndex = 0
    if (!regex.test(value)) continue
    regex.lastIndex = 0

    const fragment = document.createDocumentFragment()
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(value)) !== null) {
      if (match.index > lastIndex) fragment.append(value.slice(lastIndex, match.index))
      const mark = document.createElement('mark')
      mark.className = SEARCH_INLINE_HIGHLIGHT_CLASS
      mark.textContent = match[0]
      fragment.append(mark)
      marks.push(mark)
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < value.length) fragment.append(value.slice(lastIndex))
    textNode.parentNode?.replaceChild(fragment, textNode)
  }
  return marks
}

function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node instanceof Text) || !node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest(`.${SEARCH_INLINE_HIGHLIGHT_CLASS}`)) return NodeFilter.FILTER_REJECT
      if (parent.closest('script, style, textarea, button')) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const textNodes: Text[] = []
  let current = walker.nextNode()
  while (current instanceof Text) {
    textNodes.push(current)
    current = walker.nextNode()
  }
  return textNodes
}

function unwrapMark(mark: HTMLElement) {
  const parent = mark.parentNode
  if (!parent) return
  parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
  parent.normalize()
}

function normalizeHighlightTerm(term: string | null): string | null {
  const normalized = term?.trim()
  return normalized && normalized.length >= 2 ? normalized : null
}

function escapeHighlightTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
