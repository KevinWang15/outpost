import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Link as LinkIcon, Search, X } from 'lucide-react'
import {
  createHeadingSlugger,
  guideHref,
  resolveGuideImage,
  resolveGuideLink,
  searchGuide,
  slugFromPathname,
} from './guide'
import { AppSidebar } from '../ui/AppSidebar'
import { Markdown } from '../ui/Markdown'
import { guideCatalog, guideImages } from './guideRegistry'
import '../styles/guide.scss'

function initialSlug(): string {
  const fromPath = slugFromPathname(window.location.pathname)
  if (fromPath && guideCatalog.bySlug.has(fromPath)) return fromPath
  return guideCatalog.pages[0]?.slug ?? ''
}

function scrollToHash(hash: string) {
  if (!hash) return
  const target = document.getElementById(hash)
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

export default function GuidePage() {
  const [slug, setSlug] = useState<string>(initialSlug)
  const [query, setQuery] = useState('')
  const [activeHeading, setActiveHeading] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const knownSlugs = useMemo(() => new Set(guideCatalog.pages.map(page => page.slug)), [])
  const current = guideCatalog.bySlug.get(slug) ?? guideCatalog.pages[0]
  const currentIndex = guideCatalog.pages.findIndex(page => page.slug === current?.slug)
  const previousPage = currentIndex > 0 ? guideCatalog.pages[currentIndex - 1] : null
  const nextPage =
    currentIndex >= 0 && currentIndex + 1 < guideCatalog.pages.length ? guideCatalog.pages[currentIndex + 1] : null

  const searchHits = useMemo(() => searchGuide(guideCatalog.pages, query), [query])

  const navigate = useCallback((nextSlug: string, hash?: string) => {
    if (!guideCatalog.bySlug.has(nextSlug)) return
    setSlug(nextSlug)
    setQuery('')
    const url = guideHref(nextSlug, hash)
    if (window.location.pathname + window.location.hash !== url) {
      window.history.pushState(null, '', url)
    }
    requestAnimationFrame(() => {
      if (hash) scrollToHash(hash)
      else window.scrollTo({ top: 0, behavior: 'auto' })
    })
  }, [])

  const jumpAnchor = useCallback(
    (hash: string) => {
      if (!current) return
      const url = guideHref(current.slug, hash)
      window.history.replaceState(null, '', url)
      setActiveHeading(hash)
      scrollToHash(hash)
    },
    [current],
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
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
              event.preventDefault()
              navigate(resolved.slug, resolved.hash)
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
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
              event.preventDefault()
              jumpAnchor(resolved.hash)
            }}
          >
            {children}
          </a>
        )
      }
      if (resolved.kind === 'app')
        return (
          <a key={key} href={resolved.href}>
            {children}
          </a>
        )
      return (
        <a key={key} href={resolved.href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      )
    },
    [knownSlugs, navigate, jumpAnchor],
  )

  const renderGuideImage = useCallback((src: string, alt: string, key: number, block: boolean) => {
    const resolved = resolveGuideImage(src, guideImages)
    if (!resolved) return null
    if (!block) return <img key={key} className="guide-inline-image" src={resolved} alt={alt} loading="lazy" />
    return (
      <figure key={key} className="guide-figure">
        <div className="guide-figure-frame">
          <img src={resolved} alt={alt} loading="lazy" />
        </div>
        {alt && <figcaption>{alt}</figcaption>}
      </figure>
    )
  }, [])

  const createHeadingRenderer = useCallback(() => {
    const slugger = createHeadingSlugger()
    return (level: number, raw: string, children: ReactNode, key: number) => {
      const id = slugger(raw)
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <Tag key={key} id={id} className="guide-heading">
          <span>{children}</span>
          {level >= 2 && level <= 3 && (
            <a
              className="guide-heading-anchor"
              href={`#${id}`}
              aria-label={`Link to ${raw}`}
              onClick={event => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                event.preventDefault()
                jumpAnchor(id)
              }}
            >
              <LinkIcon size={14} />
            </a>
          )}
        </Tag>
      )
    }
  }, [jumpAnchor])

  // Keep page title, URL, and hash scroll aligned on load and browser Back/Forward.
  useEffect(() => {
    if (!current) return
    document.title = `${current.title} · User Guide · Outpost`
    const initialHash = window.location.hash.replace(/^#/, '')
    if (initialHash) {
      requestAnimationFrame(() => scrollToHash(initialHash))
    }
  }, [current])

  useEffect(() => {
    const onPopState = () => {
      const next = initialSlug()
      setSlug(next)
      const hash = window.location.hash.replace(/^#/, '')
      requestAnimationFrame(() => {
        if (hash) scrollToHash(hash)
        else window.scrollTo({ top: 0, behavior: 'auto' })
      })
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Press `/` anywhere outside an input to focus guide search.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
      const active = document.activeElement
      if (active instanceof HTMLElement && active.matches('input, textarea, select, [contenteditable="true"]')) return
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Track which heading is closest to the top of the viewport for the right-hand TOC.
  useEffect(() => {
    if (!current || !current.headings.length) return
    const ids = current.headings.map(heading => heading.id)
    const updateActive = () => {
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
      <div className="app guide-app">
        <AppSidebar page="guide">
          <div className="sidebar-heading">
            <span>User guide</span>
          </div>
        </AppSidebar>
        <main className="content">
          <div className="empty page-empty">
            <BookOpen size={24} />
            <p>No guide pages found.</p>
          </div>
        </main>
      </div>
    )
  }

  const trimmedQuery = query.trim()
  const articleBody = current.body.replace(/^#\s+.*(?:\n+|$)/, '')

  return (
    <div className="app guide-app">
      <AppSidebar page="guide">
        <div className="guide-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            aria-label="Search user guide"
            placeholder="Search guide… (/)"
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                setQuery('')
                searchInputRef.current?.blur()
              } else if (event.key === 'Enter' && searchHits.length > 0) {
                const top = searchHits[0]
                navigate(top.page.slug, top.matchedHeading?.id)
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="guide-search-clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery('')
                searchInputRef.current?.focus()
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>

        {trimmedQuery ? (
          <div className="guide-search-results" role="region" aria-label="Search results">
            <div className="sidebar-heading">
              <span>
                {searchHits.length} {searchHits.length === 1 ? 'result' : 'results'}
              </span>
            </div>
            {searchHits.length === 0 ? (
              <p className="guide-search-empty muted">No guide topics match “{trimmedQuery}”.</p>
            ) : (
              <nav aria-label="Matching guide pages">
                {searchHits.map(hit => (
                  <button
                    key={hit.page.slug}
                    type="button"
                    className={`nav-item guide-hit ${hit.page.slug === current.slug ? 'active' : ''}`}
                    onClick={() => navigate(hit.page.slug, hit.matchedHeading?.id)}
                  >
                    <span>
                      <strong>{hit.page.title}</strong>
                      <small>{hit.matchedHeading ? `# ${hit.matchedHeading.text}` : hit.page.section}</small>
                      {hit.snippet && <small className="guide-hit-snippet">{hit.snippet}</small>}
                    </span>
                  </button>
                ))}
              </nav>
            )}
          </div>
        ) : (
          <div className="guide-nav-groups">
            {guideCatalog.sections.map(section => (
              <div key={section.title} className="guide-nav-group">
                <div className="sidebar-heading">
                  <span>{section.title}</span>
                </div>
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
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
                            return
                          event.preventDefault()
                          navigate(page.slug)
                        }}
                      >
                        <span>
                          <strong>{page.title}</strong>
                        </span>
                      </a>
                    )
                  })}
                </nav>
              </div>
            ))}
          </div>
        )}
      </AppSidebar>

      <main className="content guide-content">
        <div className="guide-shell">
          <article className="guide-article">
            <div className="guide-breadcrumb">
              <BookOpen size={14} aria-hidden="true" />
              <span>User Guide</span>
              <span aria-hidden="true">/</span>
              <span>{current.section}</span>
            </div>
            <h1 className="guide-title">{current.title}</h1>
            {current.summary && <p className="guide-summary">{current.summary}</p>}
            <Markdown
              text={articleBody}
              className="guide-prose"
              headingOffset={0}
              callouts
              softBreaks={false}
              defaultCodeLanguage="text"
              renderLink={renderGuideLink}
              renderImage={renderGuideImage}
              createHeadingRenderer={createHeadingRenderer}
            />
            {(previousPage || nextPage) && (
              <nav className="guide-pager" aria-label="Guide pages">
                {previousPage ? (
                  <a
                    className="guide-pager-card"
                    href={guideHref(previousPage.slug)}
                    onClick={event => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                      event.preventDefault()
                      navigate(previousPage.slug)
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
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
                      event.preventDefault()
                      navigate(nextPage.slug)
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
                    className={`guide-toc-link level-${heading.level} ${activeHeading === heading.id ? 'active' : ''}`}
                    onClick={event => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
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
    </div>
  )
}
