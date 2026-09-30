/**
 * Browse the stored memories — the panel's second view, read-only.
 *
 * Two decisions worth stating:
 *
 * **Plain SQL, not semantic recall.** The panel's job is "show me what is in the
 * store and let me find a string in it". Semantic ranking needs the embedder (and
 * for `memory_search`'s hybrid mode, the keyword index too), which is the model's
 * tool — running it here would make a panel poll as expensive as a retrieval.
 * A substring match over `memory` is honest about being a browse: there is no
 * index on that column, so it is a scan, which is exactly why the result set is
 * bounded and says so.
 *
 * **Never `SELECT *`.** `memories.embedding` is a blob per row; MemVault's own
 * maintenance paths use an explicit column list for this reason
 * (`storage.iter_memory_meta`). Selecting the columns we display keeps a browse
 * cheap regardless of how many rows exist.
 */
import { DatabaseSync } from 'node:sqlite'

/** Columns a browse reads — everything shown, and nothing that is a blob. */
export const MEMORY_COLUMNS = 'id, user_id, agent_id, run_id, memory, memory_type, metadata, created_at, updated_at'

/** Memory kinds MemVault writes. */
export const MEMORY_TYPES = ['user', 'agent', 'procedural']

/** Sort orders, mapped to a column so the value is never interpolated. */
export const MEMORY_ORDERS = { created: 'created_at', updated: 'updated_at' }

/** Browse page size: the default, and the hard cap a request cannot exceed. */
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 200

/** Longest memory text shipped to the browser; the true length travels as `chars`. */
export const MEMORY_TEXT_CLAMP = 4000

/** Longest metadata blob shipped; metadata is free-form and can be large. */
export const METADATA_CLAMP = 1000

/** Most ids one `?ids=` filter may carry. */
export const MAX_IDS = 200

/** Most history entries and relations shipped for one memory. */
export const MAX_HISTORY = 50
export const MAX_RELATIONS = 50

/** Longest old/new text shipped per history entry. */
export const HISTORY_TEXT_CLAMP = 1000

/**
 * Build the read-only query for a browse request.
 *
 * Every value goes through a placeholder; only `order` selects a column, and it
 * selects it from {@link MEMORY_ORDERS}. A hostile `q` is just a string.
 *
 * @param query - raw query values (`q`, `type`, `user`, `agent`, `run`, `limit`, `offset`, `order`).
 * @returns `{ sql, countSql, args, countArgs, limit, offset, order, applied }` — `applied`
 *   echoes what was actually used, because a browse quietly ignoring a filter is
 *   worse than one that reports it.
 */
export function buildMemoryQuery(query = {}) {
  const where = []
  const args = []

  const text = typeof query.q === 'string' ? query.q.trim() : ''
  if (text !== '') {
    // `%` and `_` are LIKE wildcards; a search for "50%" must not match everything.
    const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`)
    where.push("memory LIKE ? ESCAPE '\\'")
    args.push(`%${escaped}%`)
  }

  const type = typeof query.type === 'string' ? query.type.trim() : ''
  if (type !== '') {
    where.push('memory_type = ?')
    args.push(type)
  }

  for (const key of ['user', 'agent', 'run']) {
    const value = typeof query[key] === 'string' ? query[key].trim() : ''
    if (value === '') continue
    where.push(`${key}_id = ?`)
    args.push(value)
  }

  // An explicit id list: how a diagnostic's "these are the memories this window
  // produced" turns back into rows. Ids are values, so they are placeholders too.
  const ids = typeof query.ids === 'string'
    ? query.ids.split(',').map((id) => id.trim()).filter((id) => id !== '').slice(0, MAX_IDS)
    : []
  if (ids.length > 0) {
    where.push(`id IN (${ids.map(() => '?').join(', ')})`)
    args.push(...ids)
  }

  // Rows the store's own type refinement moved out of `user` (metadata carries
  // `retyped_from`). Surfacing them is the point: a heuristic that silently
  // reclassifies a row is indistinguishable from one that got it wrong, so the
  // panel has to be able to list exactly those rows and let a human judge.
  const retyped = query.retyped === '1' || query.retyped === 'true' || query.retyped === true
  if (retyped) {
    where.push(`metadata LIKE '%"retyped_from"%'`)
  }

  const rawLimit = Number(query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIMIT, Math.floor(rawLimit))
    : DEFAULT_LIMIT
  const rawOffset = Number(query.offset)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  const order = Object.hasOwn(MEMORY_ORDERS, query.order) ? query.order : 'created'
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

  return {
    sql: `SELECT ${MEMORY_COLUMNS} FROM memories${clause} ORDER BY ${MEMORY_ORDERS[order]} DESC, id DESC LIMIT ? OFFSET ?`,
    countSql: `SELECT COUNT(*) AS n FROM memories${clause}`,
    args: [...args, limit, offset],
    countArgs: args,
    limit,
    offset,
    order,
    applied: {
      q: text,
      type: type === '' ? null : type,
      user: typeof query.user === 'string' && query.user.trim() !== '' ? query.user.trim() : null,
      agent: typeof query.agent === 'string' && query.agent.trim() !== '' ? query.agent.trim() : null,
      run: typeof query.run === 'string' && query.run.trim() !== '' ? query.run.trim() : null,
      ids,
      retyped,
    },
  }
}

const parseMetadata = (raw) => {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const text = JSON.stringify(parsed)
    return text.length > METADATA_CLAMP ? JSON.parse(JSON.stringify({ truncated: text.slice(0, METADATA_CLAMP) })) : parsed
  } catch {
    return null
  }
}

/** Shape one row for the panel: display fields only, long values clamped. */
export function shapeMemoryRow(row) {
  const text = typeof row.memory === 'string' ? row.memory : ''
  return {
    id: row.id,
    memory: text.length > MEMORY_TEXT_CLAMP ? `${text.slice(0, MEMORY_TEXT_CLAMP)}…` : text,
    chars: text.length,
    type: row.memory_type ?? null,
    user: row.user_id ?? null,
    agent: row.agent_id ?? null,
    run: row.run_id ?? null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

/**
 * Read one memory's provenance: the row, every decision recorded about it, and
 * the contradictions it takes part in.
 *
 * MemVault audits every ADD/UPDATE/DELETE in `history` (with the old and new
 * text) and records contradictions as `relations`. That is what answers "how did
 * this memory become what it is" — the question a quality judgement actually needs
 * — and it is all read-only.
 *
 * @returns `{ memory, history, relations, missing }`; `missing: true` when the id
 *   is unknown (a flagged memory can be deleted later, and that must not 500).
 */
export function readMemoryProvenance({ dbPath, id } = {}) {
  const wanted = typeof id === 'string' ? id.trim() : ''
  if (wanted === '') return { memory: null, history: [], relations: [], missing: true }

  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
  try {
    const row = db.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(wanted)
    if (row === undefined) return { memory: null, history: [], relations: [], missing: true }

    const history = db.prepare(
      'SELECT action, old_memory, new_memory, changed_at FROM history WHERE memory_id = ? ORDER BY id',
    ).all(wanted).slice(-MAX_HISTORY).map((entry) => ({
      action: entry.action ?? null,
      old: clampText(entry.old_memory, HISTORY_TEXT_CLAMP),
      new: clampText(entry.new_memory, HISTORY_TEXT_CLAMP),
      at: entry.changed_at ?? null,
    }))

    const links = db.prepare(
      'SELECT source_id, target_id, weight FROM relations WHERE source_id = ? OR target_id = ? LIMIT ?',
    ).all(wanted, wanted, MAX_RELATIONS)
    const otherIds = [...new Set(links.map((link) => (link.source_id === wanted ? link.target_id : link.source_id)))]
    const others = otherIds.length === 0 ? [] : db.prepare(
      `SELECT ${MEMORY_COLUMNS} FROM memories WHERE id IN (${otherIds.map(() => '?').join(', ')})`,
    ).all(...otherIds)
    const byId = new Map(others.map((other) => [other.id, other]))

    const relations = links.map((link) => {
      const outgoing = link.source_id === wanted
      const otherId = outgoing ? link.target_id : link.source_id
      const other = byId.get(otherId)
      return {
        direction: outgoing ? 'out' : 'in',
        id: otherId,
        weight: typeof link.weight === 'number' ? link.weight : null,
        // A relation can outlive the memory it points at (deletes drop the row,
        // not always the edge); say so instead of showing an empty card.
        alive: other !== undefined,
        text: other ? clampText(other.memory, PRODUCED_VIEW_CLAMP) : null,
      }
    })

    return { memory: shapeMemoryRow(row), history, relations, missing: false }
  } finally {
    db.close()
  }
}

/** Text clamp for a related memory shown inside another memory's card. */
export const PRODUCED_VIEW_CLAMP = 400

const clampText = (value, max) => {
  if (typeof value !== 'string') return null
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * Read one page of memories from the store, read-only.
 *
 * Throws when the store is unreadable; the route turns that into a reported
 * error, because a panel that shows a stale list would be worse than one that
 * says it cannot read.
 */
export function readMemories({ dbPath, query = {} } = {}) {
  const built = buildMemoryQuery(query)
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
  try {
    const total = db.prepare(built.countSql).get(...built.countArgs)?.n ?? 0
    const rows = db.prepare(built.sql).all(...built.args)
    return {
      rows: rows.map(shapeMemoryRow),
      total,
      limit: built.limit,
      offset: built.offset,
      order: built.order,
      applied: built.applied,
      // Stated in the payload because the panel says it out loud: this is a
      // substring scan over the text column, not ranked retrieval.
      mode: 'substring',
    }
  } finally {
    db.close()
  }
}

/**
 * How many rows the type refinement moved out of `user`.
 *
 * A separate count because the panel needs the number even when it is not
 * filtering by it — "the heuristic acted N times, here they are" is the whole
 * point of surfacing it. Returns 0 on an unreadable store rather than throwing:
 * the badge is not worth failing a browse over.
 */
export function countRetyped({ dbPath } = {}) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
    try {
      return db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE metadata LIKE '%"retyped_from"%'`).get()?.n ?? 0
    } finally {
      db.close()
    }
  } catch {
    return 0
  }
}
