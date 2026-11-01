/**
 * M0 acceptance: the in-plugin store and its importers.
 *
 * The bar from the design doc is "export -> import -> same rows and content",
 * so the tests exercise the real JSON shape the Python export writes, not a
 * hand-shaped stub, and they assert the properties the new schema exists for
 * (supersede keeps history, ids and timestamps survive an import).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CoreStore } from '../lib/core/store.js'
import {
  importBasicMemory,
  importMcpMemory,
  importMem0,
  importMemvaultExport,
} from '../lib/core/importers.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-core-'))
  const store = new CoreStore(join(dir, 'memvault.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('addMemory stores a scoped memory and rejects an unscoped one', (t) => {
  const store = openStore(t)
  const memory = store.addMemory({ userId: 'u1', text: '用户偏好中文回答。', type: 'user' })
  assert.equal(memory.text, '用户偏好中文回答。')
  assert.deepEqual(memory.metadata, {})
  assert.equal(store.currentMemories({ userId: 'u1' }).length, 1)
  assert.throws(() => store.addMemory({ text: '没有作用域' }), /scope/)
})

test('supersede keeps the old row and links it to the new version', (t) => {
  const store = openStore(t)
  const first = store.addMemory({ userId: 'u1', text: '用户的编辑器是 VS Code。' })
  const second = store.supersede(first.id, { text: '用户现在主要用 Neovim。', actor: 'extract' })
  assert.equal(store.getMemory(first.id).supersededBy, second.id)
  assert.deepEqual(store.currentMemories({ userId: 'u1' }).map((m) => m.id), [second.id])
  assert.deepEqual(store.history(first.id).map((row) => row.action), ['add', 'supersede'])
})

test('blocks, relations and flags round-trip', (t) => {
  const store = openStore(t)
  const a = store.addMemory({ userId: 'u1', text: 'A 事实' })
  const b = store.addMemory({ userId: 'u1', text: 'B 事实' })
  store.addRelation(a.id, b.id, 'similar', 0.8)
  store.setFlag(b.id, 'needs_review')
  store.setBlock({ scopeType: 'user', scopeId: 'u1', label: 'persona', value: '直接给结论' })
  assert.equal(store.getBlocks('user', 'u1')[0].value, '直接给结论')
  assert.equal(store.relationsOf(a.id).length, 1)
  assert.equal(store.flags()[0].reason, 'needs_review')
})

test('the FTS index matches a Chinese substring', (t) => {
  const store = openStore(t)
  store.addMemory({ userId: 'u1', text: '用户在 SJS 项目里用 Postgres 存违规事件。' })
  const hits = store.db
    .prepare('SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH ?')
    .get('违规事件').n
  assert.equal(hits, 1)
})

test('memvault-export import preserves ids, timestamps and provenance', (t) => {
  const store = openStore(t)
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'export-sample.json'), 'utf8'))
  const report = importMemvaultExport(store, payload)
  assert.deepEqual(report, {
    added: 3, skipped: 0, blocks: 1, relations: 1, history: 2, withVectors: false,
  })

  const memory = store.getMemory('mem_aaaa1111')
  assert.equal(memory.createdAt, '2026-09-01T10:00:00+00:00')
  assert.equal(memory.origin, 'import:memvault-export')
  assert.equal(memory.metadata.source, 'extract')
  assert.equal(store.getBlocks('user', 'u1')[0].label, 'persona')
  assert.equal(store.history('mem_aaaa1111').length, 3) // add + two import events

  const again = importMemvaultExport(store, payload)
  assert.equal(again.added, 0)
  assert.equal(again.skipped, 3)
})

test('mcp-memory import turns observations into memories', (t) => {
  const store = openStore(t)
  const text = readFileSync(join(FIXTURES, 'mcp-memory.jsonl'), 'utf8')
  const report = importMcpMemory(store, text, { userId: 'u1' })
  assert.equal(report.added, 3)
  assert.deepEqual(report.stats, { entities: 2, relations: 1 })
  const memories = store.currentMemories({ userId: 'u1' })
  assert.ok(memories.every((memory) => typeof memory.metadata.entity === 'string'))
})

test('basic-memory import reads observations with their note metadata', (t) => {
  const store = openStore(t)
  const report = importBasicMemory(store, join(FIXTURES, 'basic-memory'), { userId: 'u1' })
  assert.equal(report.added, 2)
  assert.deepEqual(report.stats, { notes: 1, notes_without_observations: 0 })

  const memory = store.currentMemories({ userId: 'u1' })
    .find((row) => row.text.startsWith('Using JWT'))
  assert.equal(memory.metadata.note, 'Auth Design')
  assert.equal(memory.metadata.category, 'decision')
})

test('mem0 import reads results and keeps created_at', (t) => {
  const store = openStore(t)
  const payload = JSON.parse(readFileSync(join(FIXTURES, 'mem0.json'), 'utf8'))
  const report = importMem0(store, payload, { userId: 'u1' })
  assert.equal(report.added, 1)
  const memory = store.currentMemories({ userId: 'u1' })[0]
  assert.equal(memory.createdAt, '2026-01-01T00:00:00Z')
  assert.equal(memory.origin, 'import:mem0')
})

test('re-importing an external source skips duplicates', (t) => {
  const store = openStore(t)
  const text = readFileSync(join(FIXTURES, 'mcp-memory.jsonl'), 'utf8')
  importMcpMemory(store, text, { userId: 'u1' })
  const second = importMcpMemory(store, text, { userId: 'u1' })
  assert.equal(second.added, 0)
  assert.equal(second.skipped, 3)
})
