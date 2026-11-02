/**
 * The extraction pipeline on the core store.
 *
 * These tests exist because the empty-result path is the one that actually
 * failed in the field: a window with enough characters but no durable facts made
 * `remember()` return early, and the pipeline mapped over an `applied` that was
 * never set — a TypeError recorded as "extraction failed" for a window that had
 * simply nothing to store.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CoreStore } from '../lib/core/store.js'
import { RuleExtractor } from '../lib/core/extract.js'
import { LocalEmbedder } from '../lib/core/embed.js'
import { runCoreExtraction, buildPipeline } from '../lib/core/pipeline.js'

function openStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'memvault-pipeline-'))
  const store = new CoreStore(join(dir, 'memvault.db'))
  t.after(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('a window with no facts is a no-op, not a failure', async (t) => {
  const store = openStore(t)
  const result = await runCoreExtraction({
    store,
    extractor: new RuleExtractor(),
    scope: { userId: 'u1' },
    messages: [{ role: 'user', content: '今天天气怎么样？' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.added, 0)
  assert.deepEqual(result.produced, [])
  assert.equal(store.stats().memories, 0)
})

test('a fact is written, embedded and reported with its id', async (t) => {
  const store = openStore(t)
  const result = await runCoreExtraction({
    store,
    extractor: new RuleExtractor(),
    embedder: new LocalEmbedder(384),
    scope: { userId: 'u1', agentId: 'a1' },
    messages: [{ role: 'user', content: '我住在南京，周末常去爬山。' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  assert.equal(result.produced.length, 1)
  assert.match(result.produced[0].id, /^mem_/)
  const stats = store.stats()
  assert.equal(stats.memories, 1)
  assert.equal(stats.embeddings, 1)
})

test('buildPipeline forces the rule extractor offline', () => {
  const pipeline = buildPipeline({ env: { MEMVAULT_EXTRACTOR: 'rule', OPENAI_API_KEY: 'sk-x' } })
  assert.equal(pipeline.usesModel, false)
  assert.ok(pipeline.extractor instanceof RuleExtractor)
})
