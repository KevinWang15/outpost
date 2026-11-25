import { buildGuideCatalog } from '../../shared/guide'

const markdownFiles = import.meta.glob<string>('../../docs/guide/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
})

export const guideCatalog = buildGuideCatalog(markdownFiles)
