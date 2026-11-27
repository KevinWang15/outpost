// User Guide view integrated into Outpost's AppSidebar and light-slate design system:
// Cmd/Ctrl+K search palette across articles & headings, match highlighting on jump,
// collapsible section tree, breadcrumbs, Copy Markdown, zoomable image lightbox,
// expandable tables, syntax-highlighted code blocks, and HTML/SVG previews.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  ClipboardCopy,
  Link as LinkIcon,
  Search,
} from 'lucide-react'
import { copyText } from '../browser'
import { isPlainLeftClick, navigate as routerNavigate, replaceUrl, useLocation } from '../router'
import { SidebarBody } from '../ui/AppSidebar'
import { Link } from '../ui/Link'
import { Markdown } from '../ui/Markdown'
import { dismissSearchHighlight, highlightSearchMatchInScopes, scrollToAnchorWithHighlight } from './anchors'
import {
  createHeadingSlugger,
  guideHref,
  resolveGuideImage,
  resolveGuideLink,
  slugFromPathname,
  type GuidePaletteHit,
} from './guide'
import { guideCatalog, guideImages } from './guideRegistry'
import { ExpandableTable, GuideBlockquote, GuideCodeFence, ImageLightbox } from './GuideWidgets'
import { SearchPalette } from './SearchPalette'
import '../styles/guide.scss'

interface PendingHighlight {
  slug: string
  hash?: string
  term: string | null
}

const knownSlugs = new Set(guideCatalog.pages.map(page => page.slug))

const renderGuideImage = (src: string, alt: string, key: number, block: boolean): ReactNode => {
  const resolved = resolveGuideImage(src, guideImages)
  if (!resolved) return null
  if (!block) return <img key={key} className="guide-inline-image" src={resolved} alt={alt} loading="lazy" />
  return <ImageLightbox key={key} src={resolved} alt={alt} />
}

const renderGuideTable = (table: ReactNode, key: number): ReactNode => (
  <ExpandableTable key={key}>{table}</ExpandableTable>
)

const renderGuideCodeBlock = (code: string, language: string, key: number): ReactNode => (
  <GuideCodeFence key={key} code={code} language={language} />
)

const renderGuideBlockquote = (
  quotedLines: string[],
  renderNested: (markdown: string) => ReactNode[],
  key: number,
): ReactNode => <GuideBlockquote key={key} quotedLines={quotedLines} renderNested={renderNested} />

function slugForPathname(pathname: string): string {
  const fromPath = slugFromPathname(pathname)
  if (fromPath && guideCatalog.bySlug.has(fromPath)) return fromPath
  return guideCatalog.pages[0]?.slug ?? ''
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"))
}

export default function GuidePage() {
  const location = useLocation()
  const slug = slugForPathname(location.pathname)
  const [activeHeading, setActiveHeading] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})
  const [copiedMarkdown, setCopiedMarkdown] = useState(false)
  const [highlightNonce, setHighlightNonce] = useState(0)
  const pendingHighlightRef = useRef<PendingHighlight | null>(null)
  const heroRef = useRef<HTMLElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const copyTimerRef = useRef<number | null>(null)

  const current = guideCatalog.bySlug.get(slug) ?? guideCatalog.pages[0]
  const currentIndex = guideCatalog.pages.findIndex(page => page.slug === current?.slug)
  const previousPage = currentIndex > 0 ? guideCatalog.pages[currentIndex - 1] : null
  const nextPage =
    currentIndex >= 0 && currentIndex + 1 < guideCatalog.pages.length ? guideCatalog.pages[currentIndex + 1] : null

  const isMac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform)
  const shortcutLabel = isMac ? '⌘K' : 'Ctrl+K'

  const navigateGuide = useCallback(
    (nextSlug: string, hash?: string, matchedTerm: string | null = null) => {
      const targetPage = guideCatalog.bySlug.get(nextSlug)
      if (!targetPage) return
      dismissSearchHighlight()
      setCollapsedSections(prev => (prev[targetPage.section] ? { ...prev, [targetPage.section]: false } : prev))
      const url = guideHref(nextSlug, hash)
      if (hash || matchedTerm) {
        pendingHighlightRef.current = { slug: nextSlug, hash, term: matchedTerm }
        setHighlightNonce(n => n + 1)
      } else {
        pendingHighlightRef.current = null
        requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'auto' }))
      }
      routerNavigate(url, { transition: false })
    },
    [setCollapsedSections, setHighlightNonce],
  )

  const jumpAnchor = useCallback(
    (hash: string) => {
      if (!current) return
      pendingHighlightRef.current = { slug: current.slug, hash, term: null }
      setActiveHeading(hash)
      setHighlightNonce(n => n + 1)
      replaceUrl(guideHref(current.slug, hash))
    },
    [current, setActiveHeading, setHighlightNonce],
  )

  function handleSearchSelect(hit: GuidePaletteHit) {
    setSearchOpen(false)
    navigateGuide(hit.item.slug, hit.item.hash, hit.matchedTerm)
  }

  function handleCopyMarkdown() {
    if (!current) return
    void copyText(current.body)
      .then(() => {
        setCopiedMarkdown(true)
        if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
        copyTimerRef.current = window.setTimeout(() => {
          setCopiedMarkdown(false)
          copyTimerRef.current = null
        }, 1600)
      })
      .catch(() => {})
  }

  useEffect(
    () => () => {
      dismissSearchHighlight()
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
    },
    [],
  )

  const renderGuideLink = useCallback(
    (href: string, children: ReactNode, key: number) => {
      const resolved = resolveGuideLink(href, knownSlugs)
      if (!resolved) return <span key={key}>{children}</span>
      if (resolved.kind === 'guide') {
        return (
          <a
            key={key}
            href={guideHref(resolved.slug, resolved.hash)}
            onClick={event => {
              if (!isPlainLeftClick(event)) return
              event.preventDefault()
              navigateGuide(resolved.slug, resolved.hash)
            }}
          >
            {children}
          </a>
        )
      }
      if (resolved.kind === 'anchor') {
        return (
          <a
            key={key}
            href={`#${resolved.hash}`}
            onClick={event => {
              if (!isPlainLeftClick(event)) return
              event.preventDefault()
              jumpAnchor(resolved.hash)
            }}
          >
            {children}
          </a>
        )
      }
      if (resolved.kind === 'app') {
        return (
          <Link key={key} href={resolved.href}>
            {children}
          </Link>
        )
      }
      return (
        <a key={key} href={resolved.href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      )
    },
    [navigateGuide, jumpAnchor],
  )

  const createHeadingRenderer = useCallback(() => {
    const slugger = createHeadingSlugger()
    return (level: number, raw: string, children: ReactNode, key: number) => {
      // Only assign TOC/anchor IDs to H2–H4 so generated slugs always match extractHeadings().
      const id = level >= 2 && level <= 4 ? slugger(raw) : undefined
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag key={key} id={id} className={id ? 'guide-heading' : undefined}>
          <span>{children}</span>
          {id && (
            <a
              className="guide-heading-anchor"
              href={`#${id}`}
              aria-label={`Link to ${raw}`}
              onClick={event => {
                if (!isPlainLeftClick(event)) return
                event.preventDefault()
                jumpAnchor(id)
              }}
            >
              <LinkIcon size={14} aria-hidden="true" />
            </a>
          )}
        </Tag>
      )
    }
  }, [jumpAnchor])

  // Sync document title, consume one-shot search highlights, or scroll to a URL hash / top.
  useEffect(() => {
    if (!current) return
    document.title = `${current.title} · User Guide · Outpost`
    const pending = pendingHighlightRef.current
    if (pending && pending.slug === current.slug) {
      const frame = requestAnimationFrame(() => {
        pendingHighlightRef.current = null
        if (pending.hash) {
          scrollToAnchorWithHighlight(pending.hash, { matchedTerm: pending.term })
        } else if (pending.term) {
          highlightSearchMatchInScopes([heroRef.current, bodyRef.current], pending.term)
        }
      })
      return () => cancelAnimationFrame(frame)
    }
    pendingHighlightRef.current = null
    dismissSearchHighlight()
    const hash = location.hash.replace(/^#/, '')
    const frame = requestAnimationFrame(() => {
      if (hash) scrollToAnchorWithHighlight(hash)
      else window.scrollTo({ top: 0, behavior: 'auto' })
    })
    return () => cancelAnimationFrame(frame)
  }, [current, location.hash, highlightNonce])

  // Press Cmd/Ctrl+K (toggles even while palette input is focused) or `/` to open search palette.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (document.querySelector('.guide-lightbox')) return
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        if (!searchOpen && isEditableTarget(event.target)) return
        event.preventDefault()
        setSearchOpen(open => !open)
        return
      }
      if (isEditableTarget(event.target)) return
      if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [searchOpen])

  // Track active heading in viewport for the right-hand TOC.
  useEffect(() => {
    if (!current || !current.headings.length) return
    const ids = current.headings.map(heading => heading.id)
    const updateActive = () => {
      const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
      if (nearBottom && window.scrollY > 0) {
        setActiveHeading(ids[ids.length - 1])
        return
      }
      let chosen = ids[0]
      for (const id of ids) {
        const element = document.getElementById(id)
        if (element && element.getBoundingClientRect().top <= 120) {
          chosen = id
        }
      }
      setActiveHeading(chosen)
    }
    updateActive()
    window.addEventListener('scroll', updateActive, { passive: true })
    return () => window.removeEventListener('scroll', updateActive)
  }, [current])

  if (!current) {
    return (
      <>
        <SidebarBody>
          <div className="sidebar-heading">
            <span>User guide</span>
          </div>
        </SidebarBody>
        <main className="content">
          <div className="empty page-empty">
            <BookOpen size={24} />
            <p>No guide pages found.</p>
          </div>
        </main>
      </>
    )
  }

  const articleBody = current.body.replace(/^#\s+.*(?:\n+|$)/, '')
  const resolvedActiveHeading = current.headings.some(heading => heading.id === activeHeading)
    ? activeHeading
    : (current.headings[0]?.id ?? '')

  return (
    <>
      <SidebarBody>
        <button
          type="button"
          className="guide-search-trigger"
          aria-label="Search user guide"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={14} aria-hidden="true" />
          <span className="guide-search-placeholder">Search guide…</span>
          <kbd className="guide-kbd">{shortcutLabel}</kbd>
        </button>

        <div className="guide-nav-groups">
          {guideCatalog.sections.map(section => {
            const isExpanded = !collapsedSections[section.title]
            return (
              <div key={section.title} className="guide-nav-group">
                <button
                  type="button"
                  className="guide-nav-section-btn"
                  aria-expanded={isExpanded}
                  onClick={() =>
                    setCollapsedSections(prev => ({
                      ...prev,
                      [section.title]: isExpanded,
                    }))
                  }
                >
                  <span>{section.title}</span>
                  <ChevronRight
                    size={13}
                    aria-hidden="true"
                    className={`guide-nav-chevron${isExpanded ? ' expanded' : ''}`}
                  />
                </button>
                {isExpanded && (
                  <nav aria-label={section.title}>
                    {section.pages.map(page => {
                      const active = page.slug === current.slug
                      return (
                        <a
                          key={page.slug}
                          href={guideHref(page.slug)}
                          className={`nav-item guide-nav-link ${active ? 'active' : ''}`}
                          aria-current={active ? 'page' : undefined}
                          onClick={event => {
                            if (!isPlainLeftClick(event)) return
                            event.preventDefault()
                            navigateGuide(page.slug)
                          }}
                        >
                          <span>
                            <strong>{page.navTitle}</strong>
                          </span>
                        </a>
                      )
                    })}
                  </nav>
                )}
              </div>
            )
          })}
        </div>
      </SidebarBody>

      <main className="content guide-content">
        <div className="guide-shell">
          <article className="guide-article">
            <div className="guide-topbar">
              <nav aria-label="Breadcrumb" className="guide-breadcrumb">
                <BookOpen size={14} aria-hidden="true" />
                {current.breadcrumbs.map((crumb, index) => {
                  const isLast = index === current.breadcrumbs.length - 1
                  return (
                    <span key={`${crumb.title}-${index}`} className="guide-breadcrumb-item">
                      {index > 0 && <ChevronRight size={13} aria-hidden="true" className="guide-breadcrumb-sep" />}
                      {isLast || !crumb.slug ? (
                        <span className={isLast ? 'current' : undefined}>{crumb.title}</span>
                      ) : (
                        <a
                          href={guideHref(crumb.slug)}
                          onClick={event => {
                            if (!isPlainLeftClick(event)) return
                            event.preventDefault()
                            navigateGuide(crumb.slug!)
                          }}
                        >
                          {crumb.title}
                        </a>
                      )}
                    </span>
                  )
                })}
              </nav>

              <button
                type="button"
                className="button small guide-copy-md"
                onClick={handleCopyMarkdown}
                title={copiedMarkdown ? 'Copied Markdown to clipboard' : 'Copy page as Markdown'}
              >
                {copiedMarkdown ? (
                  <Check size={13} aria-hidden="true" />
                ) : (
                  <ClipboardCopy size={13} aria-hidden="true" />
                )}
                <span>{copiedMarkdown ? 'Copied' : 'Copy Markdown'}</span>
              </button>
            </div>

            <header className="guide-hero" ref={heroRef}>
              <h1 className="guide-title">{current.title}</h1>
              {current.summary && <p className="guide-summary">{current.summary}</p>}
            </header>

            <div ref={bodyRef}>
              <Markdown
                text={articleBody}
                className="guide-prose"
                headingOffset={0}
                softBreaks={false}
                defaultCodeLanguage="text"
                renderLink={renderGuideLink}
                renderImage={renderGuideImage}
                renderCodeBlock={renderGuideCodeBlock}
                renderTable={renderGuideTable}
                renderBlockquote={renderGuideBlockquote}
                createHeadingRenderer={createHeadingRenderer}
              />
            </div>

            {(previousPage || nextPage) && (
              <nav className="guide-pager" aria-label="Guide pages">
                {previousPage ? (
                  <a
                    className="guide-pager-card"
                    href={guideHref(previousPage.slug)}
                    onClick={event => {
                      if (!isPlainLeftClick(event)) return
                      event.preventDefault()
                      navigateGuide(previousPage.slug)
                    }}
                  >
                    <span className="guide-pager-label">
                      <ArrowLeft size={13} /> Previous
                    </span>
                    <strong>{previousPage.title}</strong>
                  </a>
                ) : (
                  <div />
                )}
                {nextPage && (
                  <a
                    className="guide-pager-card next"
                    href={guideHref(nextPage.slug)}
                    onClick={event => {
                      if (!isPlainLeftClick(event)) return
                      event.preventDefault()
                      navigateGuide(nextPage.slug)
                    }}
                  >
                    <span className="guide-pager-label">
                      Next <ArrowRight size={13} />
                    </span>
                    <strong>{nextPage.title}</strong>
                  </a>
                )}
              </nav>
            )}
          </article>

          {current.headings.length > 0 && (
            <aside className="guide-toc" aria-label="On this page">
              <div className="guide-toc-title">On this page</div>
              <nav>
                {current.headings.map(heading => (
                  <a
                    key={heading.id}
                    href={`#${heading.id}`}
                    className={`guide-toc-link level-${heading.level} ${resolvedActiveHeading === heading.id ? 'active' : ''}`}
                    onClick={event => {
                      if (!isPlainLeftClick(event)) return
                      event.preventDefault()
                      jumpAnchor(heading.id)
                    }}
                  >
                    {heading.text}
                  </a>
                ))}
              </nav>
            </aside>
          )}
        </div>
      </main>

      <SearchPalette
        isOpen={searchOpen}
        items={guideCatalog.searchItems}
        onClose={() => setSearchOpen(false)}
        onSelect={handleSearchSelect}
      />
    </>
  )
}
