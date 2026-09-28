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
