/**
 * Importers for the new store (M0).
 *
 * Every source is a local file; nothing is fetched. The mapping rule is the same
 * one the Python importers used, with one addition that the new schema allows:
 * memories keep their provenance (`origin` + `source_ref`) and their original
 * timestamps, so an import is auditable and "when was this learned" survives the
 * move.
 *
 * Idempotency: a source id is preserved when it has one; otherwise the id is
 * derived from scope + text, so importing the same file twice skips rather than
 * duplicates. Old history rows are replayed as `import` events (the schema's
 * action enum has no place for the engine's internal add/update distinction).
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Deterministic id for sources that carry none. */
export function stableId(scopeKey, text) {
  const digest = createHash('sha1').update(`${scopeKey}\u0000${text}`).digest('hex')
  return `mem_${digest.slice(0, 12)}`
}

function scopeKeyOf(scope = {}) {
  return `${scope.userId ?? ''}|${scope.agentId ?? ''}|${scope.runId ?? ''}`
}

function importRecords(store, records, origin) {
  let added = 0
  let skipped = 0
  for (const record of records) {
    const id = record.id || stableId(scopeKeyOf(record), record.text)
    if (store.getMemory(id)) {
      skipped += 1
      continue
    }
    store.addMemory({ ...record, id, origin, actor: origin })
    added += 1
  }
  return { added, skipped }
}

// ── memvault-export (the old store's JSON) ─────────────────────────────────

/**
 * Import a `memvault-export` v1 payload into the new store.
 *
 * Memories keep their ids and scopes; blocks keep their keys; relations keep
 * their weight (the old store had a single relation kind, so they become
 * `related`); history rows become `import` events rather than being dropped.
 */
export function importMemvaultExport(store, payload, { origin = 'import:memvault-export' } = {}) {
  if (!payload || payload.format !== 'memvault-export') {
    throw new Error('not a memvault-export payload')
  }
  const report = {
    added: 0, skipped: 0, blocks: 0, relations: 0, history: 0,
    withVectors: Boolean(payload.counts?.with_vectors),
  }

  const records = (payload.memories || []).map((row) => ({
    id: row.id,
    userId: row.user_id ?? null,
    agentId: row.agent_id ?? null,
    runId: row.run_id ?? null,
    text: row.memory,
    type: row.memory_type ?? 'user',
    metadata: row.metadata ?? {},
    sourceRef: row.metadata?.source_ref ?? null,
    confidence: 1.0,
    createdAt: row.created_at ?? null,
  }))
  const memories = importRecords(store, records, origin)
  report.added = memories.added
  report.skipped = memories.skipped

  for (const block of payload.blocks || []) {
    store.setBlock({
      scopeType: block.scope_type,
      scopeId: block.scope_id,
      label: block.label,
      value: block.value,
      valueLimit: block.value_limit ?? 2000,
      createdAt: block.created_at ?? null,
    })
    report.blocks += 1
  }

  for (const relation of payload.relations || []) {
    store.addRelation(relation.source_id, relation.target_id, 'related', relation.weight ?? 0)
    report.relations += 1
  }

  for (const event of payload.history || []) {
    store.recordHistory({
      memoryId: event.memory_id,
      action: 'import',
      oldText: event.old_memory ?? null,
      newText: event.new_memory ?? null,
      actor: origin,
      at: event.changed_at ?? null,
    })
    report.history += 1
  }

  return report
}

// ── MCP memory JSONL ───────────────────────────────────────────────────────

export function readMcpMemory(text) {
  const records = []
  let relations = 0
  const entities = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let item
    try {
      item = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (item?.type === 'entity') {
      const name = String(item.name ?? '').trim()
      if (name) entities.add(name)
      for (const observation of item.observations || []) {
        const body = String(observation ?? '').trim()
        if (body) {
          records.push({
            text: body,
            type: 'user',
            metadata: { source: 'mcp-memory', entity: name, entityType: String(item.entityType ?? '') },
            sourceRef: `entity:${name}`,
          })
        }
      }
    } else if (item?.type === 'relation') {
      relations += 1
    }
  }
  return { records, stats: { entities: entities.size, relations } }
}

export function importMcpMemory(store, text, scope = {}, { origin = 'import:mcp-memory' } = {}) {
  const { records, stats } = readMcpMemory(text)
  const withScope = records.map((record) => ({ ...record, ...scope }))
  return { ...importRecords(store, withScope, origin), stats }
}

// ── Basic Memory Markdown ─────────────────────────────────────────────────

function splitFrontmatter(text) {
  if (!text.startsWith('---')) return [{}, text]
  const end = text.indexOf('\n---', 3)
  if (end === -1) return [{}, text]
  const raw = text.slice(3, end).trim()
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const meta = {}
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index === -1) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    } else {
      value = value.replace(/^['"]|['"]$/g, '')
    }
    meta[key] = value
  }
  return [meta, body]
}

function markdownFiles(path) {
  if (statSync(path).isFile()) return path.endsWith('.md') ? [path] : []
  const out = []
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) out.push(...markdownFiles(child))
    else if (entry.name.endsWith('.md')) out.push(child)
  }
  return out.sort()
}

export function readBasicMemory(path) {
  const records = []
  let notes = 0
  let withoutObservations = 0
  for (const file of markdownFiles(path)) {
    const [meta, body] = splitFrontmatter(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    notes += 1
    const observations = []
    let inSection = false
    for (const line of body.split(/\r?\n/)) {
      if (/^##\s+Observations\s*$/i.test(line)) {
        inSection = true
        continue
      }
      if (inSection && line.startsWith('## ')) inSection = false
      if (inSection && line.trimStart().startsWith('- ')) observations.push(line.trimStart().slice(2).trim())
    }
    if (!observations.length) {
      withoutObservations += 1
      continue
    }
    const title = String(meta.title || file.split(/[\\/]/).pop().replace(/\.md$/, ''))
    for (const observation of observations) {
      const match = observation.match(/^\[([^\]]+)\]\s*(.*)$/)
      records.push({
        text: match ? match[2].trim() : observation,
        type: 'user',
        metadata: {
          source: 'basic-memory',
          note: title,
          category: match ? match[1].trim() : '',
          tags: meta.tags || [],
          permalink: meta.permalink || '',
          path: file,
        },
        sourceRef: `note:${title}`,
      })
    }
  }
  return { records, stats: { notes, notes_without_observations: withoutObservations } }
}

export function importBasicMemory(store, path, scope = {}, { origin = 'import:basic-memory' } = {}) {
  const { records, stats } = readBasicMemory(path)
  const withScope = records.map((record) => ({ ...record, ...scope }))
  return { ...importRecords(store, withScope, origin), stats }
}

// ── Mem0 ──────────────────────────────────────────────────────────────────

export function readMem0(payload) {
  const items = Array.isArray(payload) ? payload
    : (payload?.results || payload?.memories || payload?.items || [])
  const records = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const text = String(item.memory ?? item.text ?? item.content ?? '').trim()
    if (!text) continue
    const metadata = (item.metadata && typeof item.metadata === 'object') ? item.metadata : {}
    records.push({
      text,
      type: metadata.type ?? 'user',
      metadata: { ...metadata, source: 'mem0' },
      sourceRef: item.id ? String(item.id) : null,
      createdAt: item.created_at ?? null,
    })
  }
  return { records, stats: { items: items.length } }
}

export function importMem0(store, payload, scope = {}, { origin = 'import:mem0' } = {}) {
  const { records, stats } = readMem0(payload)
  const withScope = records.map((record) => ({ ...record, ...scope }))
  return { ...importRecords(store, withScope, origin), stats }
}
