import type { DatabaseSync } from 'node:sqlite'
import type { HistoryBatch, HistoryMachine, HistorySource } from '../../shared/history'
import { hash, normalized, parseCheckpoint, sourceKey, validCheckpoint, validMessage } from './schema'

function upsertDocument(db: DatabaseSync, text: string) {
  const digest = hash(text)
  const old = db.prepare('SELECT id FROM documents WHERE hash=?').get(digest)
  if (old) return Number(old.id)
  const id = Number(
    db.prepare('INSERT INTO documents(hash,text,normalized) VALUES(?,?,?)').run(digest, text, normalized(text))
      .lastInsertRowid,
  )
  const insert = db.prepare('INSERT OR IGNORE INTO chunks(hash,text,normalized) VALUES(?,?,?)')
  const find = db.prepare('SELECT id FROM chunks WHERE hash=?')
  const link = db.prepare('INSERT INTO document_chunks VALUES(?,?,?)')
  const characters = [...text]
  const width = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text) ? 384 : 1600
  const stride = width - Math.ceil(width / 10)
  for (let start = 0, position = 0; start < characters.length; start += stride, position++) {
    const chunk = characters.slice(start, start + width).join('')
    const key = hash(chunk)
    insert.run(key, chunk, normalized(chunk))
    link.run(id, find.get(key)!.id, position)
  }
  return id
}

/** Find which conversation each of these sources continues, and theirs. A
 * source continues another when its leading messages are that one's (the
 * tool copied them into a fork or a continuation), or when the tool says so. */
function relinkSources(db: DatabaseSync, keys: string[]) {
  if (!keys.length) return
  const marks = keys.map(() => '?').join(',')
  const affected = new Set(keys)
  // Sources that may continue these: they start with one of their messages,
  // name one of them as their origin, or continued one before.
  for (const row of db
    .prepare(
      `SELECT s.id FROM sources s WHERE s.parent_id IN (${marks})
      OR s.forked_from IN (SELECT native_id FROM sources WHERE id IN (${marks}))
      OR (SELECT identity FROM messages WHERE source_id=s.id ORDER BY position LIMIT 1)
        IN (SELECT identity FROM messages WHERE source_id IN (${marks}))`,
    )
    .all(...keys, ...keys, ...keys))
    affected.add(String(row.id))
  const first = db.prepare('SELECT identity,timestamp FROM messages WHERE source_id=? ORDER BY position LIMIT 1')
  const sharing = db.prepare(
    `SELECT DISTINCT m.source_id id FROM messages m JOIN sources s ON s.id=m.source_id
    WHERE m.identity=? AND m.source_id<>? AND s.machine_id=? AND s.tool=?`,
  )
  const named = db.prepare('SELECT id FROM sources WHERE machine_id=? AND tool=? AND native_id=? AND id<>?')
  const order = db.prepare('SELECT rowid FROM sources WHERE id=?')
  for (const key of affected) {
    const source = db.prepare('SELECT * FROM sources WHERE id=?').get(key)
    if (!source) continue
    const head = first.get(key)
    let parent: string | null = null
    if (source.forked_from)
      parent = (named.get(source.machine_id, source.tool, source.forked_from, key)?.id as string | undefined) ?? null
    else if (head) {
      // Prefer where the message first appeared (not at its start), then the oldest.
      const own = { at: String(head.timestamp ?? ''), rowid: Number(order.get(key)!.rowid) }
      let best: { id: string; origin: boolean; at: string; rowid: number } | null = null
      for (const row of sharing.all(head.identity, key, source.machine_id, source.tool)) {
        const id = String(row.id)
        const start = first.get(id)
        const candidate = {
          id,
          origin: start?.identity !== head.identity,
          at: String(start?.timestamp ?? ''),
          rowid: Number(order.get(id)!.rowid),
        }
        // Two sources starting alike: the older one is the parent, never both ways.
        if (!candidate.origin && (candidate.at > own.at || (candidate.at === own.at && candidate.rowid > own.rowid)))
          continue
        if (
          !best ||
          (candidate.origin && !best.origin) ||
          (candidate.origin === best.origin &&
            (candidate.at < best.at || (candidate.at === best.at && candidate.rowid < best.rowid)))
        )
          best = candidate
      }
      parent = best?.id ?? null
    }
    // The fork point: the last of its leading messages the parent also has.
    let forkIdentity: string | null = null
    let forkPosition: number | null = null
    if (parent)
      for (const row of db
        .prepare(
          `SELECT m.identity,m.position,EXISTS(SELECT 1 FROM messages p WHERE p.source_id=? AND p.identity=m.identity) shared
          FROM messages m WHERE m.source_id=? ORDER BY m.position`,
        )
        .iterate(parent, key)) {
        if (!row.shared) break
        forkIdentity = String(row.identity)
        forkPosition = Number(row.position)
      }
    db.prepare('UPDATE sources SET parent_id=?,fork_identity=?,fork_position=?,first_at=? WHERE id=?').run(
      parent,
      forkIdentity,
      forkPosition,
      head?.timestamp ?? null,
      key,
    )
  }
}

export function catalogSources(db: DatabaseSync, machine: HistoryMachine, sources: HistorySource[]) {
  const lookup = db.prepare('SELECT checkpoint,machine,source FROM sources WHERE id=?')
  const changed: HistorySource[] = []
  const metadata: HistoryBatch = { files: [], warnings: [] }
  const machineJson = JSON.stringify(machine)
  for (const source of sources) {
    const row = lookup.get(sourceKey(machine.id, source.id))
    const checkpoint = parseCheckpoint(row?.checkpoint)
    if (
      !checkpoint ||
      checkpoint.modified !== source.modified ||
      checkpoint.offset < checkpoint.size ||
      checkpoint.sourceSize !== source.size
    )
      changed.push(source)
    else if (row && (row.machine !== machineJson || row.source !== JSON.stringify(source)))
      metadata.files.push({ source, checkpoint, reset: false, messages: [], pending: false })
  }
  if (metadata.files.length) ingestBatch(db, machine, metadata)
  return changed
}

export function ingestBatch(db: DatabaseSync, machine: HistoryMachine, batch: HistoryBatch, commitCheckpoint = true) {
  db.exec('BEGIN IMMEDIATE')
  let inserted = 0
  try {
    for (const file of batch.files) {
      if (!validCheckpoint(file.checkpoint)) throw new Error('The machine sent an invalid history checkpoint.')
      const s = file.source,
        key = sourceKey(machine.id, s.id)
      const oldCheckpoint = db.prepare('SELECT checkpoint FROM sources WHERE id=?').get(key)?.checkpoint
      const checkpoint = commitCheckpoint
        ? JSON.stringify(file.checkpoint)
        : file.reset
          ? null
          : (oldCheckpoint ?? null)
      const session = hash(`${machine.id}\0${s.tool}\0${s.home}\0${s.nativeId}`)
      db.prepare(
        `INSERT INTO sources(id,machine,machine_id,session_id,tool,native_id,title,cwd,source,checkpoint,outpost_session,forked_from)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        machine=excluded.machine,title=excluded.title,cwd=excluded.cwd,source=excluded.source,
        checkpoint=excluded.checkpoint,session_id=excluded.session_id,native_id=excluded.native_id,
        outpost_session=excluded.outpost_session,forked_from=excluded.forked_from`,
      ).run(
        key,
        JSON.stringify(machine),
        machine.id,
        session,
        s.tool,
        s.nativeId,
        s.title,
        s.cwd,
        JSON.stringify(s),
        checkpoint,
        s.managedSessionId ?? null,
        s.forkedFrom ?? null,
      )
      if (file.reset) db.prepare('DELETE FROM messages WHERE source_id=?').run(key)
      if (!file.messages.length) continue
      let firstMessage = !db.prepare('SELECT 1 FROM messages WHERE source_id=? LIMIT 1').get(key)
      let firstUser = !db.prepare("SELECT 1 FROM messages WHERE source_id=? AND role='user' LIMIT 1").get(key)
      for (const m of file.messages) {
        if (!validMessage(m)) throw new Error('The machine sent an invalid history message.')
        const timestamp =
          m.timestamp && !Number.isNaN(Date.parse(m.timestamp)) ? new Date(m.timestamp).toISOString() : null
        const document = upsertDocument(db, m.text)
        const changes = Number(
          db
            .prepare(
              `INSERT OR IGNORE INTO messages(source_id,generation,position,identity,document_id,role,kind,timestamp,turn_id,truncated,source_chars,source_hash)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              key,
              file.checkpoint.generation,
              m.position,
              m.identity,
              document,
              m.role,
              m.kind,
              timestamp,
              m.turnId,
              m.truncated ? 1 : 0,
              m.totalChars,
              m.contentHash,
            ).changes,
        )
        if (!changes) continue
        inserted += changes
        if (firstMessage || (m.role === 'user' && firstUser))
          db.prepare(
            `UPDATE machine_chunks SET priority=1 WHERE machine_id=? AND chunk_id=(
              SELECT chunk_id FROM document_chunks WHERE document_id=? AND position=0)`,
          ).run(machine.id, document)
        firstMessage = false
        if (m.role === 'user') firstUser = false
      }
    }
    relinkSources(
      db,
      batch.files.map(file => sourceKey(machine.id, file.source.id)),
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return inserted
}
