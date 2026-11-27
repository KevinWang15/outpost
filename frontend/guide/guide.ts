// Markdown-backed User Guide parser, catalog, breadcrumbs, search index, and link/image resolver.

export interface GuideHeading {
  level: 2 | 3 | 4
  text: string
  id: string
  searchText?: string
}

export interface GuideBreadcrumb {
  title: string
  slug?: string
}

export interface GuidePageDoc {
  slug: string
  title: string
  navTitle: string
  section: string
  order: number
  summary: string
  body: string
  headings: GuideHeading[]
  breadcrumbs: GuideBreadcrumb[]
  sourcePath: string
}

export interface GuideSection {
  title: string
  pages: GuidePageDoc[]
}

export interface GuideSearchItem {
  id: string
  kind: 'article' | 'heading'
  slug: string
  hash?: string
  title: string
  section: string
  description: string
  breadcrumbLabels: string
  text: string
}

export interface GuidePaletteHit {
  item: GuideSearchItem
  score: number
  snippet: string
  matchedTerm: string | null
}

export interface GuideCatalog {
  pages: GuidePageDoc[]
  sections: GuideSection[]
  bySlug: Map<string, GuidePageDoc>
  searchItems: GuideSearchItem[]
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
    .replace(/&/g, ' and ')
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

function stripMarkdownForSnippet(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s*(\[![A-Z]+\])?\s*/gm, '')
    .replace(/(^|\W)__([^_\n]+?)__(\W|$)/g, '$1$2$3')
    .replace(/(^|\W)_([^_\n]+?)_(\W|$)/g, '$1$2$3')
    .replace(/[*~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Extract H2–H4 headings (and each heading's section text for search) in a single pass while ignoring fenced code blocks. */
export function extractHeadings(body: string): GuideHeading[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const rawHeadings: Array<{ level: 2 | 3 | 4; text: string; id: string; lineIndex: number }> = []
  const slugger = createHeadingSlugger()
  let fence: string | null = null

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
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
    if (level < 2 || level > 4) continue
    const text = match[2]
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*_~]/g, '')
      .trim()
    rawHeadings.push({ level: level as 2 | 3 | 4, text, id: slugger(match[2]), lineIndex: index })
  }

  return rawHeadings.map((heading, idx) => {
    let endLine = lines.length
    for (let next = idx + 1; next < rawHeadings.length; next++) {
      if (rawHeadings[next].level <= heading.level) {
        endLine = rawHeadings[next].lineIndex
        break
      }
    }
    const searchText = stripMarkdownForSnippet(lines.slice(heading.lineIndex + 1, endLine).join('\n')).slice(0, 1600)
    return {
      level: heading.level,
      text: heading.text,
      id: heading.id,
      ...(searchText ? { searchText } : {}),
    }
  })
}

function slugSegment(raw: string): string {
  return raw
    .replace(/\.md$/i, '')
    .replace(/^\d+[-_]/, '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-|-$/g, '')
}

function slugFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const guideMarker = normalized.lastIndexOf('/docs/guide/')
  const rel = guideMarker >= 0 ? normalized.slice(guideMarker + '/docs/guide/'.length) : normalized.split('/').pop()!
  const parts = rel.split('/').filter(Boolean)
  if (parts.length > 1 && parts[parts.length - 1].toLowerCase() === 'index.md') {
    parts.pop()
  }
  return parts.map(slugSegment).filter(Boolean).join('/')
}

function buildGuideDocument(filePath: string, meta: Record<string, string>, body: string): GuidePageDoc {
  const slug = (meta.slug ? slugFromPath(meta.slug) : slugFromPath(filePath)) || 'guide'
  const h1Match = body.match(/^#\s+(.*?)\s*#*\s*$/m)
  const title = meta.title?.trim() || h1Match?.[1]?.trim() || slug
  const navTitle = meta.navtitle?.trim() || title
  const section = meta.section?.trim() || 'Guide'
  const orderRaw = meta.order ?? meta.weight
  const parsedOrder = orderRaw !== undefined ? Number(orderRaw) : Number.NaN
  const order = Number.isFinite(parsedOrder) ? parsedOrder : 999
  const summary = (meta.summary ?? meta.description)?.trim() || ''
  const headings = extractHeadings(body)
  return {
    slug,
    title,
    navTitle,
    section,
    order,
    summary,
    body,
    headings,
    breadcrumbs: [],
    sourcePath: filePath,
  }
}

export function parseGuideDocument(filePath: string, raw: string): GuidePageDoc {
  const { meta, body } = parseFrontmatter(raw)
  return buildGuideDocument(filePath, meta, body)
}

export function buildGuideCatalog(files: Record<string, string>): GuideCatalog {
  const pages = Object.entries(files)
    .map(([filePath, raw]) => {
      const { meta, body } = parseFrontmatter(raw)
      if (meta.draft?.toLowerCase() === 'true') return null
      return buildGuideDocument(filePath, meta, body)
    })
    .filter((page): page is GuidePageDoc => page !== null)
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

  const firstSlug = pages[0]?.slug
  for (const page of pages) {
    const sectionFirst = sectionMap.get(page.section)?.[0]
    const crumbs: GuideBreadcrumb[] = [{ title: 'User Guide', slug: firstSlug }]
    if (sectionFirst && sectionFirst.slug !== page.slug) {
      crumbs.push({ title: page.section, slug: sectionFirst.slug })
    } else if (page.section) {
      crumbs.push({ title: page.section })
    }
    crumbs.push({ title: page.title })
    page.breadcrumbs = crumbs
  }

  const searchItems = buildSearchItems(pages)
  return { pages, sections, bySlug, searchItems }
}

function buildSearchItems(pages: readonly GuidePageDoc[]): GuideSearchItem[] {
  const items: GuideSearchItem[] = []
  for (const page of pages) {
    const plainBody = stripMarkdownForSnippet(page.body)
    items.push({
      id: `article:${page.slug}`,
      kind: 'article',
      slug: page.slug,
      title: page.title,
      section: page.section,
      description: page.summary,
      breadcrumbLabels: `${page.section} / ${page.title}`,
      text: plainBody,
    })
    for (const heading of page.headings) {
      items.push({
        id: `heading:${page.slug}#${heading.id}`,
        kind: 'heading',
        slug: page.slug,
        hash: heading.id,
        title: heading.text,
        section: page.section,
        description: heading.searchText ? heading.searchText.slice(0, 180) : page.summary,
        breadcrumbLabels: `${page.section} / ${page.title}`,
        text: heading.searchText ?? '',
      })
    }
  }
  return items
}

function buildSnippet(text: string, needle: string, terms: string[], fallback: string): string {
  if (!text) return fallback
  const lower = text.toLowerCase()
  let index = lower.indexOf(needle)
  if (index === -1) {
    for (const term of terms) {
      const at = lower.indexOf(term)
      if (at !== -1) {
        index = at
        break
      }
    }
  }
  if (index === -1) return fallback || text.slice(0, 140)
  const start = Math.max(0, index - 42)
  const end = Math.min(text.length, index + 110)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).trim()}${suffix}`
}

function pickMatchedTerm(terms: string[]): string | null {
  return (
    [...terms]
      .map(term => term.trim())
      .filter(term => term.length >= 2)
      .sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? null
  )
}

/** Multi-token search across both articles and individual H2–H4 headings. */
export function searchGuideEntries(items: readonly GuideSearchItem[], query: string): GuidePaletteHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const terms = needle.split(/\s+/).filter(Boolean)
  const matchedTerm = pickMatchedTerm(terms)
  const hits: GuidePaletteHit[] = []

  for (const item of items) {
    const titleLower = item.title.toLowerCase()
    const descLower = item.description.toLowerCase()
    const crumbLower = item.breadcrumbLabels.toLowerCase()
    const textLower = item.text.toLowerCase()
    const haystack = `${titleLower}\n${descLower}\n${crumbLower}\n${textLower}`

    if (!terms.every(term => haystack.includes(term))) continue

    let score = item.kind === 'article' ? 12 : 8
    if (titleLower === needle) score += 140
    else if (titleLower.includes(needle)) score += 100
    else if (terms.every(term => titleLower.includes(term))) score += 72

    if (descLower.includes(needle)) score += 36
    if (crumbLower.includes(needle)) score += 24

    let occurrences = 0
    let cursor = 0
    while (occurrences < 8) {
      const at = textLower.indexOf(needle, cursor)
      if (at === -1) break
      occurrences++
      cursor = at + needle.length
    }
    score += occurrences * 4

    const snippet = buildSnippet(item.text, needle, terms, item.description)
    hits.push({
      item,
      score,
      snippet,
      matchedTerm,
    })
  }

  return hits.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
}

export function guideHref(slug: string, hash?: string): string {
  return hash ? `/guide/${slug}#${hash}` : `/guide/${slug}`
}

export function slugFromPathname(pathname: string): string | null {
  const trimmed = pathname.replace(/\/+$/, '')
  if (trimmed === '/guide') return null
  if (trimmed.startsWith('/guide/')) {
    const rest = trimmed.slice('/guide/'.length)
    return rest && !rest.includes('..') ? rest : null
  }
  return null
}

/** Resolve a link inside a guide Markdown document into safe SPA or external navigation. */
export function resolveGuideLink(rawHref: string, knownSlugs: ReadonlySet<string>): ResolvedGuideLink {
  const href = rawHref.trim()
  if (!href) return null

  if (href.startsWith('#')) {
    const hash = href.slice(1).trim()
    return hash ? { kind: 'anchor', hash } : null
  }

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

  if (!href.includes('://') && !href.startsWith('/') && !href.startsWith('mailto:')) {
    const [pathPart, hash] = href.split('#', 2)
    const cleanPath = pathPart.replace(/^\.\//, '')
    if (/^[\w./-]+\.md$/i.test(cleanPath) && !cleanPath.includes('..')) {
      const slug = slugFromPath(cleanPath)
      if (knownSlugs.has(slug)) {
        return { kind: 'guide', slug, ...(hash ? { hash } : {}) }
      }
    }
    return null
  }

  if (href.startsWith('/') && !href.startsWith('//')) {
    return { kind: 'app', href }
  }

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

/** Resolve a guide image reference (e.g. `../images/workspace.png` or `./assets/diagram.png`) to its bundled asset URL. */
export function resolveGuideImage(rawSrc: string, images: ReadonlyMap<string, string>): string | null {
  const src = rawSrc.trim()
  if (!src || src.includes('://') || src.startsWith('//')) return null
  const normalized = src
    .replace(/\\/g, '/')
    .replace(/^\.\.\/images\//, '')
    .replace(/^(?:\.\/)?docs\/images\//, '')
    .replace(/^(?:\.\/)?images\//, '')
    .replace(/^\.\//, '')
  if (normalized.includes('..') || !/^[\w./-]+\.(?:png|jpe?g|webp|gif|svg)$/i.test(normalized)) return null
  return images.get(normalized) ?? images.get(normalized.split('/').pop() ?? '') ?? null
}
