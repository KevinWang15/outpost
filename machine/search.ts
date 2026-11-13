// Read-only lookups for creating sessions: native conversations matching a
// keyword, and directories under a typed path.
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ConversationMatch, ConversationResults, DirectorySuggestions } from '../shared/model'
import { isHarnessId } from '../shared/harnesses'
import type { SessionRecord } from '../shared/model'
import { allHarnesses, harness } from './harnesses'
import { RegistryError } from './registry'
import { clean, Scan, SearchLimit } from './stores'

const controlCharacters = (value: string) => [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)

export function searchConversations(query: unknown, tool: unknown, sessions: SessionRecord[]): ConversationResults {
  if (typeof query !== 'string' || !query.trim() || query.length > 256 || controlCharacters(query))
    throw new RegistryError('Enter a search keyword of 1–256 characters.', 400)
  if (tool !== undefined && !isHarnessId(tool)) throw new RegistryError('Unsupported coding tool', 400)
  const needle = query.trim().toLowerCase()
  const env = process.env as Record<string, string>
  const scopes = [{ env, cwd: undefined as string | undefined }]
  for (const session of sessions)
    scopes.push({ env: { ...env, ...session.config.env, ...session.storage }, cwd: session.rootDir })
  const scan = new Scan()
  const results: ConversationMatch[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  let truncated = false
  try {
    for (const adapter of tool ? [harness(tool)] : allHarnesses())
      for (const { env: environment, cwd } of scopes)
        for (const conversation of adapter.discover(environment, scan, cwd)) {
          const key = JSON.stringify([adapter.id, conversation.id, conversation.storage])
          if (seen.has(key)) continue
          seen.add(key)
          let excerpt: string | null = null
          search: for (const path of conversation.history)
            for (const record of adapter.historyBytes
              ? scan.decodedRecords(path, file => adapter.historyBytes!(file))
              : scan.records(path))
              for (const text of adapter.text(record)) {
                const at = text.toLowerCase().indexOf(needle)
                if (at < 0) continue
                // One bounded excerpt; transcripts never cross the connection.
                excerpt = clean(text.slice(Math.max(0, at - 70), at + needle.length + 180))
                break search
              }
          if (
            excerpt === null &&
            !conversation.title.toLowerCase().includes(needle) &&
            !conversation.id.toLowerCase().includes(needle)
          )
            continue
          results.push({
            tool: adapter.id,
            conversation: conversation.id,
            storage: conversation.storage,
            rootDir: conversation.root,
            title: clean(conversation.title, 160),
            createdAt: conversation.created,
            updatedAt: conversation.updated,
            excerpt,
            managedSessionIds: sessions
              .filter(
                session =>
                  session.tool === adapter.id &&
                  JSON.stringify(session.storage) === JSON.stringify(conversation.storage) &&
                  session.conversations.some(item => item.id === conversation.id && !item.movedTo),
              )
              .map(session => session.id),
          })
          results.sort((a, b) =>
            `${b.updatedAt ?? ''}\0${b.tool}\0${b.conversation}` < `${a.updatedAt ?? ''}\0${a.tool}\0${a.conversation}`
              ? -1
              : 1,
          )
          if (results.length > 50) {
            results.pop()
            truncated = true
          }
        }
  } catch (error) {
    if (!(error instanceof SearchLimit)) throw error
    truncated = true
    warnings.push(
      'Search reached its time, file, or byte limit. Results are partial; choose one coding tool to narrow the search.',
    )
  }
  if (scan.skipped) warnings.push(`${scan.skipped} unreadable, incomplete, or oversized records were skipped.`)
  return { sessions: results, truncated, warnings }
}

export function directories(prefix: unknown): DirectorySuggestions {
  if (typeof prefix !== 'string' || prefix.length > 4096 || controlCharacters(prefix))
    throw new RegistryError('Invalid directory path', 400)
  const typed = prefix === '' || prefix === '~' ? '~/' : prefix
  if (!typed.startsWith('/') && !typed.startsWith('~/'))
    throw new RegistryError('Directory path must be absolute or begin with ~/', 400)
  const slash = typed.lastIndexOf('/')
  const parent = typed.slice(0, slash + 1)
  const name = typed.slice(slash + 1)
  const directory = parent.startsWith('~/') ? homedir() + parent.slice(1) : parent
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { directories: [], truncated: false }
    if (code === 'EACCES') throw new RegistryError('Permission denied while reading the directory', 403)
    throw new RegistryError(`Could not read the directory: ${(error as Error).message}`, 400)
  }
  const matches = entries
    .filter(entry => entry.startsWith(name) && (!entry.startsWith('.') || name.startsWith('.')))
    .map(entry => `${parent}${entry}/`)
    .filter(
      candidate => candidate.length <= 4096 && !controlCharacters(candidate) && !/[\uD800-\uDFFF]/.test(candidate),
    )
    .filter(candidate => {
      try {
        return statSync(directory + candidate.slice(parent.length)).isDirectory()
      } catch {
        return false // Gone or unreadable meanwhile.
      }
    })
    .sort()
  return { directories: matches.slice(0, 50), truncated: matches.length > 50 }
}
