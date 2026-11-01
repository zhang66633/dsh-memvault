/**
 * The in-plugin memory store (M0 of the JS core).
 *
 * Owns one SQLite file via `node:sqlite`; no Python, no service. The API is the
 * small surface the importers need now and the extraction/retrieval path will
 * use later: memories (with supersede), blocks, relations, history, flags.
 *
 * Two decisions carried over from the design doc:
 *
 * - **Writes never update a memory's text in place.** `supersede()` inserts the
 *   new version and points the old row at it, so "what did we believe in
 *   March?" stays answerable and the audit trail is not a reconstruction.
 * - **Scopes are enforced by the store**, not by callers: a row with no
 *   user/agent/run is rejected by the schema's CHECK as well as here, because a
 *   memory that belongs to nothing is unfindable later.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

import { DDL, SCHEMA_VERSION } from './schema.js'

export const MEMORY_TYPES = ['user', 'agent', 'procedural']

/** The store's clock, injectable so tests are deterministic. */
export function nowIso() {
  return new Date().toISOString()
}

/** `mem_` + 12 hex characters, the same shape the Python engine used. */
export function newMemoryId() {
  return `mem_${randomBytes(6).toString('hex')}`
}

function parseMetadata(value) {
  if (typeof value !== 'string') return value ?? {}
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

/** Raw row -> the API shape (camelCase, metadata parsed). */
export function toMemory(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    runId: row.run_id,
    text: row.text,
    type: row.memory_type,
    metadata: parseMetadata(row.metadata),
    origin: row.origin,
    sourceRef: row.source_ref,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validFrom: row.valid_from,
    supersededBy: row.superseded_by,
  }
}

export class CoreStore {
  constructor(path = ':memory:', { now = nowIso } = {}) {
    this.path = path
    this.now = now
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(DDL)
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION))
    this.closed = false
  }

  close() {
    if (!this.closed) {
      this.db.close()
      this.closed = true
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // A failed rollback must not hide the original error.
      }
      throw err
    }
  }

  // ── memories ─────────────────────────────────────────────────────────────

  addMemory({
    id = null,
    userId = null,
    agentId = null,
    runId = null,
    text,
    type = 'user',
    metadata = {},
    origin = 'manual',
    sourceRef = null,
    confidence = 1.0,
    createdAt = null,
    actor = null,
  } = {}) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('memory text is required')
    if (!userId && !agentId && !runId) throw new Error('at least one scope id is required')
    if (!MEMORY_TYPES.includes(type)) throw new Error(`unknown memory type: ${type}`)
    const at = createdAt || this.now()
    const memoryId = id || newMemoryId()
    this.db.prepare(`
      INSERT INTO memories
        (id, user_id, agent_id, run_id, text, memory_type, metadata, origin,
         source_ref, confidence, created_at, updated_at, valid_from, superseded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    `).run(
      memoryId, userId, agentId, runId, body, type,
      JSON.stringify(metadata ?? {}), origin, sourceRef, confidence,
      at, at, at,
    )
    this.db.prepare(`
      INSERT INTO history (memory_id, action, old_text, new_text, actor, at)
      VALUES (?, 'add', NULL, ?, ?, ?)
    `).run(memoryId, body, actor || origin, at)
    return this.getMemory(memoryId)
  }

  getMemory(id) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)
    return toMemory(row)
  }

  /** Current (not superseded) memories, optionally narrowed by scope. */
  currentMemories({ userId = null, agentId = null, runId = null, limit = 100 } = {}) {
    const where = ['superseded_by IS NULL']
    const params = []
    for (const [column, value] of [['user_id', userId], ['agent_id', agentId], ['run_id', runId]]) {
      if (value != null) {
        where.push(`${column} = ?`)
        params.push(value)
      }
    }
    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(...params, limit)
    return rows.map(toMemory)
  }

  /**
   * Replace a memory with a new version.
   *
   * The old row is kept (and still reachable by id); only `superseded_by` links
   * it to the new one, so retrieval defaults to the current view without
   * destroying history.
   */
  supersede(oldId, input = {}) {
    const old = this.getMemory(oldId)
    if (!old) throw new Error(`no such memory: ${oldId}`)
    const at = this.now()
    return this.transaction(() => {
      const created = this.addMemory({
        userId: input.userId ?? old.userId,
        agentId: input.agentId ?? old.agentId,
        runId: input.runId ?? old.runId,
        text: input.text,
        type: input.type ?? old.type,
        metadata: input.metadata ?? old.metadata,
        origin: input.origin ?? old.origin,
        sourceRef: input.sourceRef ?? old.sourceRef,
        confidence: input.confidence ?? old.confidence,
        actor: input.actor ?? 'system',
      })
      this.db.prepare('UPDATE memories SET superseded_by = ?, updated_at = ? WHERE id = ?')
        .run(created.id, at, oldId)
      this.db.prepare(`
        INSERT INTO history (memory_id, action, old_text, new_text, actor, at)
        VALUES (?, 'supersede', ?, ?, ?, ?)
      `).run(oldId, old.text, created.text, input.actor ?? 'system', at)
      return created
    })
  }

  deleteMemory(id) {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  // ── blocks ───────────────────────────────────────────────────────────────

  setBlock({ scopeType, scopeId, label, value, valueLimit = 2000, createdAt = null } = {}) {
    if (!['user', 'agent'].includes(scopeType)) throw new Error(`unknown scope type: ${scopeType}`)
    const at = this.now()
    this.db.prepare(`
      INSERT INTO blocks (scope_type, scope_id, label, value, value_limit, position, created_at, updated_at)
      VALUES (?,?,?,?,?,0,?,?)
      ON CONFLICT(scope_type, scope_id, label) DO UPDATE SET
        value = excluded.value,
        value_limit = excluded.value_limit,
        updated_at = excluded.updated_at
    `).run(scopeType, scopeId, label, String(value), valueLimit, createdAt || at, at)
    return this.db.prepare(
      'SELECT * FROM blocks WHERE scope_type = ? AND scope_id = ? AND label = ?',
    ).get(scopeType, scopeId, label)
  }

  getBlocks(scopeType, scopeId) {
    return this.db.prepare(`
      SELECT * FROM blocks WHERE scope_type = ? AND scope_id = ?
      ORDER BY position, label
    `).all(scopeType, scopeId)
  }

  // ── relations & history & flags ──────────────────────────────────────────

  addRelation(sourceId, targetId, kind = 'related', weight = 0) {
    this.db.prepare(`
      INSERT OR IGNORE INTO relations (source_id, target_id, kind, weight, created_at)
      VALUES (?,?,?,?,?)
    `).run(sourceId, targetId, kind, weight, this.now())
  }

  relationsOf(memoryId) {
    return this.db.prepare(`
      SELECT * FROM relations WHERE source_id = ? OR target_id = ? ORDER BY id
    `).all(memoryId, memoryId)
  }

  history(memoryId) {
    return this.db.prepare('SELECT * FROM history WHERE memory_id = ? ORDER BY id').all(memoryId)
  }

  /** Append an audit row; importers replay old history as `import` events. */
  recordHistory({ memoryId, action = 'import', oldText = null, newText = null, actor = 'system', at = null } = {}) {
    this.db.prepare(`
      INSERT INTO history (memory_id, action, old_text, new_text, actor, at)
      VALUES (?,?,?,?,?,?)
    `).run(memoryId, action, oldText, newText, actor, at || this.now())
  }

  setFlag(memoryId, reason, status = 'open') {
    this.db.prepare(`
      INSERT INTO flags (memory_id, reason, status, created_at) VALUES (?,?,?,?)
      ON CONFLICT(memory_id, reason) DO UPDATE SET status = excluded.status
    `).run(memoryId, reason, status, this.now())
  }

  flags() {
    return this.db.prepare('SELECT * FROM flags ORDER BY created_at DESC').all()
  }

  stats() {
    const count = (table) => this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    return {
      memories: count('memories'),
      current: this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE superseded_by IS NULL').get().n,
      embeddings: count('memory_embeddings'),
      blocks: count('blocks'),
      relations: count('relations'),
      history: count('history'),
      flags: count('flags'),
    }
  }
}
