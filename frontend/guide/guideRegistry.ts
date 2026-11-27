import { buildGuideCatalog } from './guide'

const markdownFiles = import.meta.glob<string>('../../docs/guide/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const sharedImages = import.meta.glob<string>('../../docs/images/*.{png,jpg,jpeg,webp,gif,svg}', {
  import: 'default',
  eager: true,
})

const colocatedImages = import.meta.glob<string>('../../docs/guide/**/*.{png,jpg,jpeg,webp,gif,svg}', {
  import: 'default',
  eager: true,
})

// Index images by relative path (so nested co-located assets never collide) and by basename as a fallback.
const imageMap = new Map<string, string>()
for (const [filePath, url] of Object.entries(sharedImages)) {
  const name = filePath.split('/').pop()
  if (name) imageMap.set(name, url)
}
for (const [filePath, url] of Object.entries(colocatedImages)) {
  const marker = '/docs/guide/'
  const idx = filePath.lastIndexOf(marker)
  const rel = idx >= 0 ? filePath.slice(idx + marker.length) : filePath
  imageMap.set(rel, url)
  const name = rel.split('/').pop()
  if (name && !imageMap.has(name)) imageMap.set(name, url)
}

export const guideImages: ReadonlyMap<string, string> = imageMap

export const guideCatalog = buildGuideCatalog(markdownFiles)
