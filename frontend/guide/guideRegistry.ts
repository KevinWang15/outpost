import { buildGuideCatalog } from './guide'

const markdownFiles = import.meta.glob<string>('../../docs/guide/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const imageModules = import.meta.glob<string>('../../docs/images/*.{png,jpg,jpeg,webp,gif,svg}', {
  import: 'default',
  eager: true,
})

export const guideImages: ReadonlyMap<string, string> = new Map(
  Object.entries(imageModules).map(([filePath, url]) => [filePath.split('/').pop() ?? filePath, url]),
)

export const guideCatalog = buildGuideCatalog(markdownFiles)
