import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { historyMessagePage, type HistorySearchInput, type HistorySource } from '../../shared/history'
import type { Signer } from '../signed'
import type { Embed } from './embeddings'
import { historyNote, normalized, type Row } from './schema'

const poolLimit = 512

export interface Coverage {
  searchableChunks: number
  embeddedChunks: number
  pendingChunks: number
}

function buildFilters(input: HistorySearchInput, machineIds: string[]) {
  const where = [`s.machine_id IN (${machineIds.map(() => '?').join(',') || 'NULL'})`]
  const values: SQLInputValue[] = [...machineIds]
  for (const [value, column] of [
    [input.machine, 's.machine_id'],
    [input.tool, 's.tool'],
    [input.cwd, 's.cwd'],
    [input.role, 'm.role'],
  ] as const)
    if (value !== undefined) {
      where.push(`${column}=?`)
      values.push(value)
    }
  if (input.sessionId !== undefined) {
    // A history session, or an Outpost session across its whole timeline.
    where.push('(s.session_id=? OR s.outpost_session=?)')
    values.push(input.sessionId, input.sessionId)
  }
  for (const [value, operator] of [
    [input.after, '>='],
    [input.before, '<='],
  ] as const)
    if (value !== undefined) {
      const end = operator === '<='
      const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z` : value
      const parsed = new Date(time)
      if (Number.isNaN(parsed.valueOf())) throw new Error('Use YYYY-MM-DD or an ISO timestamp for history dates.')
      where.push(`m.timestamp ${operator} ?`)
      values.push(parsed.toISOString())
    }
  // A summary repeats messages that are indexed, unless they are gone from the store.
  where.push(
    `(m.kind<>'summary' OR (s.parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM messages b WHERE b.source_id=m.source_id AND b.position<m.position)))`,
  )
  return { sql: where.join(' AND '), values }
}

const sealCursor = (cursors: Signer, row: Row) => cursors.seal({ id: Number(row.id), generation: row.generation })

function openAnchor(db: DatabaseSync, cursors: Signer, cursor: string, machineIds: string[]): Row {
  const value = cursors.open(cursor)
  if (!value || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || typeof value.generation !== 'string')
    throw new Error('Invalid history cursor. Use a cursor returned by this account’s search.')
  const row = db
    .prepare(
      'SELECT m.*,s.machine,s.machine_id,s.session_id,s.outpost_session,s.tool,s.native_id,s.title,s.cwd FROM messages m JOIN sources s ON s.id=m.source_id WHERE m.id=?',
    )
    .get(value.id) as Row | undefined
  if (!row || row.generation !== value.generation || !machineIds.includes(String(row.machine_id)))
    throw new Error('Stale history cursor or machine no longer accessible. Search again.')
  return row
}

function compactedAfter(db: DatabaseSync, row: Row) {
  return Boolean(
    db
      .prepare("SELECT 1 FROM messages WHERE source_id=? AND kind='summary' AND position>? LIMIT 1")
      .get(row.source_id, row.position),
  )
}

function occurrenceOf(db: DatabaseSync, cursors: Signer, row: Row) {
  return {
    cursor: sealCursor(cursors, row),
    machine: JSON.parse(String(row.machine)),
    sessionId: row.session_id,
    nativeSessionId: row.native_id,
    ...(row.outpost_session ? { outpostSessionId: row.outpost_session } : {}),
    tool: row.tool,
    title: row.title,
    cwd: row.cwd,
    role: row.role,
    kind: row.kind,
    timestamp: row.timestamp,
    turnId: row.turn_id,
    ...(compactedAfter(db, row)
      ? { beforeCompaction: 'Before a compaction: the agent now has only a summary of this.' }
      : {}),
  }
}

function alsoIn(cursors: Signer, rows: Row[]) {
  return rows.map(row => ({
    sessionId: row.session_id,
    nativeSessionId: row.native_id,
    ...(row.outpost_session ? { outpostSessionId: row.outpost_session } : {}),
    title: row.title,
    cursor: sealCursor(cursors, row),
  }))
}

function sourceRow(db: DatabaseSync, key: string) {
  return db.prepare('SELECT * FROM sources WHERE id=?').get(key) as Row | undefined
}

/** Conversations that continue from this message in other directions. */
function branchesOf(db: DatabaseSync, cursors: Signer, row: Row) {
  return (
    db
      .prepare(
        'SELECT id,session_id,native_id,outpost_session,title,fork_position FROM sources WHERE parent_id=? AND fork_identity=? LIMIT 20',
      )
      .all(row.source_id, row.identity) as Row[]
  ).map(child => {
    const next = db
      .prepare('SELECT id,generation FROM messages WHERE source_id=? AND position>? ORDER BY position LIMIT 1')
      .get(child.id, child.fork_position) as Row | undefined
    return {
      sessionId: child.session_id,
      nativeSessionId: child.native_id,
      ...(child.outpost_session ? { outpostSessionId: child.outpost_session } : {}),
      title: child.title,
      ...(next ? { cursor: sealCursor(cursors, next) } : {}),
    }
  })
}

/** The conversation a source continues, and the message where it forked. */
function originOf(db: DatabaseSync, cursors: Signer, key: string) {
  const source = sourceRow(db, key)
  const parent = source?.parent_id ? sourceRow(db, String(source.parent_id)) : undefined
  if (!source || !parent) return null
  const at = source.fork_identity
    ? (db
        .prepare('SELECT id,generation FROM messages WHERE source_id=? AND identity=? LIMIT 1')
        .get(parent.id, source.fork_identity) as Row | undefined)
    : undefined
  return {
    sessionId: parent.session_id,
    nativeSessionId: parent.native_id,
    ...(parent.outpost_session ? { outpostSessionId: parent.outpost_session } : {}),
    title: parent.title,
    ...(at ? { cursor: sealCursor(cursors, at) } : {}),
  }
}

export async function searchHistory(
  db: DatabaseSync,
  cursors: Signer,
  embed: Embed,
  coverage: Coverage,
  input: HistorySearchInput,
  machineIds: string[],
) {
  if (!input.query.trim()) throw new Error('Enter a non-empty history query.')
  const mode = input.mode ?? 'mixed'
  const { sql, values } = buildFilters(input, machineIds)
  const terms = normalized(input.query.trim()).split(/\s+/)
  const literal =
    mode === 'substring' || (mode === 'mixed' && terms.length === 1 && /[\d_/.\\\p{Script=Han}]/u.test(terms[0]))
  const ranks = new Map<number, { score: number; similarity?: number; snippet?: string }>()
  if (mode !== 'semantic') {
    const needles = mode === 'substring' ? [normalized(input.query)] : terms
    const matches = needles.map(() => 'instr(d.normalized,?) > 0').join(' AND ')
    const ftsTerms = needles
      .filter(term => [...term].length >= 3)
      .map(term => `"${term.replaceAll('"', '""')}"`)
      .join(' OR ')
    const stamp = input.sort === 'oldest' ? 'MIN' : 'MAX'
    const order =
      input.sort === 'newest' ? 'stamp IS NULL,stamp DESC,' : input.sort === 'oldest' ? 'stamp IS NULL,stamp ASC,' : ''
    const eligible = `EXISTS (SELECT 1 FROM messages m JOIN sources s ON s.id=m.source_id WHERE m.document_id=d.id AND ${sql})`
    const timestamp = `(SELECT ${stamp}(m.timestamp) FROM messages m JOIN sources s ON s.id=m.source_id WHERE m.document_id=d.id AND ${sql}) stamp`
    const rows = ftsTerms
      ? db
          .prepare(
            `SELECT d.id,bm25(chunks_fts) lexical_rank,${timestamp}
            FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN document_chunks dc ON dc.chunk_id=c.id JOIN documents d ON d.id=dc.document_id
            WHERE chunks_fts MATCH ? AND ${matches} AND ${eligible}
            ORDER BY ${order}lexical_rank,d.id DESC LIMIT ${poolLimit}`,
          )
          .all(...values, ftsTerms, ...needles, ...values)
      : db
          .prepare(
            `SELECT d.id,${timestamp} FROM documents d WHERE ${matches} AND ${eligible}
            ORDER BY ${order}length(d.text),d.id DESC LIMIT ${poolLimit}`,
          )
          .all(...values, ...needles, ...values)
    let rank = 0
    for (const row of rows) if (!ranks.has(Number(row.id))) ranks.set(Number(row.id), { score: 1 / (60 + ++rank) })
  }
  let semanticStatus =
    mode === 'keyword' || mode === 'substring'
      ? 'not_requested'
      : literal
        ? 'literal_query'
        : coverage.embeddedChunks
          ? 'used'
          : 'pending'
  const warnings: string[] = []
  if (!literal && (mode === 'semantic' || mode === 'mixed') && coverage.embeddedChunks) {
    try {
      const query = await embed(input.query, 'query')
      const queryBytes = new Uint8Array(query.buffer, query.byteOffset, query.byteLength)
      const order =
        input.sort === 'newest' ? 'stamp DESC,distance' : input.sort === 'oldest' ? 'stamp ASC,distance' : 'distance'
      const stamp = input.sort === 'oldest' ? 'MIN' : 'MAX'
      const rows = db
        .prepare(
          `SELECT dc.document_id id,c.text snippet,vec_distance_cosine(e.embedding,?) distance,
          (SELECT ${stamp}(m.timestamp) FROM messages m JOIN sources s ON s.id=m.source_id WHERE m.document_id=dc.document_id AND ${sql}) stamp
          FROM embeddings e JOIN chunks c ON c.id=e.chunk_id JOIN document_chunks dc ON dc.chunk_id=c.id
          WHERE EXISTS (SELECT 1 FROM messages m JOIN sources s ON s.id=m.source_id WHERE m.document_id=dc.document_id AND ${sql})
          AND vec_distance_cosine(e.embedding,?) <= ?
          ORDER BY ${order} LIMIT ${poolLimit}`,
        )
        .all(queryBytes, ...values, ...values, queryBytes, 1 - (input.minSimilarity ?? 0.7))
      const seen = new Set<number>()
      rows.forEach(row => {
        if (seen.has(Number(row.id))) return
        seen.add(Number(row.id))
        const id = Number(row.id),
          old = ranks.get(id)
        ranks.set(id, {
          score: (old?.score ?? 0) + 1 / (60 + seen.size),
          similarity: 1 - Number(row.distance),
          snippet: String(row.snippet),
        })
      })
    } catch (error) {
      semanticStatus = 'unavailable'
      warnings.push(`Local semantic search is unavailable: ${(error as Error).message.slice(0, 200)}`)
      if (mode === 'semantic')
        throw new Error(warnings[0] + '. Try keyword mode while the model recovers.', { cause: error })
    }
  } else if (mode === 'semantic' && !coverage.embeddedChunks) {
    throw new Error(
      'Semantic history is still indexing. Call refresh_index with embedLimit=100, or use keyword/mixed search.',
    )
  }
  const grouped = new Map<
    string,
    {
      row: Row
      copies: Row[]
      text: string
      score: number
      similarity?: number
      occurrences: ReturnType<typeof occurrenceOf>[]
      matchingMessages: number
    }
  >()
  for (const [id, rank] of [...ranks].sort((a, b) => b[1].score - a[1].score)) {
    const order =
      input.sort === 'oldest'
        ? 'm.timestamp IS NULL,m.timestamp ASC,m.id ASC'
        : 'm.timestamp IS NULL,m.timestamp DESC,m.id DESC'
    // A message a fork or continuation copied is the same logical message:
    // reported once, where it first appeared, with the copies listed.
    const rows = db
      .prepare(
        `SELECT m.*,s.machine,s.machine_id,s.session_id,s.outpost_session,s.tool,s.native_id,s.title,s.cwd,
        (s.parent_id IS NOT NULL AND m.position<=s.fork_position) inherited,
        substr(d.text,max(1,instr(d.normalized,?)-100),700) text
        FROM messages m JOIN sources s ON s.id=m.source_id JOIN documents d ON d.id=m.document_id WHERE m.document_id=? AND ${sql}
        ORDER BY inherited,${order} LIMIT 128`,
      )
      .all(terms[0], id, ...values) as Row[]
    const logical = new Map<string, Row[]>()
    for (const row of rows) logical.set(String(row.identity), [...(logical.get(String(row.identity)) ?? []), row])
    for (const [, [row, ...copies]] of logical) {
      const key =
        input.groupBy === 'message'
          ? `text:${id}`
          : row.outpost_session
            ? `outpost:${row.outpost_session}`
            : String(row.session_id)
      const prior = grouped.get(key)
      const occurrence = {
        ...occurrenceOf(db, cursors, row),
        ...(copies.length ? { alsoIn: alsoIn(cursors, copies) } : {}),
      }
      if (prior) {
        prior.matchingMessages++
        if (prior.occurrences.length < 3) prior.occurrences.push(occurrence)
        if (rank.score > prior.score)
          Object.assign(prior, { row, copies, text: rank.snippet ?? String(row.text), ...rank })
      } else
        grouped.set(key, {
          row,
          copies,
          text: rank.snippet ?? String(row.text),
          ...rank,
          occurrences: [occurrence],
          matchingMessages: 1,
        })
    }
  }
  const ordered = [...grouped.values()].sort((a, b) =>
    input.sort && input.sort !== 'relevance'
      ? String(a.row.timestamp ?? '').localeCompare(String(b.row.timestamp ?? '')) *
          (input.sort === 'newest' ? -1 : 1) || b.score - a.score
      : b.score - a.score || Number(b.row.id) - Number(a.row.id),
  )
  const offset = input.offset ?? 0,
    limit = input.limit ?? 5
  const results = ordered.slice(offset, offset + limit).map(item => ({
    ...occurrenceOf(db, cursors, item.row),
    ...(item.copies.length ? { alsoIn: alsoIn(cursors, item.copies) } : {}),
    text: [...item.text].slice(0, 700).join(''),
    score: item.score,
    ...(item.similarity !== undefined ? { similarity: item.similarity } : {}),
    matchingMessages: item.matchingMessages,
    occurrences: item.occurrences,
    sourceTruncated: Boolean(item.row.truncated),
  }))
  return {
    results,
    nextOffset: offset + limit < ordered.length ? offset + limit : null,
    mode,
    semanticUsed: semanticStatus === 'used',
    semanticStatus,
    coverage,
    warnings,
    note: historyNote,
    candidateLimit: poolLimit,
  }
}

export function readContext(
  db: DatabaseSync,
  cursors: Signer,
  input: { cursor?: string; sessionId?: string; direction?: string; limit?: number; maxChars?: number },
  machineIds: string[],
) {
  let anchor: Row
  if (input.cursor) anchor = openAnchor(db, cursors, input.cursor, machineIds)
  else {
    const row = db
      .prepare(
        `SELECT m.*,s.machine,s.machine_id,s.session_id,s.outpost_session,s.tool,s.native_id,s.title,s.cwd FROM messages m JOIN sources s ON s.id=m.source_id
        WHERE s.session_id=? AND s.machine_id IN (${machineIds.map(() => '?').join(',') || 'NULL'}) ORDER BY m.timestamp DESC,m.id DESC LIMIT 1`,
      )
      .get(input.sessionId ?? '', ...machineIds) as Row | undefined
    if (!row) throw new Error('History session not found on an accessible machine.')
    anchor = row
  }
  if (input.cursor && input.sessionId && input.sessionId !== anchor.session_id)
    throw new Error('The history cursor belongs to another session.')
  const limit = input.limit ?? 7,
    direction = input.direction ?? 'around',
    maxChars = input.maxChars ?? 12000
  const select = (operator: string, order: string, count: number) =>
    db
      .prepare(
        `SELECT m.*,s.machine,s.machine_id,s.session_id,s.outpost_session,s.tool,s.native_id,s.title,s.cwd,substr(d.text,1,?) text
        FROM messages m JOIN sources s ON s.id=m.source_id JOIN documents d ON d.id=m.document_id
        WHERE m.source_id=? AND m.generation=? AND m.position ${operator} ? ORDER BY m.position ${order} LIMIT ?`,
      )
      .all(maxChars, anchor.source_id, anchor.generation, anchor.position, count) as Row[]
  let window: Row[]
  if (direction === 'before') window = select('<', 'DESC', limit).reverse()
  else if (direction === 'after') window = select('>', 'ASC', limit)
  else {
    const before = select('<', 'DESC', Math.floor(limit / 2)).reverse()
    window = [...before, ...select('>=', 'ASC', limit - before.length)]
  }
  let budget = input.maxChars ?? 12000
  const selected: Row[] = []
  const messages = []
  for (let i = 0; i < window.length; i++) {
    const row = window[i]
    if (budget <= 0) break
    const allowance = Math.max(1, Math.floor(budget / (window.length - i)))
    const kept = [...String(row.text)].slice(0, allowance).join(''),
      count = [...kept].length
    budget -= count
    selected.push(row)
    const branches = branchesOf(db, cursors, row)
    messages.push({
      ...occurrenceOf(db, cursors, row),
      ...(row.kind === 'summary'
        ? { compaction: 'The conversation was compacted here: this summary replaced the messages before it.' }
        : {}),
      ...(branches.length ? { branches } : {}),
      text: kept,
      totalChars: Number(row.source_chars),
      truncated: count < Number(row.source_chars),
      sourceTruncated: Boolean(row.truncated),
    })
  }
  const first = selected[0],
    last = selected.at(-1)
  const more = (row: Row, operator: string) =>
    Boolean(
      db
        .prepare(`SELECT 1 FROM messages WHERE source_id=? AND generation=? AND position ${operator} ? LIMIT 1`)
        .get(row.source_id, row.generation, row.position),
    )
  const origin = originOf(db, cursors, String(anchor.source_id))
  return {
    machine: JSON.parse(String(anchor.machine)),
    sessionId: anchor.session_id,
    messages,
    beforeCursor: first && more(first, '<') ? sealCursor(cursors, first) : null,
    afterCursor: last && more(last, '>') ? sealCursor(cursors, last) : null,
    ...(origin ? { forkedFrom: origin } : {}),
    note: historyNote,
  }
}

export function readHistoryMessage(
  db: DatabaseSync,
  cursors: Signer,
  input: { cursor: string; offset?: number; limit?: number },
  machineIds: string[],
) {
  const row = openAnchor(db, cursors, input.cursor, machineIds)
  const text = String(db.prepare('SELECT text FROM documents WHERE id=?').get(row.document_id)!.text)
  const offset = input.offset ?? 0
  const cached = historyMessagePage(text, offset, input.limit ?? 8000)
  const total = Number(row.source_chars)
  const page = {
    ...occurrenceOf(db, cursors, row),
    text: cached.text,
    totalChars: total,
    nextOffset:
      cached.nextOffset ?? (offset < cached.totalChars && cached.totalChars < total ? cached.totalChars : null),
    sourceTruncated: Boolean(row.truncated),
    note: historyNote,
  }
  if (!row.truncated || offset < cached.totalChars || offset >= total) return { page }
  const source = db.prepare('SELECT source FROM sources WHERE id=?').get(row.source_id)!
  return {
    page,
    machineId: String(row.machine_id),
    source: {
      source: JSON.parse(String(source.source)) as HistorySource,
      position: Number(row.position),
      contentHash: String(row.source_hash),
      offset,
      limit: input.limit,
    },
  }
}

export function readHistorySession(db: DatabaseSync, cursors: Signer, sessionId: string, machineIds: string[]) {
  const rows = db
    .prepare(
      `SELECT * FROM sources WHERE session_id=? AND machine_id IN (${machineIds.map(() => '?').join(',') || 'NULL'}) ORDER BY rowid`,
    )
    .all(sessionId, ...machineIds)
  if (!rows.length) throw new Error('History session not found on an accessible machine.')
  const main = rows[0]
  const timeline = main.outpost_session
    ? (
        db
          .prepare(
            `SELECT session_id,native_id,title FROM sources WHERE outpost_session=? AND machine_id IN (${machineIds.map(() => '?').join(',')}) GROUP BY session_id ORDER BY first_at`,
          )
          .all(main.outpost_session, ...machineIds) as Row[]
      ).map(row => ({
        sessionId: row.session_id,
        nativeSessionId: row.native_id,
        title: row.title,
      }))
    : []
  const children = (
    db
      .prepare(
        `SELECT DISTINCT session_id,native_id,title,outpost_session FROM sources WHERE parent_id IN (${rows.map(() => '?').join(',')})`,
      )
      .all(...rows.map(row => row.id)) as Row[]
  ).map(row => ({
    sessionId: row.session_id,
    nativeSessionId: row.native_id,
    ...(row.outpost_session ? { outpostSessionId: row.outpost_session } : {}),
    title: row.title,
  }))
  const parent = originOf(db, cursors, String(main.id))
  return {
    sessionId,
    machine: JSON.parse(String(main.machine)),
    tool: main.tool,
    nativeSessionId: main.native_id,
    title: main.title,
    cwd: main.cwd,
    ...(main.outpost_session ? { outpostSession: { id: main.outpost_session, conversations: timeline } } : {}),
    lineage: { forkedFrom: parent, branches: children },
    sources: rows.map(row => {
      const source = JSON.parse(String(row.source))
      return {
        path: source.path,
        modified: source.modified,
        checkpoint: row.checkpoint ? JSON.parse(String(row.checkpoint)).offset : 0,
      }
    }),
    note: historyNote,
  }
}
