// Markdown-backed User Guide parser, catalog builder, search, and link resolver.
// Shared between the Vite frontend and Node unit tests (no Node-only builtins).

export interface GuideHeading {
  level: 2 | 3
  text: string
  id: string
}

export interface GuidePageDoc {
  slug: string
  title: string
  section: string
  order: number
  summary: string
  body: string
  headings: GuideHeading[]
  sourcePath: string
}

export interface GuideSection {
  title: string
  pages: GuidePageDoc[]
}

export interface GuideCatalog {
  pages: GuidePageDoc[]
  sections: GuideSection[]
  bySlug: Map<string, GuidePageDoc>
}

export interface GuideSearchHit {
  page: GuidePageDoc
  score: number
  snippet: string
  matchedHeading?: GuideHeading
}

export type ResolvedGuideLink =
  | { kind: 'guide'; slug: string; hash?: string }
  | { kind: 'anchor'; hash: string }
  | { kind: 'app'; href: string }
  | { kind: 'external'; href: string }
  | null

/** Convert heading text to a GitHub-style URL fragment slug. */
export function slugifyHeading(text: string): string {
  const cleaned = text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || 'section'
}

/** Create a stateful heading ID generator that deduplicates identical headings on one page. */
export function createHeadingSlugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return (text: string) => {
    const base = slugifyHeading(text)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count + 1}`
  }
}

/** Parse simple key: value YAML frontmatter at the top of a Markdown file. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const normalized = raw.replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized }
  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return { meta: {}, body: normalized }
  const afterClose = normalized.slice(end + 4)
  if (afterClose !== '' && !afterClose.startsWith('\n')) return { meta: {}, body: normalized }

  const header = normalized.slice(4, end)
  const meta: Record<string, string> = {}
  for (const line of header.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) continue
    const key = trimmed.slice(0, colon).trim().toLowerCase()
    let value = trimmed.slice(colon + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[key] = value
  }
  const body = afterClose.replace(/^\n+/, '')
  return { meta, body }
}

/** Extract H2 and H3 headings from Markdown while ignoring fenced code blocks. */
export function extractHeadings(body: string): GuideHeading[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const headings: GuideHeading[] = []
  const slugger = createHeadingSlugger()
  let fence: string | null = null

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) fence = marker[0].repeat(marker.length)
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const match = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/)
    if (!match) continue
    const level = match[1].length
    if (level < 2 || level > 3) continue
    const text = match[2]
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_~]/g, '')
      .trim()
    const id = slugger(match[2])
    headings.push({ level: level as 2 | 3, text, id })
  }
  return headings
}

export function slugFromPath(filePath: string): string {
  const filename = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath
  return filename
    .replace(/\.md$/i, '')
    .replace(/^\d+[-_]/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function parseGuideDocument(filePath: string, raw: string): GuidePageDoc {
  const { meta, body } = parseFrontmatter(raw)
  const slug = (meta.slug ? slugFromPath(meta.slug) : slugFromPath(filePath)) || 'guide'
  const h1Match = body.match(/^#\s+(.*?)\s*#*\s*$/m)
  const title = meta.title?.trim() || h1Match?.[1]?.trim() || slug
  const section = meta.section?.trim() || 'Guide'
  const parsedOrder = meta.order !== undefined ? Number(meta.order) : Number.NaN
  const order = Number.isFinite(parsedOrder) ? parsedOrder : 999
  const summary = meta.summary?.trim() || ''
  const headings = extractHeadings(body)
  return {
    slug,
    title,
    section,
    order,
    summary,
    body,
    headings,
    sourcePath: filePath,
  }
}

export function buildGuideCatalog(files: Record<string, string>): GuideCatalog {
  const pages = Object.entries(files)
    .map(([filePath, raw]) => parseGuideDocument(filePath, raw))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))

  const bySlug = new Map<string, GuidePageDoc>()
  const sectionMap = new Map<string, GuidePageDoc[]>()
  for (const page of pages) {
    bySlug.set(page.slug, page)
    const list = sectionMap.get(page.section) ?? []
    list.push(page)
    sectionMap.set(page.section, list)
  }
  const sections: GuideSection[] = [...sectionMap.entries()].map(([title, items]) => ({
    title,
    pages: items,
  }))
  return { pages, sections, bySlug }
}

function stripMarkdownForSnippet(markdown: string): string {
  return markdown
    .replace(/^\s*(?:```+|~~~+).*$/gm, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s*(\[![A-Z]+\])?\s*/gm, '')
    .replace(/[*_~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function searchGuide(pages: readonly GuidePageDoc[], query: string): GuideSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const terms = needle.split(/\s+/).filter(Boolean)
  const hits: GuideSearchHit[] = []

  for (const page of pages) {
    const titleLower = page.title.toLowerCase()
    const summaryLower = page.summary.toLowerCase()
    const sectionLower = page.section.toLowerCase()
    const plainBody = stripMarkdownForSnippet(page.body)
    const bodyLower = plainBody.toLowerCase()
    const haystack = `${titleLower}\n${summaryLower}\n${sectionLower}\n${bodyLower}`

    if (!terms.every(term => haystack.includes(term))) continue

    let score = 0
    if (titleLower.includes(needle)) score += 100
    else if (terms.every(term => titleLower.includes(term))) score += 70
    if (summaryLower.includes(needle)) score += 40

    const matchedHeading =
      page.headings.find(h => h.text.toLowerCase().includes(needle)) ??
      page.headings.find(h => terms.some(term => h.text.toLowerCase().includes(term)))
    if (matchedHeading) score += 35

    let snippet = page.summary
    const firstIndex = bodyLower.indexOf(needle) !== -1 ? bodyLower.indexOf(needle) : bodyLower.indexOf(terms[0])
    if (firstIndex !== -1) {
      let occurrences = 0
      let cursor = 0
      while (occurrences < 10) {
        const at = bodyLower.indexOf(needle, cursor)
        if (at === -1) break
        occurrences++
        cursor = at + needle.length
      }
      score += 15 + occurrences * 3
      const start = Math.max(0, firstIndex - 42)
      const end = Math.min(plainBody.length, firstIndex + 96)
      const prefix = start > 0 ? '…' : ''
      const suffix = end < plainBody.length ? '…' : ''
      snippet = `${prefix}${plainBody.slice(start, end).trim()}${suffix}`
    }

    hits.push({ page, score, snippet, matchedHeading })
  }

  return hits.sort((a, b) => b.score - a.score || a.page.order - b.page.order)
}

export function guideHref(slug: string, hash?: string): string {
  return hash ? `/guide/${slug}#${hash}` : `/guide/${slug}`
}

export function slugFromPathname(pathname: string): string | null {
  const trimmed = pathname.replace(/\/+$/, '')
  if (trimmed === '/guide') return null
  if (trimmed.startsWith('/guide/')) {
    const rest = trimmed.slice('/guide/'.length)
    return rest && !rest.includes('/') ? rest : null
  }
  return null
}

/** Resolve a link inside a guide Markdown document into safe SPA or external navigation. */
export function resolveGuideLink(rawHref: string, knownSlugs: ReadonlySet<string>): ResolvedGuideLink {
  const href = rawHref.trim()
  if (!href) return null

  // Same-page heading anchor
  if (href.startsWith('#')) {
    const hash = href.slice(1).trim()
    return hash ? { kind: 'anchor', hash } : null
  }

  // Internal guide link: /guide, /guide/slug, /guide/slug#hash
  if (href === '/guide' || href.startsWith('/guide/') || href.startsWith('/guide#')) {
    const [pathPart, hash] = href.split('#', 2)
    const slug = slugFromPathname(pathPart)
    if (slug && knownSlugs.has(slug)) {
      return { kind: 'guide', slug, ...(hash ? { hash } : {}) }
    }
    if (!slug) {
      const first = [...knownSlugs][0]
      return first ? { kind: 'guide', slug: first, ...(hash ? { hash } : {}) } : null
    }
    return null
  }

  // Relative markdown link: machine-cli.md, ./05-machine-cli.md#auto-open
  if (!href.includes('://') && !href.startsWith('/') && !href.startsWith('mailto:')) {
    const [pathPart, hash] = href.split('#', 2)
    const cleanPath = pathPart.replace(/^\.\//, '')
    if (/^[\w.-]+\.md$/i.test(cleanPath)) {
      const slug = slugFromPath(cleanPath)
      if (knownSlugs.has(slug)) {
        return { kind: 'guide', slug, ...(hash ? { hash } : {}) }
      }
    }
    return null
  }

  // Same-origin Outpost app routes (/, /chat, /logs, /desktop)
  if (href.startsWith('/') && !href.startsWith('//')) {
    return { kind: 'app', href }
  }

  // External safe URL
  try {
    const parsed = new URL(href)
    if (['http:', 'https:', 'mailto:'].includes(parsed.protocol) && !parsed.username && !parsed.password) {
      return { kind: 'external', href: parsed.href }
    }
  } catch {
    return null
  }
  return null
}
