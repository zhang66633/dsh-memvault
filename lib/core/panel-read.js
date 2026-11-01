/**
 * Panel reads on the in-plugin store.
 *
 * The shapes are the ones the panel already renders (`readMemories` /
 * `readMemoryProvenance` / `countRetyped`), and the SQL differs only where the
 * schema does: the memory text column is `text`, and history keeps
 * `old_text`/`new_text`/`at`. Everything else — filters, placeholders, clamps —
 * is the same contract the old module guaranteed, which is why the row shaping
 * is imported instead of reimplemented.
 */
import { DatabaseSync } from 'node:sqlite'

import {
  DEFAULT_LIMIT,
  HISTORY_TEXT_CLAMP,
  MAX_HISTORY,
  MAX_IDS,
  MAX_LIMIT,
  MAX_RELATIONS,
  MEMORY_ORDERS,
  PRODUCED_VIEW_CLAMP,
  shapeMemoryRow,
} from '../memories.js'

/** Column list with the one alias the shaping helper expects. */
const CORE_COLUMNS = 'id, user_id, agent_id, run_id, text AS memory, memory_type, metadata, created_at, updated_at'

const clampText = (value, max) => {
  if (typeof value !== 'string') return null
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Same filters as the old builder, over the core schema. */
export function buildCoreMemoryQuery(query = {}) {
  const where = []
  const args = []

  const text = typeof query.q === 'string' ? query.q.trim() : ''
  if (text !== '') {
    const escaped = text.replace(/[\\%_]/g, (char) => `\\${char}`)
    where.push("text LIKE ? ESCAPE '\\'")
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

  const ids = typeof query.ids === 'string'
    ? query.ids.split(',').map((id) => id.trim()).filter((id) => id !== '').slice(0, MAX_IDS)
    : []
  if (ids.length > 0) {
    where.push(`id IN (${ids.map(() => '?').join(', ')})`)
    args.push(...ids)
  }

  const retyped = query.retyped === '1' || query.retyped === 'true' || query.retyped === true
  if (retyped) where.push(`metadata LIKE '%"retyped_from"%'`)

  const rawLimit = Number(query.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(MAX_LIMIT, Math.floor(rawLimit))
    : DEFAULT_LIMIT
  const rawOffset = Number(query.offset)
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  const order = Object.hasOwn(MEMORY_ORDERS, query.order) ? query.order : 'created'
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''

  return {
    sql: `SELECT ${CORE_COLUMNS} FROM memories${clause} ORDER BY ${MEMORY_ORDERS[order]} DESC, id DESC LIMIT ? OFFSET ?`,
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

/** One read-only connection per call, same as the old module. */
function open(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true, timeout: 2000 })
}

export function readMemories({ dbPath, query = {} } = {}) {
  const built = buildCoreMemoryQuery(query)
  const db = open(dbPath)
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
      mode: 'substring',
    }
  } finally {
    db.close()
  }
}

export function readMemoryProvenance({ dbPath, id } = {}) {
  const wanted = typeof id === 'string' ? id.trim() : ''
  if (wanted === '') return { memory: null, history: [], relations: [], missing: true }

  const db = open(dbPath)
  try {
    const row = db.prepare(`SELECT ${CORE_COLUMNS} FROM memories WHERE id = ?`).get(wanted)
    if (row === undefined) return { memory: null, history: [], relations: [], missing: true }

    const history = db.prepare(
      'SELECT action, old_text, new_text, at FROM history WHERE memory_id = ? ORDER BY id',
    ).all(wanted).slice(-MAX_HISTORY).map((entry) => ({
      action: entry.action ?? null,
      old: clampText(entry.old_text, HISTORY_TEXT_CLAMP),
      new: clampText(entry.new_text, HISTORY_TEXT_CLAMP),
      at: entry.at ?? null,
    }))

    const links = db.prepare(
      'SELECT source_id, target_id, weight FROM relations WHERE source_id = ? OR target_id = ? LIMIT ?',
    ).all(wanted, wanted, MAX_RELATIONS)
    const otherIds = [...new Set(links.map((link) => (link.source_id === wanted ? link.target_id : link.source_id)))]
    const others = otherIds.length === 0 ? [] : db.prepare(
      `SELECT ${CORE_COLUMNS} FROM memories WHERE id IN (${otherIds.map(() => '?').join(', ')})`,
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
        alive: other !== undefined,
        text: other ? clampText(other.memory, PRODUCED_VIEW_CLAMP) : null,
      }
    })

    return { memory: shapeMemoryRow(row), history, relations, missing: false }
  } finally {
    db.close()
  }
}

export function countRetyped({ dbPath } = {}) {
  try {
    const db = open(dbPath)
    try {
      return db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE metadata LIKE '%"retyped_from"%'`).get()?.n ?? 0
    } finally {
      db.close()
    }
  } catch {
    return 0
  }
}
