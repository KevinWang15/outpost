import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildGuideCatalog,
  extractHeadings,
  parseFrontmatter,
  parseGuideDocument,
  resolveGuideImage,
  resolveGuideLink,
  searchGuideEntries,
  slugFromPathname,
  slugifyHeading,
} from '../../frontend/guide/guide'

test('parseFrontmatter handles YAML key/values, quotes, CRLF, and plain markdown without frontmatter', () => {
  const { meta, body } = parseFrontmatter(
    '---\r\ntitle: "Machine CLI"\r\nsection: Tools & Workflows\r\norder: 50\r\n---\r\n\r\n# Machine CLI\r\nHello\r\n',
  )
  assert.deepEqual(meta, { title: 'Machine CLI', section: 'Tools & Workflows', order: '50' })
  assert.equal(body, '# Machine CLI\nHello\n')

  const plain = parseFrontmatter('# No Frontmatter\nBody text')
  assert.deepEqual(plain.meta, {})
  assert.equal(plain.body, '# No Frontmatter\nBody text')
})

test('extractHeadings skips fenced code blocks and deduplicates identical heading slugs', () => {
  const md = [
    '# Title',
    '## Setup',
    '```bash',
    '## Not a heading inside code',
    '```',
    '### Details',
    '## Setup',
    '### Details',
  ].join('\n')
  const headings = extractHeadings(md)
  assert.deepEqual(
    headings.map(({ level, text, id }) => ({ level, text, id })),
    [
      { level: 2, text: 'Setup', id: 'setup' },
      { level: 3, text: 'Details', id: 'details' },
      { level: 2, text: 'Setup', id: 'setup-2' },
      { level: 3, text: 'Details', id: 'details-2' },
    ],
  )
  assert.equal(slugifyHeading('Auto-open in Outpost (`OSC 7770`)'), 'auto-open-in-outpost-osc-7770')
})

test('resolveGuideLink handles relative .md links, /guide routes, anchors, app routes, and rejects unsafe schemes', () => {
  const slugs = new Set(['overview', 'machine-cli'])
  assert.deepEqual(resolveGuideLink('05-machine-cli.md#auto-open-in-outpost', slugs), {
    kind: 'guide',
    slug: 'machine-cli',
    hash: 'auto-open-in-outpost',
  })
  assert.deepEqual(resolveGuideLink('/guide/machine-cli', slugs), { kind: 'guide', slug: 'machine-cli' })
  assert.deepEqual(resolveGuideLink('#installing-the-cli', slugs), { kind: 'anchor', hash: 'installing-the-cli' })
  assert.deepEqual(resolveGuideLink('/chat', slugs), { kind: 'app', href: '/chat' })
  assert.deepEqual(resolveGuideLink('https://example.com/docs', slugs), {
    kind: 'external',
    href: 'https://example.com/docs',
  })
  assert.equal(resolveGuideLink('javascript:alert(1)', slugs), null)
  assert.equal(resolveGuideLink('missing-page.md', slugs), null)
  assert.equal(slugFromPathname('/guide'), null)
  assert.equal(slugFromPathname('/guide/machine-cli'), 'machine-cli')

  const images = new Map([
    ['workspace.png', '/assets/workspace.png'],
    ['nested/diagram.png', '/assets/nested-diagram.png'],
  ])
  assert.equal(resolveGuideImage('../images/workspace.png', images), '/assets/workspace.png')
  assert.equal(resolveGuideImage('docs/images/workspace.png', images), '/assets/workspace.png')
  assert.equal(resolveGuideImage('./nested/diagram.png', images), '/assets/nested-diagram.png')
  assert.equal(resolveGuideImage('../images/missing.png', images), null)
  assert.equal(resolveGuideImage('https://example.com/a.png', images), null)
  assert.equal(resolveGuideImage('../../etc/passwd', images), null)
  assert.equal(resolveGuideImage('../secret/workspace.png', images), null)
})

test('buildGuideCatalog filters drafts, preserves SNAKE_CASE env vars, and handles multi-token search snippets', () => {
  const catalog = buildGuideCatalog({
    '../../docs/guide/01-intro.md': [
      '---',
      'title: Intro Guide',
      'navTitle: Intro',
      'section: Start',
      'order: 10',
      'summary: Overview of configuration',
      '---',
      '# Intro Guide',
      '',
      '## Bridge Options',
      'Set `OUTPOST_DISABLE_SSH_BRIDGE=1` to bypass the interactive bridge.',
      '',
      '## Next Topic',
      'Unrelated paragraph here.',
    ].join('\n'),
    '../../docs/guide/02-hidden.md': '---\ntitle: Hidden\ndraft: true\n---\n# Hidden\nSecret',
  })

  assert.equal(catalog.pages.length, 1)
  assert.equal(catalog.pages[0].navTitle, 'Intro')
  assert.equal(catalog.pages[0].headings[0].id, 'bridge-options')
  assert.match(catalog.pages[0].headings[0].searchText ?? '', /OUTPOST_DISABLE_SSH_BRIDGE=1/)
  assert.doesNotMatch(catalog.pages[0].headings[0].searchText ?? '', /Unrelated paragraph/)

  // Query spans title ("Intro") + body ("OUTPOST_DISABLE_SSH_BRIDGE") — snippet must still center on the body hit.
  const hits = searchGuideEntries(catalog.searchItems, 'Intro OUTPOST_DISABLE_SSH_BRIDGE')
  assert.equal(hits.length, 2)
  assert.match(hits[0].snippet, /OUTPOST_DISABLE_SSH_BRIDGE/)
  assert.equal(hits[0].matchedTerm, 'outpost_disable_ssh_bridge')
})

test('real docs/guide/*.md files form a valid catalog with Machine CLI and zero broken internal links', () => {
  const dir = join(process.cwd(), 'docs', 'guide')
  const entries = readdirSync(dir).filter(name => name.endsWith('.md'))
  assert.ok(entries.length >= 5, 'expected multiple markdown guide pages in docs/guide')

  const files: Record<string, string> = {}
  for (const name of entries) {
    files[`../../docs/guide/${name}`] = readFileSync(join(dir, name), 'utf8')
  }
  const catalog = buildGuideCatalog(files)
  assert.equal(catalog.pages.length, entries.length)
  assert.equal(catalog.bySlug.size, entries.length, 'every guide page must have a unique slug')

  // Machine CLI guide must exist and be searchable.
  const cliDoc = catalog.bySlug.get('machine-cli')
  assert.ok(cliDoc, 'expected docs/guide/05-machine-cli.md with slug "machine-cli"')
  assert.match(cliDoc.body, /outpost new/)
  assert.match(cliDoc.body, /OSC 7770/)
  assert.match(cliDoc.body, /install-cli/)

  const cliHits = searchGuideEntries(catalog.searchItems, 'OSC 7770')
  assert.ok(cliHits.length >= 1)
  assert.equal(cliHits[0].item.slug, 'machine-cli')

  // Unified article + heading search index returns matched terms and breadcrumbs.
  const paletteHits = searchGuideEntries(catalog.searchItems, 'split pane chooser')
  assert.ok(paletteHits.length >= 1)
  assert.equal(paletteHits[0].item.slug, 'terminals')
  assert.ok(paletteHits[0].matchedTerm)
  assert.ok(cliDoc.breadcrumbs.length >= 2)
  assert.equal(cliDoc.breadcrumbs.at(-1)?.title, cliDoc.title)

  // Verify every internal markdown link and image across all docs resolves to a real target.
  const imageDir = join(process.cwd(), 'docs', 'images')
  const availableImages = new Map(readdirSync(imageDir).map(name => [name, `/assets/${name}`] as const))
  const knownSlugs = new Set(catalog.bySlug.keys())
  const linkPattern = /(?<!!)\[[^\]]+\]\(([^)\s]+)\)/g
  const imagePattern = /!\[[^\]]*\]\(([^)\s]+)\)/g
  let totalImages = 0
  for (const page of catalog.pages) {
    assert.ok(page.title.length > 0, `missing title in ${page.sourcePath}`)
    assert.ok(page.summary.length > 0, `missing summary in ${page.sourcePath}`)
    // Strip fenced code blocks before scanning links and images.
    const withoutCode = page.body.replace(/```[\s\S]*?```/g, '')
    for (const match of withoutCode.matchAll(linkPattern)) {
      const href = match[1]
      const resolved = resolveGuideLink(href, knownSlugs)
      assert.ok(resolved, `broken or unsafe link "${href}" in ${page.sourcePath}`)
      if (resolved.kind === 'guide' && resolved.hash) {
        const target = catalog.bySlug.get(resolved.slug)!
        assert.ok(
          target.headings.some(h => h.id === resolved.hash),
          `broken anchor "#${resolved.hash}" on "${resolved.slug}" referenced from ${page.sourcePath}`,
        )
      }
    }
    for (const match of withoutCode.matchAll(imagePattern)) {
      const src = match[1]
      const resolved = resolveGuideImage(src, availableImages)
      assert.ok(resolved, `broken or unsupported image "${src}" in ${page.sourcePath}`)
      totalImages++
    }
  }
  assert.ok(totalImages >= 1, 'expected at least one screenshot attached in docs/guide')

  // parseGuideDocument fallback works without frontmatter.
  const minimal = parseGuideDocument('docs/guide/99-custom.md', '# Custom Topic\n\n## Section A\n')
  assert.equal(minimal.slug, 'custom')
  assert.equal(minimal.title, 'Custom Topic')
  assert.equal(minimal.headings[0].id, 'section-a')
})
